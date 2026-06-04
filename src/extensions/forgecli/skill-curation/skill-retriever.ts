// Skill retriever — FORGE-S24-T08.
//
// BM25-ranked retrieval over the project's skill corpus using `lunr.js`
// (exact-pinned in package.json). Each retrieval emits one `skill_usage`
// event per top-k hit with `retrieved: true` and a populated, [0,1]-clamped
// `retrieval_score`. Conforms to the canonical event schema variant landed
// in FORGE-S24-T01 (plugin v0.45.0).
//
// Iron Laws (forge-cli-engineer):
//   IL2  — TypeScript + TypeBox. Schemas defined here; runtime input is
//          validated by `Value.Parse(...)` at the public entry points.
//   IL6  — No raw shell-string interpolation. `emitSkillUsageEvents` calls
//          `spawnSync("node", [storeCli, "emit", sprintId, JSON.stringify(event)])`
//          — argv array, no shell.
//   IL7  — No silent continuation past failures. A non-zero `store-cli emit`
//          exit increments the `failed` counter and the stderr text is
//          forwarded to the caller in the returned result; nothing is
//          swallowed.
//   IL10 — This module is a primitive consumed by orchestrator code. The
//          orchestrator/caller supplies the runtime attribution
//          (model/provider/timestamps/durationMinutes) — never fabricated
//          here.
//
// Scope boundary: this module owns ranking + emission. It does NOT crawl
// the filesystem for skills; corpus construction (reading SKILL.md
// frontmatter via `loaders/persona-skill-loader.ts`) is the caller's
// responsibility. Keeping IO out of the retriever keeps the module
// deterministic and trivially unit-testable.

import lunr from "lunr";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { spawnStoreCliEmit } from "../lib/spawn-store-cli.js";
import { isSkillCurationEnabled } from "./skill-curation-flag.js";

// ── Public schemas ───────────────────────────────────────────────────────

/**
 * One skill in the retrieval corpus. `frontmatter` is the parsed YAML head
 * of the SKILL.md file (matches `loaders/persona-skill-loader.ts` Skill shape
 * for `frontmatter` field). Only `description` plus selected frontmatter
 * fields are indexed — the body is intentionally excluded to keep the index
 * small and keyword-focused.
 */
export const RetrievableSkillSchema = Type.Object({
	skillId: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	description: Type.String(),
	frontmatter: Type.Record(Type.String(), Type.Unknown()),
});
export type RetrievableSkill = Static<typeof RetrievableSkillSchema>;

export const RetrievalHitSchema = Type.Object({
	skillId: Type.String({ minLength: 1 }),
	score: Type.Number(),
});
export type RetrievalHit = Static<typeof RetrievalHitSchema>;

/**
 * Runtime attribution supplied by the caller (orchestrator).
 * These are NEVER fabricated inside the retriever (IL10).
 */
export const EmitRuntimeSchema = Type.Object({
	storeCli: Type.String({ minLength: 1 }),
	cwd: Type.String({ minLength: 1 }),
	sprintId: Type.String({ minLength: 1 }),
	taskId: Type.String({ minLength: 1 }),
	role: Type.String({ minLength: 1 }),
	action: Type.String({ minLength: 1 }),
	phase: Type.Optional(Type.String()),
	iteration: Type.Optional(Type.Integer({ minimum: 1 })),
	startTimestamp: Type.String({ format: "date-time" }),
	endTimestamp: Type.String({ format: "date-time" }),
	durationMinutes: Type.Number({ minimum: 0 }),
	model: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
});
export type EmitRuntime = Static<typeof EmitRuntimeSchema>;

export interface EmitResult {
	emitted: number;
	failed: number;
	stderrs: string[];
}

// ── Index ────────────────────────────────────────────────────────────────

/**
 * Opaque handle returned by `buildSkillIndex`. Internally pairs the lunr
 * index with the corpus so `retrieveTopK` can return the original skillIds.
 */
export interface SkillIndex {
	readonly _index: lunr.Index;
	readonly _byRef: Map<string, RetrievableSkill>;
}

/** Join indexable frontmatter fields (tags + name) into a single string. */
function frontmatterText(fm: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof fm.name === "string") parts.push(fm.name);
	const tags = fm.tags;
	if (Array.isArray(tags)) {
		for (const t of tags) if (typeof t === "string") parts.push(t);
	}
	const aliases = fm.aliases;
	if (Array.isArray(aliases)) {
		for (const a of aliases) if (typeof a === "string") parts.push(a);
	}
	return parts.join(" ");
}

/**
 * Build a BM25 index over the supplied corpus. Indexed fields:
 *   - `name`        (boost 4) — the skill identifier itself
 *   - `description` (boost 2) — primary intent text
 *   - `frontmatter` (boost 1) — tags / aliases
 *
 * lunr's default scoring is Okapi BM25.
 */
export function buildSkillIndex(corpus: readonly RetrievableSkill[]): SkillIndex {
	for (const s of corpus) Value.Parse(RetrievableSkillSchema, s);

	const byRef = new Map<string, RetrievableSkill>();
	for (const s of corpus) byRef.set(s.skillId, s);

	const index = lunr(function (this: lunr.Builder) {
		this.ref("skillId");
		this.field("name", { boost: 4 });
		this.field("description", { boost: 2 });
		this.field("frontmatter", { boost: 1 });

		// Determinism: lunr's pipeline is deterministic by construction; we do
		// not register custom plugins or randomised tokenisers.
		for (const s of corpus) {
			this.add({
				skillId: s.skillId,
				name: s.name,
				description: s.description,
				frontmatter: frontmatterText(s.frontmatter),
			});
		}
	});

	return { _index: index, _byRef: byRef };
}

// ── Retrieval ────────────────────────────────────────────────────────────

/**
 * Tokenise the query for lunr. We lower-case, strip non-alphanumerics, and
 * drop empties. Avoids lunr's query-language operators (`:`, `^`, `~`,
 * `+`, `-`, `*`) leaking from natural-language task descriptions.
 */
function safeQueryTokens(query: string): string[] {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9\s]+/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/**
 * Return the top-k skills by BM25 score for the given query. Deterministic
 * for fixed (corpus, query) pairs. Returns `[]` when no token in the query
 * is present in any indexed field.
 */
export function retrieveTopK(index: SkillIndex, query: string, k: number): RetrievalHit[] {
	if (!Number.isInteger(k) || k <= 0) {
		throw new Error(`retrieveTopK: k must be a positive integer, got ${k}`);
	}
	const tokens = safeQueryTokens(query);
	if (tokens.length === 0) return [];

	let results: lunr.Index.Result[];
	try {
		results = index._index.query((q) => {
			for (const t of tokens) {
				q.term(t, { usePipeline: true, boost: 1 });
			}
		});
	} catch {
		// lunr throws on a small set of malformed inputs; treat as no hits
		// rather than propagating an opaque error into the orchestrator.
		return [];
	}

	const hits: RetrievalHit[] = [];
	for (const r of results) {
		if (hits.length >= k) break;
		if (!index._byRef.has(r.ref)) continue;
		hits.push({ skillId: r.ref, score: r.score });
	}
	return hits;
}

// ── Emission ─────────────────────────────────────────────────────────────

/**
 * Clamp a raw BM25 score into the [0,1] window required by the event
 * schema (`retrieval_score`). BM25 scores are unbounded above; we apply
 * `s / (1 + s)` so the relative ordering is preserved while the absolute
 * value is monotonically squashed into (0,1). Negative scores (lunr never
 * produces these in practice) clamp to 0.
 */
export function clampRetrievalScore(rawScore: number): number {
	if (!Number.isFinite(rawScore) || rawScore <= 0) return 0;
	const squashed = rawScore / (1 + rawScore);
	if (squashed >= 1) return 1;
	return squashed;
}

/** Compose an ISO-compact timestamp segment for the eventId. */
function isoCompact(iso: string): string {
	return iso.replace(/[-:.]/g, "").replace(/Z$/, "Z");
}

/**
 * Emit one `skill_usage` event per supplied hit via
 * `node <storeCli> emit <sprintId> <json>`. Returns the (emitted, failed)
 * counts. Never throws on subprocess failure — the failure is surfaced via
 * the returned counter and stderr text (IL7 — explicit, not silent).
 */
export function emitSkillUsageEvents(hits: readonly RetrievalHit[], runtime: EmitRuntime): EmitResult {
	// FORGE-S24-T12 — gated rollout. Default off ⇒ zero events, zero
	// subprocess calls, byte-identical to pre-FORGE-S24 behaviour.
	if (!isSkillCurationEnabled(runtime.cwd)) {
		return { emitted: 0, failed: 0, stderrs: [] };
	}

	Value.Parse(EmitRuntimeSchema, runtime);

	let emitted = 0;
	let failed = 0;
	const stderrs: string[] = [];

	for (let i = 0; i < hits.length; i++) {
		const hit = hits[i];
		const eventId = `${isoCompact(runtime.startTimestamp)}_${runtime.taskId}_skill-retriever_skill_usage_${i}_${hit.skillId}`;

		const event: Record<string, unknown> = {
			eventId,
			sprintId: runtime.sprintId,
			taskId: runtime.taskId,
			role: runtime.role,
			action: runtime.action,
			startTimestamp: runtime.startTimestamp,
			endTimestamp: runtime.endTimestamp,
			durationMinutes: runtime.durationMinutes,
			model: runtime.model,
			provider: runtime.provider,
			type: "skill_usage",
			skillId: hit.skillId,
			retrieved: true,
			used: false,
			// No tool calls have happened yet at retrieval time. T09 (usage
			// tracker) will later emit a follow-up event with the observed
			// success rate.
			tool_call_success_rate: 0,
			retrieval_score: clampRetrievalScore(hit.score),
		};
		if (runtime.phase !== undefined) event.phase = runtime.phase;
		if (runtime.iteration !== undefined) event.iteration = runtime.iteration;

		// FORGE-S25-T17: adopt spawnStoreCliEmit; adds missing 10 s timeout (N-C-A).
		const emitResult = spawnStoreCliEmit(runtime.storeCli, runtime.sprintId, event, runtime.cwd);
		if (emitResult.ok) {
			emitted++;
		} else {
			failed++;
			stderrs.push(emitResult.stderr);
		}
	}

	return { emitted, failed, stderrs };
}
