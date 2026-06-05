// transcripts-command.ts — /forge:transcripts: recall surface over the
// central transcript archive (~/.pi/forge-cli/transcripts/).
//
// Read-only and cross-project: works OUTSIDE any Forge project — the whole
// point is recalling runs from other projects, including deleted ones.
// No config options (opinionated defaults); behavior is shaped by args only.
//
// Subcommands:
//   list [entityId] [--project <key>] [--since <Nd>] [--json]
//   show <runId|entityId> [phase]
//   timeline [--project <key>] [--since <Nd>] [--by model|phase|outcome] [--json]
//   projects
//
// Archetype: Atomic (no LLM in loop — pack-04 §Atomic). Pure formatters are
// exported for unit tests; the handler only assembles data and notifies.

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hydrateRunTree } from "../transcript-replay.js";
import { BrowseTuiComponent } from "../transcripts-tui/index.js";
import { getInputRouter } from "../tui/input-router.js";
import { openDashboardTui } from "../tui/thread-switcher.js";
import {
	digestPhasePayload,
	gunzipPhase,
	readIndex,
	readManifest,
	readProjects,
	runDirForEntry,
} from "../transcript-archive.js";

// Moved to transcript-archive.ts (shared with transcript-replay.ts);
// re-exported here so existing importers/tests keep working.
export { digestPhasePayload };
import type {
	IndexEntry,
	ProjectsRegistry,
	RunManifest,
} from "../transcript-archive-types.js";

// ── Formatting primitives ───────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtCost(n: number): string {
	return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function table(header: string[], rows: string[][]): string[] {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
	const render = (cells: string[]) => `  ${cells.map((c, i) => pad(c, widths[i])).join("  ")}`.trimEnd();
	return [render(header), ...rows.map(render)];
}

// ── list ────────────────────────────────────────────────────────────────

export interface ListRow {
	runId: string;
	projectKey: string;
	projectName: string;
	entityId: string;
	entityKind: string;
	sprintId?: string;
	startedAt: string;
	outcome: string;
	input: number;
	output: number;
	cost: number;
	durationMs?: number;
}

export interface ListFilter {
	entityId?: string;
	project?: string;
	sinceDays?: number;
}

function entryPassesFilter(entry: IndexEntry, filter: ListFilter): boolean {
	if (filter.entityId && entry.entityId !== filter.entityId && entry.sprintId !== filter.entityId) return false;
	if (filter.project && entry.projectKey !== filter.project) return false;
	if (filter.sinceDays !== undefined) {
		const cutoff = new Date(Date.now() - filter.sinceDays * 86_400_000).toISOString();
		if (entry.startedAt < cutoff) return false;
	}
	return true;
}

/**
 * Assemble list rows from the index, refreshed against each run's manifest
 * when readable — the index line is append-only and can be stale for
 * resumed runs (manifest is the source of truth; index is the timeline).
 */
export function collectListRows(filter: ListFilter = {}): ListRow[] {
	const projects = readProjects();
	const rows: ListRow[] = [];
	for (const entry of readIndex()) {
		if (!entryPassesFilter(entry, filter)) continue;
		const manifest = readManifest(runDirForEntry(entry));
		rows.push({
			runId: entry.runId,
			projectKey: entry.projectKey,
			projectName: projects.projects[entry.projectKey]?.name ?? entry.projectKey,
			entityId: entry.entityId,
			entityKind: manifest?.entityKind ?? entry.entityKind,
			...((manifest?.sprintId ?? entry.sprintId) ? { sprintId: manifest?.sprintId ?? entry.sprintId } : {}),
			startedAt: entry.startedAt,
			outcome: manifest?.outcome ?? entry.outcome,
			input: manifest?.totals.input ?? entry.input,
			output: manifest?.totals.output ?? entry.output,
			cost: manifest?.totals.cost ?? entry.cost,
			...((manifest?.durationMs ?? entry.durationMs) !== undefined
				? { durationMs: manifest?.durationMs ?? entry.durationMs }
				: {}),
		});
	}
	rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return rows;
}

export function formatList(rows: ListRow[]): string[] {
	if (rows.length === 0) {
		return ["forge:transcripts — no archived runs match. Runs are archived as pipelines finish (or adopted by the pipeline-start sweep)."];
	}
	const body = rows.map((r) => [
		r.startedAt.slice(0, 16).replace("T", " "),
		r.projectName,
		r.entityId + (r.sprintId ? ` (${r.sprintId})` : ""),
		r.runId,
		r.outcome,
		`${fmtTokens(r.input)}/${fmtTokens(r.output)}`,
		fmtCost(r.cost),
		fmtDuration(r.durationMs),
	]);
	return [
		`${rows.length} archived run${rows.length === 1 ? "" : "s"}:`,
		...table(["started", "project", "entity", "run", "outcome", "in/out", "cost", "time"], body),
	];
}

// ── show ────────────────────────────────────────────────────────────────

export interface ResolvedRun {
	entry: IndexEntry;
	manifest: RunManifest;
	runDir: string;
	/** Other runs that matched an entityId lookup (newest first, incl. this). */
	siblingCount: number;
}

/**
 * Resolve `show` target: exact runId match first, else latest run for the
 * entityId (or sprintId back-reference). Null when nothing matches or the
 * manifest is unreadable.
 */
export function resolveRun(idArg: string): ResolvedRun | null {
	const entries = readIndex();
	let matches = entries.filter((e) => e.runId === idArg);
	if (matches.length === 0) {
		matches = entries.filter((e) => e.entityId === idArg || e.sprintId === idArg);
	}
	if (matches.length === 0) return null;
	matches.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	for (const entry of matches) {
		const runDir = runDirForEntry(entry);
		const manifest = readManifest(runDir);
		if (manifest) return { entry, manifest, runDir, siblingCount: matches.length };
	}
	return null;
}

export function formatShow(manifest: RunManifest, digest?: { role: string; file: string; lines: string[] }): string[] {
	const lines: string[] = [
		`Run ${manifest.runId} — ${manifest.entityId} (${manifest.entityKind}) · ${manifest.projectName} [${manifest.projectKey}]`,
		`Started ${manifest.startedAt} · ${manifest.outcome} · ${fmtDuration(manifest.durationMs)}` +
			(manifest.totals.revisionLoops > 0
				? ` · ${manifest.totals.revisionLoops} revision loop${manifest.totals.revisionLoops === 1 ? "" : "s"}`
				: ""),
	];
	if (manifest.sprintId) lines.push(`Sprint: ${manifest.sprintId}`);
	lines.push(
		`Totals: in ${fmtTokens(manifest.totals.input)} · out ${fmtTokens(manifest.totals.output)} · ` +
			`cache r/w ${fmtTokens(manifest.totals.cacheRead)}/${fmtTokens(manifest.totals.cacheWrite)} · ${fmtCost(manifest.totals.cost)}`,
		"",
		"Phases:",
	);
	const body = manifest.phases.map((p, i) => [
		String(i + 1),
		p.role,
		String(p.attempt),
		p.verdict,
		p.model ?? "—",
		p.usage ? `${fmtTokens(p.usage.input)}/${fmtTokens(p.usage.output)}` : "—",
		fmtDuration(p.elapsedMs),
	]);
	lines.push(...table(["#", "phase", "att", "verdict", "model", "in/out", "time"], body));
	if (digest) {
		lines.push("", `── ${digest.role} digest (${digest.file}) ──`, ...digest.lines);
	}
	return lines;
}

// ── timeline ────────────────────────────────────────────────────────────

export type TimelineBy = "day" | "model" | "phase" | "outcome";

export interface TimelineRow {
	key: string;
	runs: number;
	phases: number;
	input: number;
	output: number;
	cost: number;
}

/**
 * Aggregate archived runs along one dimension. Day/outcome come from the
 * (manifest-refreshed) list rows; model/phase need the per-run manifests.
 */
export function collectTimeline(filter: ListFilter, by: TimelineBy): TimelineRow[] {
	const buckets = new Map<string, TimelineRow>();
	const bump = (key: string, d: { runs?: number; phases?: number; input: number; output: number; cost: number }) => {
		const row = buckets.get(key) ?? { key, runs: 0, phases: 0, input: 0, output: 0, cost: 0 };
		row.runs += d.runs ?? 0;
		row.phases += d.phases ?? 0;
		row.input += d.input;
		row.output += d.output;
		row.cost += d.cost;
		buckets.set(key, row);
	};

	for (const entry of readIndex()) {
		if (!entryPassesFilter(entry, filter)) continue;
		const manifest = readManifest(runDirForEntry(entry));
		if (by === "model" || by === "phase") {
			if (!manifest) continue;
			if (by === "model") {
				for (const [model, agg] of Object.entries(manifest.totals.byModel)) {
					bump(model, { phases: agg.phases, input: agg.input, output: agg.output, cost: agg.cost });
				}
				bump("(runs)", { runs: 1, input: 0, output: 0, cost: 0 });
			} else {
				for (const p of manifest.phases) {
					bump(p.role, {
						phases: 1,
						input: p.usage?.input ?? 0,
						output: p.usage?.output ?? 0,
						cost: p.usage?.cost ?? 0,
					});
				}
			}
		} else {
			const key = by === "outcome" ? (manifest?.outcome ?? entry.outcome) : entry.startedAt.slice(0, 10);
			bump(key, {
				runs: 1,
				phases: manifest?.phases.length ?? 0,
				input: manifest?.totals.input ?? entry.input,
				output: manifest?.totals.output ?? entry.output,
				cost: manifest?.totals.cost ?? entry.cost,
			});
		}
	}

	const rows = [...buckets.values()].filter((r) => r.key !== "(runs)");
	rows.sort((a, b) => (by === "day" ? b.key.localeCompare(a.key) : b.cost - a.cost || b.input - a.input));
	return rows;
}

export function formatTimeline(rows: TimelineRow[], by: TimelineBy): string[] {
	if (rows.length === 0) return ["forge:transcripts — no archived runs match."];
	const keyHeader = by === "day" ? "day" : by;
	const body = rows.map((r) => [
		r.key,
		by === "model" || by === "phase" ? String(r.phases) : String(r.runs),
		fmtTokens(r.input),
		fmtTokens(r.output),
		fmtCost(r.cost),
	]);
	const countHeader = by === "model" || by === "phase" ? "phases" : "runs";
	return [`Timeline by ${by}:`, ...table([keyHeader, countHeader, "in", "out", "cost"], body)];
}

// ── projects ────────────────────────────────────────────────────────────

export function formatProjects(registry: ProjectsRegistry): string[] {
	const entries = Object.entries(registry.projects);
	if (entries.length === 0) return ["forge:transcripts — no projects in the archive yet."];
	const body = entries
		.sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen))
		.map(([key, p]) => [key, p.name, p.prefix, String(p.runCount), p.lastSeen.slice(0, 10), p.path]);
	return [
		`${entries.length} project${entries.length === 1 ? "" : "s"} in the archive:`,
		...table(["key", "name", "prefix", "runs", "last seen", "path"], body),
	];
}

// ── arg parsing + registration ──────────────────────────────────────────

export interface ParsedArgs {
	subcommand: "list" | "show" | "timeline" | "projects";
	positional: string[];
	project?: string;
	sinceDays?: number;
	by?: TimelineBy;
	json: boolean;
	error?: string;
}

export function parseTranscriptsArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
	const first = tokens[0];
	const subcommand =
		first === "list" || first === "show" || first === "timeline" || first === "projects" ? first : "list";
	if (subcommand === first) tokens.shift();

	const parsed: ParsedArgs = { subcommand, positional: [], json: false };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--json") {
			parsed.json = true;
		} else if (t === "--project") {
			const v = tokens[++i];
			if (!v) return { ...parsed, error: "--project requires a project key (see `projects`)" };
			parsed.project = v;
		} else if (t === "--since") {
			const v = tokens[++i];
			const m = v ? /^(\d+)d$/.exec(v) : null;
			if (!m) return { ...parsed, error: "--since requires <N>d, e.g. --since 7d" };
			parsed.sinceDays = Number(m[1]);
		} else if (t === "--by") {
			const v = tokens[++i];
			if (v !== "model" && v !== "phase" && v !== "outcome") {
				return { ...parsed, error: "--by requires model|phase|outcome" };
			}
			parsed.by = v;
		} else if (t.startsWith("--")) {
			return { ...parsed, error: `unknown flag ${t}` };
		} else {
			parsed.positional.push(t);
		}
	}
	return parsed;
}

// ── Interactive browse TUI + replay dashboard ───────────────────────────

/**
 * Interactive session check. False negatives (embedded contexts without a
 * TTY) degrade to the text `list` output — the script-safe failure mode.
 */
function isInteractive(ctx: ExtensionCommandContext): boolean {
	return typeof ctx.ui.custom === "function" && process.stdout.isTTY === true;
}

/** One browse-overlay pass: resolves to the chosen runId, or null on quit. */
function browseOverlay(ctx: ExtensionCommandContext): Promise<string | null> {
	const rows = collectListRows();
	const knownProjects = Object.keys(readProjects().projects);
	const router = getInputRouter();
	router.pushOverlay();
	return ctx.ui
		.custom<string | null>(
			(tui, theme, _kb, done) =>
				new BrowseTuiComponent({
					rows,
					knownProjects,
					theme,
					requestRender: () => tui.requestRender(),
					onSelect: (runId) => done(runId),
					onExit: () => done(null),
				}),
			{
				overlay: true,
				overlayOptions: { width: "100%", anchor: "center", margin: 0 },
			},
		)
		.finally(() => {
			router.popOverlay();
		});
}

/**
 * Browse → replay re-entry loop. Overlays run strictly SEQUENTIALLY (each
 * pushOverlay/popOverlay pair completes before the next overlay opens) so
 * the input-router depth stays at exactly 1 — never stacked. Closing the
 * replay dashboard (Esc) lands back in the browser; quitting the browser
 * (q / Esc) ends the loop.
 */
export async function openTranscriptsBrowser(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const runId = await browseOverlay(ctx);
		if (!runId) return;
		const resolved = resolveRun(runId);
		if (!resolved) {
			ctx.ui.notify(`× forge:transcripts — archived run ${runId} could not be resolved`, "error");
			continue;
		}
		const { tree } = hydrateRunTree(resolved.manifest, resolved.runDir);
		await openDashboardTui(ctx, { tree, readOnly: true });
	}
}

/**
 * Register /forge:transcripts. Takes no forgeRoot — the archive is central
 * and the command must work outside any Forge project (cross-project recall).
 */
export function registerTranscriptsCommand(pi: ExtensionAPI, _opts: Record<string, never> = {}): void {
	pi.registerCommand("forge:transcripts", {
		description:
			"Browse the central transcript archive. No args: interactive browser with filters; " +
			"⏎ replays a run in the read-only dashboard. Text subcommands: list [entityId] | " +
			"show <runId|entityId> [phase] | timeline [--by model|phase|outcome] | projects. " +
			"Works outside any Forge project.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			// No args (or `browse`) in an interactive session → browse TUI.
			// Non-interactive contexts fall through to the text `list` below.
			const trimmed = args.trim();
			if ((trimmed === "" || trimmed === "browse") && isInteractive(ctx)) {
				await openTranscriptsBrowser(ctx);
				return;
			}

			const parsed = parseTranscriptsArgs(args);
			if (parsed.error) {
				ctx.ui.notify(`× forge:transcripts — ${parsed.error}`, "error");
				return;
			}
			const filter: ListFilter = {
				...(parsed.positional[0] && parsed.subcommand === "list" ? { entityId: parsed.positional[0] } : {}),
				...(parsed.project ? { project: parsed.project } : {}),
				...(parsed.sinceDays !== undefined ? { sinceDays: parsed.sinceDays } : {}),
			};

			let lines: string[];
			if (parsed.subcommand === "projects") {
				lines = formatProjects(readProjects());
			} else if (parsed.subcommand === "timeline") {
				const by: TimelineBy = parsed.by ?? "day";
				const rows = collectTimeline(filter, by);
				lines = parsed.json ? [JSON.stringify(rows, null, 2)] : formatTimeline(rows, by);
			} else if (parsed.subcommand === "show") {
				const idArg = parsed.positional[0];
				if (!idArg) {
					ctx.ui.notify("× forge:transcripts — show requires <runId|entityId>", "error");
					return;
				}
				const resolved = resolveRun(idArg);
				if (!resolved) {
					ctx.ui.notify(`× forge:transcripts — no archived run found for "${idArg}"`, "error");
					return;
				}
				let digest: { role: string; file: string; lines: string[] } | undefined;
				const phaseArg = parsed.positional[1];
				if (phaseArg) {
					const candidates = resolved.manifest.phases.filter((p) => p.role === phaseArg && p.file);
					const record = candidates[candidates.length - 1];
					if (!record?.file) {
						ctx.ui.notify(
							`× forge:transcripts — run ${resolved.entry.runId} has no archived "${phaseArg}" phase transcript`,
							"error",
						);
						return;
					}
					const payload = gunzipPhase(resolved.runDir, record.file);
					if (!payload) {
						ctx.ui.notify(`× forge:transcripts — could not read ${path.join(resolved.runDir, record.file)}.gz`, "error");
						return;
					}
					digest = { role: record.role, file: record.file, lines: digestPhasePayload(payload) };
				}
				lines = formatShow(resolved.manifest, digest);
				if (resolved.siblingCount > 1 && parsed.positional[0] !== resolved.entry.runId) {
					lines.push(
						"",
						`  Note: ${resolved.siblingCount} runs archived for ${resolved.entry.entityId}; showing latest. Use a runId from \`list ${resolved.entry.entityId}\` for an earlier one.`,
					);
				}
			} else {
				const rows = collectListRows(filter);
				lines = parsed.json ? [JSON.stringify(rows, null, 2)] : formatList(rows);
			}

			for (const line of lines) ctx.ui.notify(line, "info");
		},
	});
}
