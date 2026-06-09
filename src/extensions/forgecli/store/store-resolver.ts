// store-resolver.ts — Shared store-cli resolver for `@path` / canonical ID /
// ID-suffix / keyword / NLP cascade. Used by /forge:read, /forge:run-task,
// /forge:run-sprint, /forge:fix-bug, and (eventually) /forge:plan,
// /forge:implement ports. Co-locates the spawn helper, regex constants, and
// the multi-result picker so future ports do not drift from the canonical
// cascade.

import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileAsync } from "../lib/exec-helpers.js";
import { isDirectory } from "../lib/shared-fs-utils.js";

export const ENTITY_TYPES = new Set(["task", "sprint", "bug", "feature"]);

export const ID_PATTERNS = {
	task: /^([A-Z0-9]+-)?S\d+-T\d+$/i,
	sprint: /^([A-Z0-9]+-)?S\d+$/i,
	bug: /^([A-Z0-9]+-)?B\d+$/i,
	feature: /^([A-Z0-9]+-)?F\d+$/i,
	bareTask: /^T\d+$/i,
	idFragment: /^(S|B|F|T)\d+(-T\d+)?$/i,
};

// Fully-qualified IDs carry a real project prefix segment *before* the S/B/F/T
// token (e.g. "CART-S01-T01"). Bare fragments like "S01-T01" or "S01" are NOT
// fully-qualified — they must fall through to suffix matching for
// prefix-normalization. Treating "S01-T01" as canonical (the old behaviour)
// hard-failed before suffix matching could resolve it to "CART-S01-T01".
export const FQ_ID_PATTERNS = {
	task: /^[A-Z0-9]+-S\d+-T\d+$/i,
	sprint: /^[A-Z0-9]+-S\d+$/i,
	bug: /^[A-Z0-9]+-B\d+$/i,
	feature: /^[A-Z0-9]+-F\d+$/i,
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
	return isDirectory(nested) ? nested : forgeRoot;
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
		throw new Error(`store-cli returned non-JSON for argv=${JSON.stringify(argv)}: ${result.stdout.slice(0, 200)}`);
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
	const nonInteractive = process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
	if (nonInteractive) {
		ctx.ui.notify(`Multiple records match "${arg}" — refusing to pick in non-interactive mode`, "error");
		return null;
	}
	const options = items.map((t: any, i: number) => `[${i}] ${t.id} (${t.type}): ${t.title}`);
	const selection = await ctx.ui.select(`Multiple records found for "${arg}". Select one:`, options);
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
 * Expand a sprint-shaped arg (fragment "S01" or fully-qualified "CART-S01")
 * into the list of tasks belonging to the matching sprint(s), in the picker
 * shape ({ id, type, title, status }). Used when the caller wants a task but
 * supplied a sprint reference (e.g. `/forge:run-task S01`) — we surface the
 * sprint's tasks for selection rather than (incorrectly) running the sprint
 * record as if it were a task.
 */
export async function tasksForSprintArg(toolDir: string, cwd: string, arg: string): Promise<any[]> {
	const upper = arg.toUpperCase();

	// Resolve the canonical sprint id(s) the arg refers to.
	let sprintIds: string[] = [];
	if (FQ_ID_PATTERNS.sprint.test(arg)) {
		sprintIds = [upper];
	} else {
		const fast = await suffixMatch(toolDir, cwd, "sprint", upper);
		if (fast && fast.length > 0) {
			sprintIds = fast.map((s: any) => s.id).filter(Boolean);
		} else {
			try {
				const r = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
				sprintIds = (r?.results ?? [])
					.filter((s: any) => s.id?.toUpperCase().endsWith(`-${upper}`) || s.id?.toUpperCase() === upper)
					.map((s: any) => s.id);
			} catch (err: any) {
				if (isDebug()) console.error(`[forge:resolver] list-sprints failed: ${err.message}`);
			}
		}
	}

	const tasks: any[] = [];
	for (const sid of sprintIds) {
		try {
			const list = await runStoreCli(toolDir, ["list", "task", `sprintId=${sid}`], cwd);
			const arr = Array.isArray(list) ? list : (list?.results ?? []);
			for (const t of arr) {
				const id = t.taskId ?? t.id;
				if (id) tasks.push({ id, type: "task", title: t.title, status: t.status });
			}
		} catch (err: any) {
			if (isDebug()) console.error(`[forge:resolver] list tasks failed for ${sid}: ${err.message}`);
		}
	}
	return tasks;
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

	const wantTask = entityTypes.has("task");
	const wantSprint = entityTypes.has("sprint");

	// A sprint reference ("S01" or "CART-S01") when the caller wants a *task*
	// (e.g. `/forge:run-task S01`) must NOT resolve to the sprint record. Expand
	// the sprint into its task list and let the user pick. Done before the
	// structured/canonical handling so a fully-qualified sprint id is expanded
	// too — never run as a task.
	const isSprintShaped = ID_PATTERNS.sprint.test(arg) && !ID_PATTERNS.task.test(arg);
	if (isSprintShaped && wantTask && !wantSprint) {
		setStatus(`Listing tasks in sprint ${arg}…`);
		const sprintTasks = await tasksForSprintArg(toolDir, cwd, arg);
		if (sprintTasks.length > 0) return pick(sprintTasks);
		// No tasks under the sprint → fall through to keyword/NLP / error.
	}

	// ── 2. Canonical structured ID ────────────────────────────────────────────
	// Only a fully-qualified id (project prefix present) is treated as canonical;
	// bare fragments fall through to suffix matching for prefix-normalization.
	const isFullyQualified =
		FQ_ID_PATTERNS.task.test(arg) ||
		FQ_ID_PATTERNS.bug.test(arg) ||
		FQ_ID_PATTERNS.feature.test(arg) ||
		FQ_ID_PATTERNS.sprint.test(arg);
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

	// Honour the requested entity types: never return a record whose type was
	// not asked for (e.g. a sprint when a task was requested).
	const structuredHits = filterEntities(structuredResult?.results ?? [], entityTypes);
	if (structuredHits.length > 0) {
		return pick(structuredHits);
	}

	if (isFullyQualified) {
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

			// Sprint-shaped fragment (e.g. "S01") when a sprint is wanted: native
			// sprint-suffix first, fall back to list-and-filter. (When a *task* is
			// wanted, sprint fragments were already expanded to their task list
			// above.)
			if (isSprintShaped && wantSprint) {
				const fast = await suffixMatch(toolDir, cwd, "sprint", suffix);
				if (fast && fast.length > 0) return pick(fast);
				if (fast === null) {
					const r = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
					const matched = (r?.results ?? []).filter(
						(s: any) => s.id?.toUpperCase().endsWith(`-${suffix}`) || s.id?.toUpperCase() === suffix,
					);
					if (matched.length > 0) {
						const canonical: any[] = [];
						for (const s of matched) {
							try {
								const rr = await runStoreCli(toolDir, ["query", "--sprint", s.id], cwd);
								canonical.push(...(rr?.results ?? []));
							} catch (err: any) {
								if (isDebug())
									console.error(`[forge:resolver] sprint lookup failed for ${s.id}: ${err.message}`);
							}
						}
						if (canonical.length > 0) return pick(canonical);
					}
				}
			}

			// Task-shaped fragment (e.g. "T01" or "S01-T01") when a task is wanted:
			// native task-suffix first; fall back to N sprint × Tnn loop. The FULL
			// fragment is used as the suffix so "S01-T01" matches only
			// "CART-S01-T01" (endsWith "-S01-T01"), while bare "T01" still matches
			// every task ending in T01 (→ picker).
			if (wantTask && (ID_PATTERNS.task.test(arg) || ID_PATTERNS.bareTask.test(arg))) {
				const fast = await suffixMatch(toolDir, cwd, "task", suffix);
				if (fast && fast.length > 0) return pick(fast);
				if (fast === null) {
					// Legacy store-cli without --task-suffix: reconstruct candidate ids.
					const tOnly = suffix.match(/T\d+$/i)?.[0] ?? suffix;
					const sPart = ID_PATTERNS.bareTask.test(arg) ? null : suffix.split("-")[0];
					const r = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
					for (const s of r?.results ?? []) {
						const sid = s.id?.toUpperCase() ?? "";
						if (sPart && !(sid.endsWith(`-${sPart}`) || sid === sPart)) continue;
						try {
							const taskId = `${s.id}-${tOnly}`;
							const rr = await runStoreCli(toolDir, ["query", "--task", taskId], cwd);
							if (rr?.results?.length > 0) return pick(rr.results);
						} catch (err: any) {
							if (isDebug())
								console.error(`[forge:resolver] task lookup failed for ${s.id}-${tOnly}: ${err.message}`);
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

// ── Convenience: resolve to canonical ID string ─────────────────────────────
//
// Used by command handlers (run-task, run-sprint, fix-bug) to turn a raw
// user-supplied arg (which may be missing a project prefix, be a fragment,
// or be a keyword) into the canonical ID that the rest of the pipeline
// expects (e.g. "S22-T03" → "FORGE-S22-T03").
//
// Returns the canonical ID string, or null with an actionable error already
// emitted via ctx.ui.notify.

export interface ResolveToCanonicalIdOptions {
	/** Which entity types to search. Defaults to a single-element set matching `kind`. */
	entityTypes?: Set<string>;
	/** Command label used in error messages (e.g. "forge:run-task"). */
	commandLabel?: string;
}

/**
 * Resolve a raw user arg to a canonical entity ID string.
 *
 * 1. If the arg is already a canonical ID that resolves directly → return it.
 * 2. If the arg is an unprefixed ID (e.g. "S22-T03") → suffix-match or
 *    prefix-normalize to the canonical form → return it.
 * 3. If the arg is ambiguous → prompt the user (or hard-fail in non-interactive).
 * 4. If the arg cannot be resolved → emit an actionable error and return null.
 */
export async function resolveToCanonicalId(
	arg: string,
	toolDir: string,
	cwd: string,
	kind: "task" | "sprint" | "bug" | "feature",
	opts: ResolveToCanonicalIdOptions & { ctx?: ExtensionCommandContext },
): Promise<string | null> {
	const { ctx, entityTypes = new Set([kind]), commandLabel = `forge:${kind}` } = opts;

	const resolved = await resolveEntityRef(arg, toolDir, cwd, {
		entityTypes,
		ctx,
		statusLabel: `${commandLabel}: resolving`,
	});

	if (!resolved) {
		ctx?.ui.notify(
			`× ${commandLabel} — could not resolve "${arg}". ` +
				`No matching ${kind} found. ` +
				`Try a canonical ID like <PREFIX>-S<N>-T<N> or use /forge:read for search.`,
			"error",
		);
		return null;
	}

	if ("dir" in resolved) {
		// @path resolution — not a task/sprint/bug ID pattern.
		ctx?.ui.notify(
			`× ${commandLabel} — "${arg}" resolved to a directory path, not a ${kind} ID. ` +
				`Provide a canonical ${kind} ID instead.`,
			"error",
		);
		return null;
	}

	// Defence in depth: never hand back a record whose type was not requested
	// (e.g. a sprint when run-task asked for a task). The cascade should already
	// honour entityTypes, but a stray match must never be run through the wrong
	// pipeline.
	const resolvedType = resolved.item?.type;
	if (resolvedType && !entityTypes.has(resolvedType)) {
		ctx?.ui.notify(
			`× ${commandLabel} — "${arg}" matched a ${resolvedType} (${resolved.item?.id}), but a ${kind} is required.`,
			"error",
		);
		return null;
	}

	const canonicalId = resolved.item?.id;
	if (!canonicalId || typeof canonicalId !== "string") {
		ctx?.ui.notify(`× ${commandLabel} — resolved "${arg}" but record has no canonical ID.`, "error");
		return null;
	}

	// If the canonical ID differs from the raw arg, notify the user.
	if (canonicalId !== arg) {
		ctx?.ui.notify(`ℹ ${commandLabel} — resolved "${arg}" → ${canonicalId}`, "info");
	}

	return canonicalId;
}
