// init-phases.ts — shared constants for the /forge:init pipeline.
//
// FORGE-S35-T02 (Slice 1) retired the coarse `INIT_PHASES` descriptor table,
// `initPhaseByName`, and `initPhaseIndexByName`: the flat step machine
// (init-steps.ts + the INIT_STEPS table in run-init-pipeline.ts) fully subsumes
// the intra-phase routing they encoded. Keeping them as inert data would drift
// from the step model and mislead downstream slices, so they were deleted.
//
// This module now only re-exports the init-wide constants (DOMAINS, KB_DOC_IDS,
// ROLE_TIER, schemas) plus the synthetic session id, so callers that import
// from init-phases.ts keep a single import site.

import {
	DOMAINS,
	KB_DOC_IDS,
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
