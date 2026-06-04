// Unit tests for phase-vocab.ts — single phase-vocabulary module (FORGE-BUG-043 PR 1).
//
// The vocabulary is forge-cli's mirror of the PLUGIN-owned catalog:
//   forge/tools/lib/artifact-kinds.cjs  → ARTIFACT_CATALOG + PHASE_TO_KIND
//   forge/tools/store-cli.cjs           → VALID_SUMMARY_PHASES
// These tests pin every entry to the catalog values so any drift between the
// governor's vocabulary and the plugin catalog fails loudly here, instead of
// silently breaking warm-tier reads / steer messages (the REVIEW_PLAN-SUMMARY
// vs REVIEW-PLAN-SUMMARY defect class — see FORGE-BUG-042/043).
//
// Coverage:
//   Catalog contract:
//     Test 1: every governed phaseKey maps to the catalog summary filename
//     Test 2: every governed phaseKey maps to the VALID_SUMMARY_PHASES key
//   Policy-table coverage:
//     Test 3: every real pipeline key in loadDefaultPolicyTable has a vocab entry
//   Unknown keys:
//     Test 4: unknown phaseKey resolves to undefined (no placeholder filenames)
//   Legacy fixtures:
//     Test 5: legacy design-time keys still resolve (test-harness compatibility)

import { describe, expect, it } from "vitest";
import { loadDefaultPolicyTable } from "../../../src/extensions/forgecli/context-governor.js";
import {
	PHASE_VOCAB,
	summaryFilenameFor,
	summaryKeyFor,
	vocabForPhaseKey,
} from "../../../src/extensions/forgecli/phase-vocab.js";

describe("phase-vocab: catalog contract (artifact-kinds.cjs)", () => {
	it("Test 1: every governed phaseKey maps to the catalog summary filename", () => {
		// Pinned to forge/tools/lib/artifact-kinds.cjs ARTIFACT_CATALOG via PHASE_TO_KIND.
		// NOTE the hyphenated REVIEW-PLAN / REVIEW-CODE spellings — the catalog names,
		// not the underscore spellings the governor previously invented.
		expect(summaryFilenameFor("engineer/plan")).toBe("PLAN-SUMMARY.json");
		expect(summaryFilenameFor("supervisor/review-plan")).toBe("REVIEW-PLAN-SUMMARY.json");
		expect(summaryFilenameFor("engineer/implement")).toBe("IMPLEMENTATION-SUMMARY.json");
		expect(summaryFilenameFor("supervisor/review-code")).toBe("REVIEW-CODE-SUMMARY.json");
		expect(summaryFilenameFor("qa-engineer/validate")).toBe("VALIDATION-SUMMARY.json");
		expect(summaryFilenameFor("architect/approve")).toBe("APPROVE-SUMMARY.json");
		expect(summaryFilenameFor("collator/writeback")).toBe("WRITEBACK-SUMMARY.json");
		expect(summaryFilenameFor("engineer/commit")).toBe("COMMIT-SUMMARY.json");
	});

	it("Test 2: every governed phaseKey maps to the VALID_SUMMARY_PHASES store key", () => {
		// Pinned to forge/tools/store-cli.cjs VALID_SUMMARY_PHASES (underscore spellings).
		expect(summaryKeyFor("engineer/plan")).toBe("plan");
		expect(summaryKeyFor("supervisor/review-plan")).toBe("review_plan");
		expect(summaryKeyFor("engineer/implement")).toBe("implementation");
		expect(summaryKeyFor("supervisor/review-code")).toBe("code_review");
		expect(summaryKeyFor("qa-engineer/validate")).toBe("validation");
		// approve IS a valid summary phase (store-cli accepts it; 67/279 store
		// records carry summaries.approve as of 2026-06-04) — the sentinel may
		// legitimately probe it even though run-task verdict-checks approve via
		// task status (run-task's SUMMARY_KEY_BY_ROLE is a verdict-SOURCE map,
		// a different concern from this vocabulary).
		expect(summaryKeyFor("architect/approve")).toBe("approve");
		// writeback/commit write no summaries entry (writeback's artifact goes
		// to disk via the collator, never through set-summary).
		expect(summaryKeyFor("collator/writeback")).toBeNull();
		expect(summaryKeyFor("engineer/commit")).toBeNull();
	});
});

describe("phase-vocab: policy-table coverage", () => {
	it("Test 3: every real pipeline key in loadDefaultPolicyTable has a vocab entry", () => {
		const table = loadDefaultPolicyTable();
		const legacyTestOnlyKeys = new Set(["architect/plan", "engineer/review", "default"]);
		for (const key of Object.keys(table)) {
			if (legacyTestOnlyKeys.has(key)) continue;
			expect(vocabForPhaseKey(key), `policy table key ${key} missing from PHASE_VOCAB`).toBeDefined();
		}
	});

	it("Test 3b: PHASE_VOCAB phaseKeys are internally consistent (personaNoun/role)", () => {
		for (const entry of PHASE_VOCAB) {
			expect(entry.phaseKey).toBe(`${entry.personaNoun}/${entry.role}`);
		}
	});
});

describe("phase-vocab: unknown keys", () => {
	it("Test 4: unknown phaseKey resolves to undefined — never a placeholder filename", () => {
		expect(vocabForPhaseKey("unknown-persona/unknown-phase")).toBeUndefined();
		expect(summaryFilenameFor("unknown-persona/unknown-phase")).toBeNull();
		expect(summaryKeyFor("unknown-persona/unknown-phase")).toBeNull();
	});
});

describe("phase-vocab: legacy design-time keys", () => {
	it("Test 5: legacy keys used by existing test fixtures still resolve", () => {
		// Kept verbatim from the pre-consolidation maps; the pipeline never
		// produces these keys, but mechanism-b/c test fixtures use them.
		expect(summaryFilenameFor("architect/plan")).toBe("PLAN-SUMMARY.json");
		expect(summaryFilenameFor("engineer/review")).toBe("REVIEW-SUMMARY.json");
		expect(summaryFilenameFor("engineer/code-review")).toBe("CODE_REVIEW-SUMMARY.json");
	});
});
