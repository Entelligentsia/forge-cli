// run-init-types.ts — pipeline option/result interfaces and TypeBox schemas
// for the /forge:init orchestrator. Scaffolded by FORGE-S33-T01.
//
// SOURCE: constants below are ported verbatim from the meta workflow at
//   forge/forge/init/base-pack/workflows-js/wfl-init.js
//   DISCOVERY_SCHEMA  — lines ~55–64
//   KB_DOC_SCHEMA     — lines ~66–75
//   PHASE_RESULT_SCHEMA — lines ~77–92
//   OK_SCHEMA         — lines ~94–101
//   ROLE_TIER         — lines ~117–126
//   DOMAINS           — line ~159 (Phase 1 fan-out array)
//   KB_DOC_IDS        — lines ~236–244 (Phase 2 fan-out array)
// Keep in sync with the meta source. When the meta changes, update here too.

import { Type } from "typebox";

// ── Options / result interfaces ──────────────────────────────────────────────

/** Input options for the /forge:init pipeline. */
export interface RunInitOptions {
	/** Absolute path to the vendored Forge root (.forge/). */
	forgeRoot: string;
	/** KB folder name (default: "engineering"). */
	kbFolder?: string;
	/**
	 * Project prefix stamped into entity ids (e.g. "FORGE"). Resolved
	 * deterministically by the handler (deriveProjectPrefix + confirm/override).
	 * When absent the pipeline derives it from projectName — never LLM-routed.
	 */
	projectPrefix?: string;
	/** Phase to start from (1–4; default: 1). */
	startPhase?: number;
	/** Whether to create CLAUDE.md at the project root. */
	createClaudeMd?: boolean | null;
	/** ISO timestamp supplied by the command wrapper (workflow sandbox blocks Date.now). */
	isoTimestamp: string;
	/** Raw CLI arguments string (passed through to subagents for context). */
	rawArguments?: string;
	/** Sprint ID for IL10 phase event emission (FORGE-S33-T03). Optional; emit skipped if absent. */
	sprintId?: string;
}

/** Structured result returned by the /forge:init pipeline. */
export interface InitReport {
	ok: boolean;
	/** Last phase that completed (1–4). */
	lastPhase: number;
	/** One-line technology stack summary (populated by Phase 1). */
	stack?: string;
	/** Skill IDs matching the project tech stack (from Phase 1 skill-recommendations). */
	skillMatches?: string[];
	/** Per-phase result objects for diagnostics. */
	counts?: Record<string, number>;
	/** 0–1 overall confidence. */
	confidence?: number;
	/** Follow-up actions for the command wrapper (e.g. ["refresh-kb-links"]). */
	pendingActions?: string[];
	/** Failure reason when ok=false. */
	failure?: string;
	/** Final KB folder path (from Phase 4 or configCache). Used by handler for the post-init report. */
	kbPathFinal?: string;
}

// ── TypeBox schemas (ported verbatim from wfl-init.js) ───────────────────────

/** Schema for each parallel discovery-agent structured output (Phase 1 fan-out). */
export const DISCOVERY_SCHEMA = Type.Object({
	domain: Type.String({ description: "discovery domain name (stack|routing|processes|database|testing)" }),
	findings: Type.Object({}, { description: "domain-specific structured findings" }),
	confidence: Type.Number({ description: "0–1 confidence in completeness of scan" }),
	warnings: Type.Optional(
		Type.Array(Type.String(), { description: "ambiguities or partial coverage notes" }),
	),
});

/** Schema for each KB-doc generation agent structured output (Phase 2 fan-out). */
export const KB_DOC_SCHEMA = Type.Object({
	id: Type.String({ description: "KB doc id matching the phase-2 table row" }),
	ok: Type.Boolean({ description: "true if doc written successfully" }),
	confidence: Type.Number({ description: "0–1 confidence in doc completeness" }),
	error: Type.Optional(Type.String({ description: "error message if ok=false" })),
});

/** Schema for the config-writer agent and the Phase 3 verify gate. */
export const PHASE_RESULT_SCHEMA = Type.Object({
	verifyExit: Type.Number({ description: "exit code from verify-phase.cjs (0=pass, non-zero=fail)" }),
	ok: Type.Boolean({ description: "true if phase completed and verify passed" }),
	verifyError: Type.Optional(
		Type.String({ description: "stderr/stdout from failed verify run" }),
	),
	stack: Type.Optional(
		Type.String({ description: "technology stack summary (Phase 1 output)" }),
	),
	skillMatches: Type.Optional(
		Type.Array(Type.String(), {
			description: "skill IDs matching project tech stack (from skill-recommendations.md)",
		}),
	),
	confidence: Type.Optional(Type.Number({ description: "0–1 confidence" })),
});

/** Schema for simple ok/error gate agents (Phase 2 gate, Phase 4 register). */
export const OK_SCHEMA = Type.Object({
	ok: Type.Boolean({ description: "true if all steps completed" }),
	error: Type.Optional(Type.String({ description: "error message if ok=false" })),
});

// ── Model tiering (ported verbatim from wfl-init.js lines ~117–126) ─────────
//
// generation/discovery → sonnet; deterministic gates and registration → haiku.
// No opus (init has no review/approve gates).

export const ROLE_TIER: Record<string, "sonnet" | "haiku"> = {
	discovery: "sonnet",
	config: "sonnet",
	"kb-doc": "sonnet",
	index: "sonnet",
	context: "sonnet",
	gate: "haiku",
	materialize: "haiku",
	register: "haiku",
};

// ── Domain / doc constants (ported verbatim from wfl-init.js) ───────────────

/** Five codebase discovery domains for Phase 1 fan-out (wfl-init.js line ~159). */
export const DOMAINS = ["stack", "routing", "processes", "database", "testing"] as const;

/** Seven KB document IDs for Phase 2 fan-out (wfl-init.js lines ~236–244). */
export const KB_DOC_IDS = [
	"architecture/stack",
	"architecture/processes",
	"architecture/routing",
	"architecture/database",
	"architecture/testing",
	"business-domain/domain-model",
	"business-domain/domain-concepts",
] as const;
