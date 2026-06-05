// transcript-archive.ts — central, full-retention transcript archive core.
//
// Mirrors project-local `.forge/transcripts/<entityId>/` runs into the
// permanent cross-project archive under `~/.pi/forge-cli/transcripts/`
// (FORGE_CLI_HOME-aware via paths/paths.ts). Copy-up only: this module has
// ZERO delete paths — project-local transcripts stay untouched (live
// debugging and verify-governance.sh depend on them; the archive is the
// permanent mirror, `.forge/` is the ephemeral working copy).
//
// Compression is node:zlib gzip — byte archival of phase payloads (~10:1).
// NOT @entelligentsia/forge-compress, which is token compression for LLM
// contexts; nothing here ever re-enters a model context uncompressed.
//
// Every write path is best-effort and never throws: archiving is
// observability data, not load-bearing pipeline state. Every read path
// Value.Checks untrusted disk JSON and returns null/defaults on mismatch.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Value } from "typebox/value";
import {
	getRunArchiveDir,
	getTranscriptArchiveRoot,
	getTranscriptIndexPath,
	getTranscriptProjectsPath,
} from "./paths/paths.js";
import {
	type EntityKind,
	type IndexEntry,
	IndexEntrySchema,
	type PhaseRecord,
	type PhaseUsage,
	PhaseUsageSchema,
	type ProjectsRegistry,
	ProjectsRegistrySchema,
	type RunManifest,
	RunManifestSchema,
	type RunOutcome,
	type RunTotals,
	type UsageAggregate,
} from "./transcript-archive-types.js";

// ── Project identity ────────────────────────────────────────────────────

export interface ProjectIdentity {
	prefix: string;
	name: string;
	projectDir: string;
}

/**
 * Read `{prefix, name, projectDir}` from a `.forge/config.json`. Defaults on
 * any failure (missing file, malformed JSON, absent fields) — never throws.
 * `projectDir` is derived from the config path itself (`<dir>/.forge/config.json`).
 */
export function readProjectIdentity(configPath: string): ProjectIdentity {
	const projectDir = path.dirname(path.dirname(configPath));
	const fallbackName = path.basename(projectDir) || "project";
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
			project?: { prefix?: unknown; name?: unknown };
		};
		const prefix =
			typeof raw.project?.prefix === "string" && raw.project.prefix.length > 0
				? raw.project.prefix
				: "project";
		const name =
			typeof raw.project?.name === "string" && raw.project.name.length > 0
				? raw.project.name
				: fallbackName;
		return { prefix, name, projectDir };
	} catch {
		return { prefix: "project", name: fallbackName, projectDir };
	}
}

/**
 * `<prefix>-<sha256(realpath(projectDir)).slice(0,8)>` — prefix alone can
 * collide across projects (two repos both named "FORGE"); the path hash
 * disambiguates. Falls back to the raw path when realpath throws (deleted
 * or unmounted project dir — archive entries must remain addressable).
 */
export function computeProjectKey(projectDir: string, prefix: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync(projectDir);
	} catch {
		resolved = projectDir;
	}
	const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
	const slug =
		prefix
			.toLowerCase()
			.replace(/[^a-z0-9._-]/g, "_")
			.slice(0, 40) || "project";
	return `${slug}-${hash}`;
}

// ── Orchestrator JSONL + phase-transcript parsing ───────────────────────

/** "2026-05-28T13:35:00.123Z" → "20260528T133500Z" (compact UTC). */
function compactIso(iso: string): string {
	return iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/** "20260528T133500Z" → "2026-05-28T13:35:00Z" (inverse of compactIso). */
function expandCompactIso(compact: string): string {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(compact);
	if (!m) return compact;
	return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

interface JsonlEvent {
	kind?: string;
	ts?: string;
	[key: string]: unknown;
}

/** Tolerant JSONL parse — skips malformed/truncated lines, never throws. */
function readJsonlEvents(filePath: string): JsonlEvent[] {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const events: JsonlEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object") events.push(parsed as JsonlEvent);
		} catch {
			// Crash-truncated tail line — skip.
		}
	}
	return events;
}

interface PhaseFileInfo {
	/** Absolute path to the project-local phase transcript JSON. */
	absPath: string;
	/** Basename, e.g. "20260601T100100Z__CART-BUG-001__triage.json". */
	file: string;
	/** Compact ISO prefix from the filename. */
	ts: string;
	/** Role segment from the filename (third "__" part onward). */
	role: string;
}

/** Filename shape written by forge-subagent.ts / orchestrator-transcript.ts. */
const PHASE_FILE_RE = /^(\d{8}T\d{6}Z)__(.+)__(.+)\.json$/;
const ORCH_FILE_RE = /^(\d{8}T\d{6}Z)__(.+)__orchestrator\.jsonl$/;

interface PhaseHeader {
	model?: string;
	provider?: string;
	usage?: PhaseUsage;
	startedAt?: string;
}

/** Extract header fields from a phase-transcript JSON; null on parse failure. */
function readPhaseHeader(absPath: string): PhaseHeader | null {
	try {
		const raw = JSON.parse(fs.readFileSync(absPath, "utf8")) as Record<string, unknown>;
		const header: PhaseHeader = {};
		if (typeof raw.model === "string" && raw.model.length > 0) header.model = raw.model;
		if (typeof raw.provider === "string" && raw.provider.length > 0) header.provider = raw.provider;
		if (typeof raw.startedAt === "string") header.startedAt = raw.startedAt;
		if (raw.usage && typeof raw.usage === "object") {
			const candidate = raw.usage as Record<string, unknown>;
			if (Value.Check(PhaseUsageSchema, candidate)) header.usage = candidate;
		}
		return header;
	} catch {
		return null;
	}
}

// ── Run discovery + manifest building ───────────────────────────────────

/** One discovered run: source files + the manifest built from them. */
export interface DiscoveredRun {
	runId: string;
	jsonlPath: string;
	phaseFiles: PhaseFileInfo[];
	manifest: RunManifest;
}

interface BuildOptions {
	/** Sprint back-reference stamped onto the manifest (run-sprint wiring). */
	sprintId?: string;
}

function emptyTotals(): RunTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		byModel: {},
		byProvider: {},
		revisionLoops: 0,
	};
}

function bumpAggregate(bucket: Record<string, UsageAggregate>, key: string, usage: PhaseUsage): void {
	const agg = bucket[key] ?? { input: 0, output: 0, cost: 0, phases: 0 };
	agg.input += usage.input;
	agg.output += usage.output;
	agg.cost += usage.cost;
	agg.phases += 1;
	bucket[key] = agg;
}

function buildManifestForRun(
	runId: string,
	events: JsonlEvent[],
	phaseFiles: PhaseFileInfo[],
	identity: ProjectIdentity,
	projectKey: string,
	fallbackEntityId: string,
	fallbackStartIso: string,
	opts: BuildOptions,
): RunManifest {
	const pipelineStart = events.find((e) => e.kind === "pipeline-start");
	const pipelineEnd = events.find((e) => e.kind === "pipeline-end");
	const phaseEnds = events.filter((e) => e.kind === "phase-end");
	const revisionLoops = events.filter((e) => e.kind === "phase-loopback").length;

	const entityId =
		typeof pipelineStart?.entityId === "string" && pipelineStart.entityId.length > 0
			? pipelineStart.entityId
			: fallbackEntityId;
	const rawKind = pipelineStart?.entityKind;
	const entityKind: EntityKind =
		rawKind === "task" || rawKind === "bug" || rawKind === "sprint" ? rawKind : "unknown";

	const rawOutcome = pipelineEnd?.outcome;
	const outcome: RunOutcome =
		rawOutcome === "complete" || rawOutcome === "halted" || rawOutcome === "cancelled" || rawOutcome === "error"
			? rawOutcome
			: "incomplete";

	// Phase records: one per phase-transcript file (chronological), decorated
	// with verdict/attempt/elapsedMs from the matching phase-end event. Two
	// matchers, tried in order:
	//   1. phase-end.subagentTranscriptPath basename (exact, when populated)
	//   2. same role, in chronological order (legacy runs without the path)
	const phases: PhaseRecord[] = [];
	const roleSeen: Record<string, number> = {};
	const usedEnds = new Set<number>();

	for (const pf of [...phaseFiles].sort((a, b) => a.file.localeCompare(b.file))) {
		roleSeen[pf.role] = (roleSeen[pf.role] ?? 0) + 1;
		const header = readPhaseHeader(pf.absPath);
		const record: PhaseRecord = {
			role: pf.role,
			attempt: roleSeen[pf.role],
			verdict: "n/a",
			file: pf.file,
		};
		if (header?.model) record.model = header.model;
		if (header?.provider) record.provider = header.provider;
		if (header?.usage) record.usage = header.usage;
		if (header?.startedAt) record.startedAt = header.startedAt;

		let matchIdx = phaseEnds.findIndex(
			(e, i) =>
				!usedEnds.has(i) &&
				typeof e.subagentTranscriptPath === "string" &&
				path.basename(e.subagentTranscriptPath) === pf.file,
		);
		if (matchIdx < 0) {
			matchIdx = phaseEnds.findIndex((e, i) => !usedEnds.has(i) && e.phase === pf.role);
		}
		if (matchIdx >= 0) {
			usedEnds.add(matchIdx);
			const end = phaseEnds[matchIdx];
			if (typeof end.verdict === "string") record.verdict = end.verdict;
			if (typeof end.attempt === "number") record.attempt = end.attempt;
			if (typeof end.elapsedMs === "number") record.elapsedMs = end.elapsedMs;
		}
		phases.push(record);
	}

	// Phase-end events with no transcript file (export failed) still surface.
	phaseEnds.forEach((end, i) => {
		if (usedEnds.has(i)) return;
		phases.push({
			role: typeof end.phase === "string" ? end.phase : "unknown",
			attempt: typeof end.attempt === "number" ? end.attempt : 1,
			verdict: typeof end.verdict === "string" ? end.verdict : "n/a",
			...(typeof end.elapsedMs === "number" ? { elapsedMs: end.elapsedMs } : {}),
		});
	});

	const totals = emptyTotals();
	totals.revisionLoops = revisionLoops;
	for (const p of phases) {
		if (!p.usage) continue;
		totals.input += p.usage.input;
		totals.output += p.usage.output;
		totals.cacheRead += p.usage.cacheRead;
		totals.cacheWrite += p.usage.cacheWrite;
		totals.cost += p.usage.cost;
		bumpAggregate(totals.byModel, p.model ?? "unknown", p.usage);
		bumpAggregate(totals.byProvider, p.provider ?? "unknown", p.usage);
	}

	const startedAt = typeof pipelineStart?.ts === "string" ? pipelineStart.ts : undefined;
	const finishedAt = typeof pipelineEnd?.ts === "string" ? pipelineEnd.ts : undefined;
	const durationMs = typeof pipelineEnd?.elapsedMs === "number" ? pipelineEnd.elapsedMs : undefined;

	return {
		schema: "forge-run-manifest/v1",
		runId,
		projectKey,
		projectPath: identity.projectDir,
		projectName: identity.name,
		projectPrefix: identity.prefix,
		entityId,
		entityKind,
		...(opts.sprintId ? { sprintId: opts.sprintId } : {}),
		startedAt: startedAt ?? fallbackStartIso,
		...(finishedAt ? { finishedAt } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		outcome,
		phases,
		totals,
		archivedAt: new Date().toISOString(),
	};
}

/**
 * Discover every run in a project-local entity transcript dir
 * (`.forge/transcripts/<entityId>/`) and build a RunManifest for each.
 *
 * A "run" is one orchestrator JSONL file; its runId is the compact-ISO
 * pipeline-start timestamp (falling back to the filename prefix). Phase
 * transcript files are assigned to the latest run whose start precedes
 * them — compact ISO prefixes compare lexicographically as timestamps.
 */
export function buildRunsForEntityDir(
	entityDir: string,
	identity: ProjectIdentity,
	projectKey: string,
	opts: BuildOptions = {},
): DiscoveredRun[] {
	let names: string[];
	try {
		names = fs.readdirSync(entityDir);
	} catch {
		return [];
	}
	const fallbackEntityId = path.basename(entityDir);

	const jsonls: { absPath: string; ts: string }[] = [];
	const phaseFiles: PhaseFileInfo[] = [];
	for (const name of names) {
		const orchMatch = ORCH_FILE_RE.exec(name);
		if (orchMatch) {
			jsonls.push({ absPath: path.join(entityDir, name), ts: orchMatch[1] });
			continue;
		}
		const phaseMatch = PHASE_FILE_RE.exec(name);
		if (phaseMatch) {
			phaseFiles.push({
				absPath: path.join(entityDir, name),
				file: name,
				ts: phaseMatch[1],
				role: phaseMatch[3],
			});
		}
	}
	jsonls.sort((a, b) => a.ts.localeCompare(b.ts));

	const runs: DiscoveredRun[] = [];
	for (let i = 0; i < jsonls.length; i++) {
		const jsonl = jsonls[i];
		const nextTs = jsonls[i + 1]?.ts;
		const events = readJsonlEvents(jsonl.absPath);
		const pipelineStart = events.find((e) => e.kind === "pipeline-start");
		const runId =
			typeof pipelineStart?.ts === "string" ? compactIso(pipelineStart.ts) : jsonl.ts;
		const runPhaseFiles = phaseFiles.filter(
			(pf) => pf.ts >= jsonl.ts && (nextTs === undefined || pf.ts < nextTs),
		);
		runs.push({
			runId,
			jsonlPath: jsonl.absPath,
			phaseFiles: runPhaseFiles,
			manifest: buildManifestForRun(
				runId,
				events,
				runPhaseFiles,
				identity,
				projectKey,
				fallbackEntityId,
				expandCompactIso(jsonl.ts),
				opts,
			),
		});
	}
	return runs;
}

// ── Archive writes ──────────────────────────────────────────────────────

function writeFileAtomic(target: string, content: string): void {
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, target);
}

function indexKey(projectKey: string, entityId: string, runId: string): string {
	return `${projectKey}/${entityId}/${runId}`;
}

function upsertProject(projectKey: string, identity: ProjectIdentity, newRun: boolean): void {
	const registry = readProjects();
	const now = new Date().toISOString();
	const existing = registry.projects[projectKey];
	registry.projects[projectKey] = {
		path: identity.projectDir,
		prefix: identity.prefix,
		name: identity.name,
		firstSeen: existing?.firstSeen ?? now,
		lastSeen: now,
		runCount: (existing?.runCount ?? 0) + (newRun ? 1 : 0),
	};
	writeFileAtomic(getTranscriptProjectsPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

export interface ArchiveRunResult {
	archived: boolean;
	runDir?: string;
	error?: string;
}

/**
 * Archive one discovered run: gzip phase transcripts into the run dir, copy
 * orchestrator.jsonl as-is, write manifest.json (tmp+rename), append the
 * index line (only if this runId isn't already indexed — crash between
 * manifest write and index append heals here), and upsert projects.json.
 *
 * Idempotent: re-archiving the same run (resume with the same runId, or a
 * sweep racing a live pipeline) overwrites the manifest/payloads with newer,
 * fuller data and appends no duplicate index line. Best-effort, never throws.
 */
function writeRunArchive(run: DiscoveredRun, identity: ProjectIdentity, projectKey: string): ArchiveRunResult {
	try {
		const { manifest } = run;
		const runDir = getRunArchiveDir(projectKey, manifest.entityId, run.runId);
		fs.mkdirSync(runDir, { recursive: true });

		for (const pf of run.phaseFiles) {
			const gz = gzipSync(fs.readFileSync(pf.absPath));
			fs.writeFileSync(path.join(runDir, `${pf.file}.gz`), gz);
		}
		fs.copyFileSync(run.jsonlPath, path.join(runDir, "orchestrator.jsonl"));
		writeFileAtomic(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

		const alreadyIndexed = readIndex().some(
			(e) => indexKey(e.projectKey, e.entityId, e.runId) === indexKey(projectKey, manifest.entityId, run.runId),
		);
		if (!alreadyIndexed) {
			const entry: IndexEntry = {
				runId: run.runId,
				projectKey,
				entityId: manifest.entityId,
				entityKind: manifest.entityKind,
				...(manifest.sprintId ? { sprintId: manifest.sprintId } : {}),
				startedAt: manifest.startedAt,
				outcome: manifest.outcome,
				input: manifest.totals.input,
				output: manifest.totals.output,
				cost: manifest.totals.cost,
				...(manifest.durationMs !== undefined ? { durationMs: manifest.durationMs } : {}),
				archivedAt: manifest.archivedAt,
			};
			// Single sub-1KB appendFileSync line — atomic on Linux.
			fs.appendFileSync(getTranscriptIndexPath(), `${JSON.stringify(entry)}\n`, "utf8");
		}
		upsertProject(projectKey, identity, !alreadyIndexed);

		return { archived: true, runDir };
	} catch (err: unknown) {
		const e = err as { message?: string };
		return { archived: false, error: e.message ?? "archive write failed" };
	}
}

export interface ArchiveRunOptions {
	/** Project dir (the dir containing `.forge/`). */
	cwd: string;
	/** Project-local orchestrator JSONL path for the run to archive. */
	orchestratorJsonlPath: string;
	/** Sprint back-reference for sprint-nested task runs. */
	sprintId?: string;
	/** Override for `<cwd>/.forge/config.json` (tests). */
	configPath?: string;
}

/**
 * Archive the run identified by its project-local orchestrator transcript.
 * Called by orchestrators after the pipeline result is known. Best-effort,
 * never throws.
 */
export function archiveRun(opts: ArchiveRunOptions): ArchiveRunResult {
	try {
		const configPath = opts.configPath ?? path.join(opts.cwd, ".forge", "config.json");
		const identity = readProjectIdentity(configPath);
		const projectKey = computeProjectKey(identity.projectDir, identity.prefix);
		const entityDir = path.dirname(opts.orchestratorJsonlPath);
		const runs = buildRunsForEntityDir(entityDir, identity, projectKey, { sprintId: opts.sprintId });
		const wanted = path.resolve(opts.orchestratorJsonlPath);
		const run = runs.find((r) => path.resolve(r.jsonlPath) === wanted);
		if (!run) return { archived: false, error: `no run found for ${opts.orchestratorJsonlPath}` };
		return writeRunArchive(run, identity, projectKey);
	} catch (err: unknown) {
		const e = err as { message?: string };
		return { archived: false, error: e.message ?? "archiveRun failed" };
	}
}

export interface SweepResult {
	adopted: number;
	errors: number;
}

/**
 * Adopt orphans: archive every project-local run whose runId isn't in the
 * central index. Covers crash recovery (pipeline died before its archive
 * call) and adoption of pre-existing history (transcripts written before
 * this feature shipped). Called best-effort at pipeline start; never throws.
 */
export function sweepProjectTranscripts(cwd: string, configPath?: string): SweepResult {
	try {
		const base = path.join(cwd, ".forge", "transcripts");
		if (!fs.existsSync(base)) return { adopted: 0, errors: 0 };
		const identity = readProjectIdentity(configPath ?? path.join(cwd, ".forge", "config.json"));
		const projectKey = computeProjectKey(identity.projectDir, identity.prefix);
		const indexed = new Set(readIndex().map((e) => indexKey(e.projectKey, e.entityId, e.runId)));

		let adopted = 0;
		let errors = 0;
		for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const runs = buildRunsForEntityDir(path.join(base, entry.name), identity, projectKey);
			for (const run of runs) {
				if (indexed.has(indexKey(projectKey, run.manifest.entityId, run.runId))) continue;
				const result = writeRunArchive(run, identity, projectKey);
				if (result.archived) adopted++;
				else errors++;
			}
		}
		return { adopted, errors };
	} catch {
		return { adopted: 0, errors: 1 };
	}
}

// ── Archive reads ───────────────────────────────────────────────────────

/** Read index.jsonl — skips malformed/truncated lines, never throws. */
export function readIndex(): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const event of readJsonlEvents(getTranscriptIndexPath())) {
		if (Value.Check(IndexEntrySchema, event)) entries.push(event);
	}
	return entries;
}

/** Read projects.json — empty registry on any failure, never throws. */
export function readProjects(): ProjectsRegistry {
	try {
		const raw = JSON.parse(fs.readFileSync(getTranscriptProjectsPath(), "utf8")) as unknown;
		if (Value.Check(ProjectsRegistrySchema, raw)) return raw;
	} catch {
		// fall through
	}
	return { version: 1, projects: {} };
}

/** Read `<runDir>/manifest.json` — null on missing/truncated/mismatched. */
export function readManifest(runDir: string): RunManifest | null {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")) as unknown;
		if (Value.Check(RunManifestSchema, raw)) return raw;
	} catch {
		// fall through
	}
	return null;
}

/**
 * Gunzip + parse an archived phase transcript. `file` is the manifest's
 * phase `file` field (without `.gz`). Null on any failure, never throws.
 */
export function gunzipPhase(runDir: string, file: string): Record<string, unknown> | null {
	try {
		const gzPath = path.join(runDir, file.endsWith(".gz") ? file : `${file}.gz`);
		const parsed = JSON.parse(gunzipSync(fs.readFileSync(gzPath)).toString("utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	return null;
}

/** Resolve the archive dir for an index entry. */
export function runDirForEntry(entry: IndexEntry): string {
	return getRunArchiveDir(entry.projectKey, entry.entityId, entry.runId);
}

// ── Phase-payload digest ────────────────────────────────────────────────
// Lives here (not in the command) so both the /forge:transcripts text
// surface and the replay hydrator (transcript-replay.ts) can use it
// without a command→replay→command import cycle.

interface MessageLike {
	role?: string;
	toolName?: string;
	isError?: boolean;
	content?: unknown;
}

function fmtSize(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * Per-turn digest of a gunzipped phase payload — never a raw JSON dump.
 * Each assistant message is a turn: first text line + tool-call names;
 * toolResult messages render as compact result markers.
 */
export function digestPhasePayload(payload: Record<string, unknown>): string[] {
	const messages = Array.isArray(payload.messages) ? (payload.messages as MessageLike[]) : [];
	const lines: string[] = [];
	let turn = 0;
	for (const msg of messages) {
		if (msg.role === "assistant") {
			turn++;
			const parts = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
			const textPart = parts.find((p) => p.type === "text" && typeof p.text === "string");
			const firstLine = textPart ? (textPart.text as string).trim().split("\n")[0] : "";
			lines.push(`  t${turn}  ${firstLine ? (firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine) : "(no text)"}`);
			for (const p of parts) {
				if (p.type === "toolCall" && typeof p.name === "string") lines.push(`       → ${p.name}`);
			}
		} else if (msg.role === "toolResult") {
			const size = typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content ?? "").length;
			lines.push(`       ← ${msg.toolName ?? "tool"} ${msg.isError ? "✗" : "✓"} (${fmtSize(size)} chars)`);
		}
	}
	if (lines.length === 0) lines.push("  (no messages in payload)");
	return lines;
}

export { getTranscriptArchiveRoot };
