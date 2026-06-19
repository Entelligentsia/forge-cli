// init-phases.ts — phase descriptor table for the /forge:init pipeline.
// Scaffolded by FORGE-S33-T01.
//
// Shape mirrors orchestrators/task/task-phases.ts (PhaseDescriptor) but
// extended with init-specific fields (kind, domains/docIds, schema, verifyFn,
// retryCap). Dispatcher logic lives in T02 (init-phase-dispatch.ts).

import {
	DISCOVERY_SCHEMA,
	DOMAINS,
	KB_DOC_IDS,
	KB_DOC_SCHEMA,
	OK_SCHEMA,
	PHASE_RESULT_SCHEMA,
	ROLE_TIER,
} from "./run-init-types.js";

// Re-export constants so callers that only import from init-phases.ts get
// everything they need without extra imports.
export { DOMAINS, KB_DOC_IDS, ROLE_TIER };

/**
 * Synthetic session/orchestrator id for the /forge:init run. `/forge:init` is
 * not a store entity, so it has no taskId/bugId — this stable id is the key in
 * SessionRegistry + OrchestratorTree that the always-mounted chip strip and the
 * /forge:dashboard overlay render from (parity with run-task using its taskId).
 */
export const INIT_SESSION_ID = "forge-init";

// ── Phase kinds ──────────────────────────────────────────────────────────────

/**
 * Execution strategy for an init phase.
 * - `subagent_fanout` — spawn N parallel subagents (one per domain/docId).
 * - `subagent_single` — spawn exactly one subagent.
 * - `deterministic`   — run local tool invocations; no LLM subagent.
 */
export type InitPhaseKind = "subagent_fanout" | "subagent_single" | "deterministic";

// ── Phase descriptor ──────────────────────────────────────────────────────────

/**
 * Descriptor for a single /forge:init phase.
 * Mirrors PhaseDescriptor from orchestrators/task/task-phases.ts, extended with
 * init-specific fields.
 */
export interface InitPhaseDescriptor {
	/** Human label (also used as the phase key for checkpoints). */
	name: string;
	/** Execution strategy — drives dispatcher behaviour in T02. */
	kind: InitPhaseKind;
	/**
	 * For `subagent_fanout` phases: the items to fan out over.
	 * Phase 1 (collect) uses `domains`; Phase 2 (discover) uses `docIds`.
	 */
	domains?: readonly string[];
	docIds?: readonly string[];
	/** Persona noun for persona-load (LLM phases only). */
	persona?: string;
	/** Key into ROLE_TIER for model resolution (LLM phases only). */
	modelRole?: string;
	/** TypeBox schema passed to runForgeSubagent (LLM phases only). */
	schema?: object;
	/** Name of the verify function (matches export in verifiers.ts, T02+). */
	verifyFn?: "verifyPhase1" | "verifyPhase2" | "verifyPhase3";
	/**
	 * Maximum retry count.
	 * 0 = hard-halt on first failure (no retry);
	 * 1 = retry once before halting.
	 */
	retryCap: number;
}

// ── Phase table ───────────────────────────────────────────────────────────────
//
// Four entries matching the phases declared in wfl-init.js meta.phases:
//   Collect / Discover / Materialize / Register
//
// Intra-phase routing (e.g. config-writer sub-step in Phase 1, gate+scaffold
// + index + context sub-steps in Phase 2) is deferred to T02
// (init-phase-dispatch.ts); the table captures coarse phase shape only.

export const INIT_PHASES: InitPhaseDescriptor[] = [
	{
		name: "collect",
		kind: "subagent_fanout",
		domains: DOMAINS,
		persona: "engineer",
		modelRole: "discovery",
		schema: DISCOVERY_SCHEMA,
		verifyFn: "verifyPhase1",
		retryCap: 1,
	},
	{
		name: "discover",
		kind: "subagent_fanout",
		docIds: KB_DOC_IDS,
		persona: "engineer",
		modelRole: "kb-doc",
		schema: KB_DOC_SCHEMA,
		verifyFn: "verifyPhase2",
		retryCap: 1,
	},
	{
		name: "materialize",
		kind: "deterministic",
		modelRole: "materialize",
		schema: PHASE_RESULT_SCHEMA,
		verifyFn: "verifyPhase3",
		retryCap: 0,
	},
	{
		name: "register",
		kind: "deterministic",
		modelRole: "register",
		schema: OK_SCHEMA,
		retryCap: 0,
	},
];

/** Look up a phase descriptor by name, or undefined if not found. */
export function initPhaseByName(name: string): InitPhaseDescriptor | undefined {
	return INIT_PHASES.find((p) => p.name === name);
}

/** Index of a phase in INIT_PHASES by name, or -1 if not found. */
export function initPhaseIndexByName(name: string): number {
	return INIT_PHASES.findIndex((p) => p.name === name);
}
