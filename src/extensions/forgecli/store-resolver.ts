// store-resolver.ts — Shared store-cli resolver for `@path` / canonical ID /
// ID-suffix / keyword / NLP cascade. Used by /forge:read and (eventually)
// /forge:plan, /forge:implement, /forge:fix-bug ports. Co-locates the spawn
// helper, regex constants, and the multi-result picker so future ports do not
// drift from the canonical cascade.

import * as fsSync from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

export const ENTITY_TYPES = new Set(["task", "sprint", "bug", "feature"]);

export const ID_PATTERNS = {
	task: /^([A-Z0-9]+-)?S\d+-T\d+$/i,
	sprint: /^([A-Z0-9]+-)?S\d+$/i,
	bug: /^([A-Z0-9]+-)?B\d+$/i,
	feature: /^([A-Z0-9]+-)?F\d+$/i,
	bareTask: /^T\d+$/i,
	idFragment: /^(S|B|F|T)\d+(-T\d+)?$/i,
};

export type ResolverHit = { dir: string } | { item: any };

export interface ResolveOptions {
	entityTypes?: Set<string>;
	ctx?: ExtensionCommandContext;
	statusLabel?: string;
}

export function isDebug(): boolean {
	return process.env.FORGE_DEBUG === "1";
}

export function resolveToolDir(forgeRoot: string): string {
	const nested = path.join(forgeRoot, "tools");
	try {
		if (fsSync.statSync(nested).isDirectory()) return nested;
	} catch {
		// nested missing — fall through to flat
	}
	return forgeRoot;
}

export async function runStoreCli(toolDir: string, argv: string[], cwd: string): Promise<any> {
	const toolPath = path.join(toolDir, "store-cli.cjs");
	const timeout = argv[0] === "nlp" ? 30_000 : 10_000;
	const result = await execFileAsync("node", [toolPath, ...argv], {
		cwd,
		encoding: "utf8",
		timeout,
	});
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(
			`store-cli returned non-JSON for argv=${JSON.stringify(argv)}: ${result.stdout.slice(0, 200)}`,
		);
	}
}

function filterEntities(rs: any[], entityTypes: Set<string>): any[] {
	return rs.filter((r: any) => entityTypes.has(r.type));
}

async function pickFromResults(
	items: any[],
	arg: string,
	ctx: ExtensionCommandContext,
	statusLabel: string,
): Promise<{ item: any } | null> {
	if (items.length === 1) return { item: items[0] };

	ctx.ui.setStatus(statusLabel, undefined);
	const nonInteractive =
		process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
	if (nonInteractive) {
		ctx.ui.notify(
			`Multiple records match "${arg}" — refusing to pick in non-interactive mode`,
			"error",
		);
		return null;
	}
	const options = items.map((t: any, i: number) => `[${i}] ${t.id} (${t.type}): ${t.title}`);
	const selection = await ctx.ui.select(
		`Multiple records found for "${arg}". Select one:`,
		options,
	);
	if (!selection) return null;
	const idx = parseInt(selection.match(/^\[(\d+)\]/)?.[1] ?? "-1", 10);
	if (idx < 0 || idx >= items.length) return null;
	return { item: items[idx] };
}

/**
 * Try store-cli's native --task-suffix / --sprint-suffix flags. Returns:
 *   - results array on success
 *   - null if the flag is unsupported (older store-cli) — caller should fall back
 */
export async function suffixMatch(
	toolDir: string,
	cwd: string,
	kind: "task" | "sprint",
	suffix: string,
): Promise<any[] | null> {
	const flag = kind === "task" ? "--task-suffix" : "--sprint-suffix";
	try {
		const r = await runStoreCli(toolDir, ["query", flag, suffix], cwd);
		if (r && Array.isArray(r.results) && r.path === "suffix") return r.results;
		// store-cli ran but didn't take the suffix path → treat as unsupported.
		return null;
	} catch (err: any) {
		if (isDebug()) console.error(`[forge:resolver] suffix flag failed: ${err.message}`);
		return null;
	}
}

/**
 * Resolution cascade:
 *   1. @path        → use the path directly as artifact directory
 *   2. Canonical ID → store-cli query --task/--bug/--feature/--sprint
 *   3. ID suffix    → --task-suffix / --sprint-suffix (one call) with loop fallback
 *   4. Keyword      → store-cli query --keyword (title substring)
 *   5. NLP fallback → store-cli nlp "<query>"
 */
export async function resolveEntityRef(
	arg: string,
	toolDir: string,
	cwd: string,
	opts: ResolveOptions = {},
): Promise<ResolverHit | null> {
	const ctx = opts.ctx;
	const statusLabel = opts.statusLabel ?? "forge:resolve";
	const entityTypes = opts.entityTypes ?? ENTITY_TYPES;
	const setStatus = (msg: string | undefined) => ctx?.ui.setStatus(statusLabel, msg);
	const pick = (items: any[]) =>
		ctx ? pickFromResults(items, arg, ctx, statusLabel) : Promise.resolve({ item: items[0] });

	// ── 1. @path ──────────────────────────────────────────────────────────────
	if (arg.startsWith("@")) {
		const rawPath = arg.slice(1).trim();
		const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
		return { dir: resolved };
	}

	// ── 2. Canonical structured ID ────────────────────────────────────────────
	const isCanonical =
		/^[A-Z0-9]+-/i.test(arg) &&
		(ID_PATTERNS.task.test(arg) ||
			ID_PATTERNS.bug.test(arg) ||
			ID_PATTERNS.feature.test(arg) ||
			ID_PATTERNS.sprint.test(arg));
	let structuredResult: any | null = null;
	try {
		if (ID_PATTERNS.task.test(arg)) {
			setStatus(`Looking up task ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--task", arg], cwd);
		} else if (ID_PATTERNS.bug.test(arg)) {
			setStatus(`Looking up bug ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--bug", arg], cwd);
		} else if (ID_PATTERNS.feature.test(arg)) {
			setStatus(`Looking up feature ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--feature", arg], cwd);
		} else if (ID_PATTERNS.sprint.test(arg)) {
			setStatus(`Looking up sprint ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--sprint", arg], cwd);
		}
	} catch (err: any) {
		if (isDebug()) console.error(`[forge:resolver] structured query failed: ${err.message}`);
	}

	if (structuredResult?.results?.length > 0) {
		return pick(structuredResult.results);
	}

	if (isCanonical) {
		setStatus(undefined);
		ctx?.ui.notify(`No record found for canonical ID "${arg}"`, "warning");
		return null;
	}

	// ── 3. ID suffix matching ─────────────────────────────────────────────────
	const looksLikeIdFragment = ID_PATTERNS.idFragment.test(arg);
	if (looksLikeIdFragment) {
		setStatus(`Searching for ID suffix "${arg}"…`);
		try {
			const suffix = arg.toUpperCase();

			// Sprint-shaped fragment (e.g. "S01"): native sprint-suffix first,
			// fall back to list-and-filter.
			if (ID_PATTERNS.sprint.test(arg) && !ID_PATTERNS.task.test(arg)) {
				const fast = await suffixMatch(toolDir, cwd, "sprint", suffix);
				if (fast && fast.length > 0) return pick(fast);
				if (fast === null) {
					const r = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
					const matched = (r?.results ?? []).filter((s: any) =>
						s.id?.toUpperCase().endsWith(`-${suffix}`) || s.id?.toUpperCase() === suffix,
					);
					if (matched.length > 0) {
						const canonical: any[] = [];
						for (const s of matched) {
							try {
								const rr = await runStoreCli(toolDir, ["query", "--sprint", s.id], cwd);
								canonical.push(...(rr?.results ?? []));
							} catch (err: any) {
								if (isDebug()) console.error(`[forge:resolver] sprint lookup failed for ${s.id}: ${err.message}`);
							}
						}
						if (canonical.length > 0) return pick(canonical);
					}
				}
			}

			// Task-shaped fragment (e.g. "T01" or "S01-T01"): native task-suffix
			// first; fall back to N sprint × Tnn loop.
			if (ID_PATTERNS.task.test(arg) || ID_PATTERNS.bareTask.test(arg)) {
				const tPart = ID_PATTERNS.bareTask.test(arg) ? suffix : suffix.split("-")[1];
				const fast = await suffixMatch(toolDir, cwd, "task", tPart);
				if (fast && fast.length > 0) return pick(fast);
				if (fast === null) {
					const r = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
					for (const s of r?.results ?? []) {
						try {
							const taskId = `${s.id}-${tPart}`;
							const rr = await runStoreCli(toolDir, ["query", "--task", taskId], cwd);
							if (rr?.results?.length > 0) return pick(rr.results);
						} catch (err: any) {
							if (isDebug()) console.error(`[forge:resolver] task lookup failed for ${s.id}-${tPart}: ${err.message}`);
						}
					}
				}
			}
		} catch (err: any) {
			if (isDebug()) console.error(`[forge:resolver] suffix search failed: ${err.message}`);
		}
	}

	// ── 4. Keyword search ─────────────────────────────────────────────────────
	setStatus(`Keyword search: "${arg}"…`);
	let keywordResult: any | null = null;
	try {
		keywordResult = await runStoreCli(toolDir, ["query", "--keyword", arg], cwd);
	} catch (err: any) {
		if (isDebug()) console.error(`[forge:resolver] keyword search failed: ${err.message}`);
	}
	if (keywordResult?.results?.length > 0) {
		return pick(filterEntities(keywordResult.results, entityTypes));
	}

	// ── 5. NLP fallback ───────────────────────────────────────────────────────
	setStatus(`Searching Forge store: "${arg}"…`);
	const nlpResult = await runStoreCli(toolDir, ["nlp", arg], cwd);
	const items = filterEntities(nlpResult.results || [], entityTypes);
	if (items.length === 0) {
		setStatus(undefined);
		ctx?.ui.notify(`No records found matching "${arg}"`, "warning");
		return null;
	}
	return pick(items);
}
