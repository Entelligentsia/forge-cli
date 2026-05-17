// What's-New startup panel.
//
// On `session_start`, compares the running versions of pi-coding-agent,
// the bundled forge plugin, and forge-cli itself against the last-seen
// versions in `~/.cache/forgecli/whats-new-seen.json`. When any has
// advanced, emits a compact 3-line summary via `ctx.ui.notify`, then
// records the new versions so subsequent sessions stay quiet.
//
// `/whats-new` re-renders the summary from the same cache, and
// `/whats-new <component>` drills into one component's full changelog
// entries between the previous-seen and current versions.
//
// All disk I/O is fail-silent on the user surface; FORGE_DEBUG_WHATS_NEW=1
// prints diagnostic output to stderr.

import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ComponentId = "pi" | "forge-plugin" | "forge-cli";

export interface SeenState {
	pi: string | null;
	forgePlugin: string | null;
	forgeCli: string | null;
	// Replay baseline. Updated only on explicit dismiss, so users can
	// re-open the most recent summary across sessions.
	prevPi: string | null;
	prevForgePlugin: string | null;
	prevForgeCli: string | null;
	// `from` versions of the most recently shown summary. Frozen at the
	// moment the panel mounts and never overwritten by dismiss, so
	// /whats-new can always replay the last-shown set even after dismissal.
	lastShownFromPi: string | null;
	lastShownFromForgePlugin: string | null;
	lastShownFromForgeCli: string | null;
	lastShownAt: number;
}

export interface ChangelogEntry {
	version: string;
	date: string | null;
	sections: { name: string; bullets: string[] }[];
	rawBody: string;
}

export interface ChangeSummary {
	component: ComponentId;
	label: string;
	fromVersion: string | null;
	toVersion: string;
	totalChanges: number;
	byCategory: Map<string, number>;
	entries: ChangelogEntry[];
}

const COMPONENT_LABELS: Record<ComponentId, string> = {
	pi: "pi",
	"forge-plugin": "forge-plugin",
	"forge-cli": "forge-cli",
};

const COMPONENT_ORDER: ComponentId[] = ["pi", "forge-plugin", "forge-cli"];

function defaultCacheDir(): string {
	const root = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
	return path.join(root, "forgecli");
}

function cachePath(cacheDir: string): string {
	return path.join(cacheDir, "whats-new-seen.json");
}

function debug(...args: unknown[]): void {
	if (process.env.FORGE_DEBUG_WHATS_NEW === "1") {
		console.error("[forge-cli whats-new]", ...args);
	}
}

export function emptySeenState(): SeenState {
	return {
		pi: null,
		forgePlugin: null,
		forgeCli: null,
		prevPi: null,
		prevForgePlugin: null,
		prevForgeCli: null,
		lastShownFromPi: null,
		lastShownFromForgePlugin: null,
		lastShownFromForgeCli: null,
		lastShownAt: 0,
	};
}

export async function readSeenState(cacheDir: string): Promise<SeenState> {
	try {
		const raw = await fs.readFile(cachePath(cacheDir), "utf8");
		const parsed = JSON.parse(raw) as Partial<SeenState>;
		const s = emptySeenState();
		if (typeof parsed.pi === "string") s.pi = parsed.pi;
		if (typeof parsed.forgePlugin === "string") s.forgePlugin = parsed.forgePlugin;
		if (typeof parsed.forgeCli === "string") s.forgeCli = parsed.forgeCli;
		if (typeof parsed.prevPi === "string") s.prevPi = parsed.prevPi;
		if (typeof parsed.prevForgePlugin === "string") s.prevForgePlugin = parsed.prevForgePlugin;
		if (typeof parsed.prevForgeCli === "string") s.prevForgeCli = parsed.prevForgeCli;
		if (typeof parsed.lastShownFromPi === "string") s.lastShownFromPi = parsed.lastShownFromPi;
		if (typeof parsed.lastShownFromForgePlugin === "string") s.lastShownFromForgePlugin = parsed.lastShownFromForgePlugin;
		if (typeof parsed.lastShownFromForgeCli === "string") s.lastShownFromForgeCli = parsed.lastShownFromForgeCli;
		if (typeof parsed.lastShownAt === "number") s.lastShownAt = parsed.lastShownAt;
		return s;
	} catch {
		return emptySeenState();
	}
}

export async function writeSeenState(cacheDir: string, state: SeenState): Promise<void> {
	await fs.mkdir(cacheDir, { recursive: true });
	const final = cachePath(cacheDir);
	const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
	await fs.rename(tmp, final);
}

// ── semver helpers ────────────────────────────────────────────────────────

function parseTriple(v: string): [number, number, number] | null {
	const cleaned = v.startsWith("v") ? v.slice(1) : v;
	const parts = cleaned.split("-")[0]!.split(".");
	if (parts.length !== 3) return null;
	const nums: number[] = [];
	for (const p of parts) {
		if (!/^\d+$/.test(p)) return null;
		nums.push(Number.parseInt(p, 10));
	}
	return [nums[0]!, nums[1]!, nums[2]!];
}

export function semverGt(a: string, b: string): boolean {
	const pa = parseTriple(a);
	const pb = parseTriple(b);
	if (!pa || !pb) return false;
	for (let i = 0; i < 3; i++) {
		if (pa[i]! > pb[i]!) return true;
		if (pa[i]! < pb[i]!) return false;
	}
	return false;
}

// ── changelog parsing ─────────────────────────────────────────────────────

const VERSION_HEADER = /^##\s+\[?([^\]\s]+)\]?(?:\s*[—–-]\s*(.+))?$/;
const SECTION_HEADER = /^###\s+(.+)$/;

/**
 * Parse a Keep-a-Changelog–style markdown body into per-version entries.
 * Tolerates pi's `### New Features` overview sections (which precede the
 * standard `### Added`/`### Fixed` sections) and the `[Unreleased]` block.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
	const lines = markdown.split("\n");
	const entries: ChangelogEntry[] = [];
	let current: ChangelogEntry | null = null;
	let currentSection: { name: string; bullets: string[] } | null = null;
	const currentBodyLines: string[] = [];

	const flushSection = () => {
		if (current && currentSection && currentSection.bullets.length > 0) {
			current.sections.push(currentSection);
		}
		currentSection = null;
	};
	const flushEntry = () => {
		flushSection();
		if (current) {
			current.rawBody = currentBodyLines.join("\n").trim();
			entries.push(current);
		}
		current = null;
		currentBodyLines.length = 0;
	};

	for (const line of lines) {
		const vMatch = line.match(VERSION_HEADER);
		if (vMatch) {
			flushEntry();
			const version = vMatch[1]!.trim();
			if (version.toLowerCase() === "unreleased") {
				// Skip [Unreleased] blocks entirely.
				current = null;
				continue;
			}
			current = {
				version,
				date: vMatch[2]?.trim() ?? null,
				sections: [],
				rawBody: "",
			};
			currentBodyLines.length = 0;
			continue;
		}
		if (!current) continue;
		currentBodyLines.push(line);

		const sMatch = line.match(SECTION_HEADER);
		if (sMatch) {
			flushSection();
			currentSection = { name: sMatch[1]!.trim(), bullets: [] };
			continue;
		}

		if (currentSection && /^\s*[-*]\s+/.test(line)) {
			currentSection.bullets.push(line.replace(/^\s*[-*]\s+/, "").trim());
		}
	}
	flushEntry();
	return entries;
}

/**
 * Reduce a list of changelog entries down to the ones strictly newer than
 * `from`, up to and including `to`. When `from` is null, returns only the
 * `to` entry (first-install case — don't dump the whole history).
 */
export function entriesBetween(entries: ChangelogEntry[], from: string | null, to: string): ChangelogEntry[] {
	const matchExact = entries.filter((e) => e.version === to);
	if (from === null) {
		return matchExact;
	}
	return entries.filter((e) => semverGt(e.version, from) && (e.version === to || !semverGt(e.version, to)));
}

const CATEGORY_ALIASES: Record<string, string> = {
	"new features": "added",
	added: "added",
	changed: "changed",
	fixed: "fixed",
	deprecated: "deprecated",
	removed: "removed",
	security: "security",
	tests: "tests",
	docs: "docs",
};

function normalizeCategory(name: string): string {
	const key = name.toLowerCase().trim();
	return CATEGORY_ALIASES[key] ?? key;
}

export function summarizeEntries(entries: ChangelogEntry[]): { total: number; byCategory: Map<string, number> } {
	const byCategory = new Map<string, number>();
	let total = 0;
	for (const entry of entries) {
		for (const section of entry.sections) {
			const cat = normalizeCategory(section.name);
			const n = section.bullets.length;
			if (n === 0) continue;
			byCategory.set(cat, (byCategory.get(cat) ?? 0) + n);
			total += n;
		}
	}
	return { total, byCategory };
}

// ── changelog source resolution ───────────────────────────────────────────

export interface ChangelogSources {
	pi: string | null;
	forgePlugin: string | null;
	forgeCli: string | null;
}

export function resolveChangelogPaths(pkgRoot: string): ChangelogSources {
	const candidates = {
		pi: [
			path.join(pkgRoot, "dist", "CHANGELOG-pi.md"),
			path.join(pkgRoot, "node_modules", "@earendil-works", "pi-coding-agent", "CHANGELOG.md"),
		],
		forgePlugin: [
			path.join(pkgRoot, "dist", "CHANGELOG-forge-plugin.md"),
			path.join(pkgRoot, "..", "forge", "CHANGELOG.md"),
		],
		forgeCli: [path.join(pkgRoot, "CHANGELOG.md")],
	};
	const pick = (paths: string[]): string | null => paths.find((p) => existsSync(p)) ?? null;
	return {
		pi: pick(candidates.pi),
		forgePlugin: pick(candidates.forgePlugin),
		forgeCli: pick(candidates.forgeCli),
	};
}

function readChangelogSafe(p: string | null): string | null {
	if (!p) return null;
	try {
		return readFileSync(p, "utf8");
	} catch (err) {
		debug("read failed:", p, err);
		return null;
	}
}

// ── summary computation ──────────────────────────────────────────────────

export interface CurrentVersions {
	pi: string;
	forgePlugin: string;
	forgeCli: string;
}

export type Baseline = "seen" | "prev" | "lastShown";

export interface ComputeOptions {
	sources: ChangelogSources;
	current: CurrentVersions;
	seen: SeenState;
	/** Which baseline to diff `current` against:
	 *   - "seen" (default): auto-dismiss check at session_start.
	 *   - "prev": /whats-new replay after auto-dismiss.
	 *   - "lastShown": /whats-new replay after explicit dismiss — uses the
	 *     `from` versions frozen at the most recent panel-mount so the
	 *     last-shown set remains viewable forever.
	 */
	baseline?: Baseline;
}

export function computeSummaries(opts: ComputeOptions): ChangeSummary[] {
	const baseline: Baseline = opts.baseline ?? "seen";
	const pickFrom = (id: ComponentId): string | null => {
		const s = opts.seen;
		switch (baseline) {
			case "seen":
				return id === "pi" ? s.pi : id === "forge-plugin" ? s.forgePlugin : s.forgeCli;
			case "prev":
				return id === "pi" ? s.prevPi : id === "forge-plugin" ? s.prevForgePlugin : s.prevForgeCli;
			case "lastShown":
				return id === "pi"
					? s.lastShownFromPi
					: id === "forge-plugin"
						? s.lastShownFromForgePlugin
						: s.lastShownFromForgeCli;
		}
	};
	const pairs: Array<{ id: ComponentId; current: string; src: string | null }> = [
		{ id: "pi", current: opts.current.pi, src: opts.sources.pi },
		{ id: "forge-plugin", current: opts.current.forgePlugin, src: opts.sources.forgePlugin },
		{ id: "forge-cli", current: opts.current.forgeCli, src: opts.sources.forgeCli },
	];

	const out: ChangeSummary[] = [];
	// For the lastShown baseline, presence of any panel-ever-shown is
	// signalled by lastShownAt > 0. If no panel was ever shown, return
	// no summaries so /whats-new prints "no recent updates" cleanly.
	if (baseline === "lastShown" && opts.seen.lastShownAt === 0) return out;
	for (const p of pairs) {
		if (!p.current) continue;
		const useFrom = pickFrom(p.id);
		// For the prev baseline, null means we have no replay info for this
		// component — skip it. (seen and lastShown null are both valid: seen
		// null = first install; lastShown null with lastShownAt>0 = the most
		// recent panel was a first-install panel.)
		if (useFrom === null && baseline === "prev") continue;
		const hasAdvanced = !useFrom || semverGt(p.current, useFrom);
		if (!hasAdvanced) continue;
		const markdown = readChangelogSafe(p.src);
		if (!markdown) {
			debug("no changelog source for", p.id);
			continue;
		}
		const parsed = parseChangelog(markdown);
		const slice = entriesBetween(parsed, useFrom, p.current);
		if (slice.length === 0) {
			debug("no matching entries for", p.id, "between", useFrom, "and", p.current);
			continue;
		}
		const sum = summarizeEntries(slice);
		out.push({
			component: p.id,
			label: COMPONENT_LABELS[p.id],
			fromVersion: useFrom,
			toVersion: p.current,
			totalChanges: sum.total,
			byCategory: sum.byCategory,
			entries: slice,
		});
	}
	return out;
}

// ── rendering ────────────────────────────────────────────────────────────

function formatVersionRange(from: string | null, to: string): string {
	return from ? `${from} → ${to}` : to;
}

function formatCategoryBreakdown(byCategory: Map<string, number>): string {
	const order = ["added", "changed", "fixed", "removed", "security", "deprecated", "tests", "docs"];
	const parts: string[] = [];
	for (const key of order) {
		const n = byCategory.get(key);
		if (n) parts.push(`${n} ${key}`);
	}
	// Surface unknown categories at the end so we never silently drop counts.
	for (const [key, n] of byCategory) {
		if (!order.includes(key)) parts.push(`${n} ${key}`);
	}
	return parts.length > 0 ? `(${parts.join(" · ")})` : "";
}

function padRight(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderSummaryPanel(summaries: ChangeSummary[]): string {
	if (summaries.length === 0) return "What's New: no recent updates.";
	const sorted = [...summaries].sort(
		(a, b) => COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component),
	);
	const labelWidth = Math.max(...sorted.map((s) => s.label.length), 12);
	const rangeWidth = Math.max(...sorted.map((s) => formatVersionRange(s.fromVersion, s.toVersion).length), 14);
	const lines = ["What's New since last login:"];
	for (const s of sorted) {
		const label = padRight(s.label, labelWidth);
		const range = padRight(formatVersionRange(s.fromVersion, s.toVersion), rangeWidth);
		const count = `${s.totalChanges} change${s.totalChanges === 1 ? "" : "s"}`;
		const breakdown = formatCategoryBreakdown(s.byCategory);
		lines.push(`  ${label}  ${range}  ${padRight(count, 12)}${breakdown ? "  " + breakdown : ""}`);
	}
	lines.push("");
	lines.push("Run /whats-new pi | forge-plugin | forge-cli for details. /whats-new dismiss to clear.");
	return lines.join("\n");
}

export function renderComponentDetail(summary: ChangeSummary): string {
	const heading = `What's New — ${summary.label} ${formatVersionRange(summary.fromVersion, summary.toVersion)}`;
	const lines = [heading, ""];
	for (const entry of summary.entries) {
		lines.push(`## ${entry.version}${entry.date ? ` — ${entry.date}` : ""}`);
		for (const section of entry.sections) {
			lines.push("");
			lines.push(`### ${section.name}`);
			for (const bullet of section.bullets) {
				lines.push(`- ${bullet}`);
			}
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

// ── public API for index.ts / forge-commands.ts ──────────────────────────

export interface WhatsNewRuntime {
	pkgRoot: string;
	current: CurrentVersions;
	cacheDir?: string;
}

/**
 * Compute the startup summary and, when present, update the seen state
 * so subsequent sessions don't replay. Returns the rendered string (or
 * null when there's nothing to show).
 *
 * The `prev*` fields in the seen state preserve the prior baseline so
 * /whats-new can re-render until the user explicitly dismisses.
 */
export async function computeAndPersistStartupPanel(
	rt: WhatsNewRuntime,
): Promise<{ rendered: string; summaries: ChangeSummary[] } | null> {
	const cacheDir = rt.cacheDir ?? defaultCacheDir();
	const seen = await readSeenState(cacheDir);
	const sources = resolveChangelogPaths(rt.pkgRoot);
	const summaries = computeSummaries({ sources, current: rt.current, seen, baseline: "seen" });
	if (summaries.length === 0) return null;
	const findFrom = (id: ComponentId): string | null =>
		summaries.find((s) => s.component === id)?.fromVersion ?? null;
	const next: SeenState = {
		pi: rt.current.pi,
		forgePlugin: rt.current.forgePlugin,
		forgeCli: rt.current.forgeCli,
		// Preserve old prev baseline if present; otherwise snapshot what was seen.
		prevPi: seen.prevPi ?? seen.pi,
		prevForgePlugin: seen.prevForgePlugin ?? seen.forgePlugin,
		prevForgeCli: seen.prevForgeCli ?? seen.forgeCli,
		// Freeze the just-shown `from` baseline so /whats-new can replay this
		// exact set even after the user dismisses (which collapses prev).
		lastShownFromPi: findFrom("pi") ?? seen.lastShownFromPi,
		lastShownFromForgePlugin: findFrom("forge-plugin") ?? seen.lastShownFromForgePlugin,
		lastShownFromForgeCli: findFrom("forge-cli") ?? seen.lastShownFromForgeCli,
		lastShownAt: Date.now(),
	};
	try {
		await writeSeenState(cacheDir, next);
	} catch (err) {
		debug("writeSeenState failed:", err);
	}
	return { rendered: renderSummaryPanel(summaries), summaries };
}

/**
 * Re-compute summaries against the `prev*` baseline (so users can replay
 * the panel after auto-dismiss). When `componentArg` matches one of the
 * three component IDs, returns that component's full detail view instead.
 */
export async function computeWhatsNewView(
	rt: WhatsNewRuntime,
	componentArg: string | null,
): Promise<string> {
	const cacheDir = rt.cacheDir ?? defaultCacheDir();
	const seen = await readSeenState(cacheDir);
	const sources = resolveChangelogPaths(rt.pkgRoot);
	// Prefer the prev baseline (post auto-dismiss, pre explicit dismiss); fall
	// back to the lastShown frozen baseline so dismissed users can still
	// re-read what was last shown to them.
	let summaries = computeSummaries({ sources, current: rt.current, seen, baseline: "prev" });
	if (summaries.length === 0) {
		summaries = computeSummaries({ sources, current: rt.current, seen, baseline: "lastShown" });
	}
	if (componentArg && componentArg !== "summary") {
		const wanted = componentArg.toLowerCase();
		const match = summaries.find((s) => s.component === wanted || s.label === wanted);
		if (!match) {
			return `whats-new: no recent changes for "${componentArg}". Components: ${COMPONENT_ORDER.join(", ")}.`;
		}
		return renderComponentDetail(match);
	}
	return renderSummaryPanel(summaries);
}

/**
 * Clear the `prev*` baseline so /whats-new stops replaying past changes.
 * Current `seen` values are left untouched.
 */
export async function dismissWhatsNew(rt: WhatsNewRuntime): Promise<string> {
	const cacheDir = rt.cacheDir ?? defaultCacheDir();
	const seen = await readSeenState(cacheDir);
	const next: SeenState = {
		...seen,
		prevPi: seen.pi,
		prevForgePlugin: seen.forgePlugin,
		prevForgeCli: seen.forgeCli,
	};
	try {
		await writeSeenState(cacheDir, next);
	} catch (err) {
		debug("writeSeenState (dismiss) failed:", err);
	}
	return "whats-new: dismissed.";
}

// Slash-command registration lives in whats-new-widget.ts (it owns the
// interactive surface). This module remains the pure parser + state +
// computer used by both the widget and the slash handler.

export const __test__ = {
	defaultCacheDir,
	cachePath,
	normalizeCategory,
	formatCategoryBreakdown,
	formatVersionRange,
};
