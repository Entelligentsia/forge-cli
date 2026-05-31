// phase-guard.test.ts — FORGE-BUG-040 regression coverage.
//
// Covers:
//   - assertPhaseOwnership: orchestrator no-op, matched subagent no-op,
//     mismatched subagent throws PhaseOwnershipError with both phases named.
//   - assertBugStatusOwnership: fixed ↔ commit, escalated/blocked/abandoned
//     allowed from any subagent or orchestrator, triaged/in-progress
//     orchestrator-only.
//   - assertOrchestratorOnlyEmit: any subagent → reject.
//   - Summary-key matrix: driven from BUG_SUMMARY_KEY_BY_ROLE so any
//     future divergence between the map and the guard is caught at test
//     time. For each [role, key] pair where key !== null, a subagent
//     caller in `role` calling set-bug-summary with namedPhase=key is a
//     no-op; calling with any other key throws.
//   - Materialization assertion: the generated triage.md (under
//     forge/forge/init/base-pack/workflows/) satisfies all four
//     checkMaterialization markers — guards against meta-source drift
//     for the new workflow.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkMaterialization } from "../../../src/extensions/forgecli/lib/manifest-checker.js";
import { CallerContextStore } from "../../../src/extensions/forgecli/subagent/caller-context.js";
import {
	assertBugStatusOwnership,
	assertOrchestratorOnlyEmit,
	assertPhaseOwnership,
	PhaseOwnershipError,
} from "../../../src/extensions/forgecli/subagent/phase-guard.js";
import { BUG_SUMMARY_KEY_BY_ROLE } from "../../../src/extensions/forgecli/subagent/phase-summary-map.js";

afterEach(() => {
	CallerContextStore.set({ kind: "orchestrator" });
});

describe("assertPhaseOwnership", () => {
	it("orchestrator caller is a no-op for every tool/phase combo", () => {
		for (const tool of ["forge_preflight", "forge_store set-bug-summary", "forge_store update-status bug"]) {
			for (const phase of ["triage", "plan-fix", "review-plan", "implement", "commit"]) {
				expect(() => assertPhaseOwnership(tool, phase)).not.toThrow();
			}
		}
	});

	it("matched subagent caller is a no-op", () => {
		CallerContextStore.set({ kind: "subagent", phase: "implement" });
		expect(() => assertPhaseOwnership("forge_preflight", "implement")).not.toThrow();
	});

	it("mismatched subagent caller throws PhaseOwnershipError with both phases named", () => {
		CallerContextStore.set({ kind: "subagent", phase: "triage" });
		let caught: unknown;
		try {
			assertPhaseOwnership("forge_preflight", "commit");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(PhaseOwnershipError);
		const err = caught as PhaseOwnershipError;
		expect(err.callerPhase).toBe("triage");
		expect(err.attemptedPhase).toBe("commit");
		expect(err.message).toContain("triage");
		expect(err.message).toContain("commit");
	});

	it("set-bug-summary translates PhaseRole to summary key via BUG_SUMMARY_KEY_BY_ROLE", () => {
		CallerContextStore.set({ kind: "subagent", phase: "implement" });
		// implement → "implementation" — no throw
		expect(() => assertPhaseOwnership("forge_store set-bug-summary", "implementation")).not.toThrow();
		// implement → "triage" mismatch — throw
		expect(() => assertPhaseOwnership("forge_store set-bug-summary", "triage")).toThrow(PhaseOwnershipError);
	});

	it("commit caller cannot call set-bug-summary at all (commit writes no summary)", () => {
		CallerContextStore.set({ kind: "subagent", phase: "commit" });
		expect(() => assertPhaseOwnership("forge_store set-bug-summary", "commit")).toThrow(PhaseOwnershipError);
	});

	// Bug A (cartographer CART-S01-T02): task-mode set-summary must use the
	// TASK key-map, not the bug-mode one. `plan` and `validate` are task-only
	// roles absent from BUG_SUMMARY_KEY_BY_ROLE — they were wrongly rejected as
	// "not a recognised bug-mode phase", forcing a bash fallback every phase.
	it("set-summary translates TASK PhaseRole to summary key (plan, validate not rejected)", () => {
		CallerContextStore.set({ kind: "subagent", phase: "plan" });
		// plan → "plan" — no throw (was: thrown as not-a-bug-mode-phase)
		expect(() => assertPhaseOwnership("forge_store set-summary", "plan")).not.toThrow();

		CallerContextStore.set({ kind: "subagent", phase: "validate" });
		// validate → "validation" — no throw
		expect(() => assertPhaseOwnership("forge_store set-summary", "validation")).not.toThrow();

		// other task phases still resolve correctly
		CallerContextStore.set({ kind: "subagent", phase: "review-code" });
		expect(() => assertPhaseOwnership("forge_store set-summary", "code_review")).not.toThrow();
	});

	it("set-summary still rejects a mismatched summary key for a task phase", () => {
		CallerContextStore.set({ kind: "subagent", phase: "plan" });
		// plan caller naming the validation key → mismatch → throw
		expect(() => assertPhaseOwnership("forge_store set-summary", "validation")).toThrow(PhaseOwnershipError);
	});

	it("set-summary from a no-summary task phase (commit) is forbidden", () => {
		CallerContextStore.set({ kind: "subagent", phase: "commit" });
		expect(() => assertPhaseOwnership("forge_store set-summary", "commit")).toThrow(PhaseOwnershipError);
	});
});

describe("assertBugStatusOwnership", () => {
	it("commit subagent may write status=fixed", () => {
		CallerContextStore.set({ kind: "subagent", phase: "commit" });
		expect(() => assertBugStatusOwnership("forge_store update-status bug", "fixed")).not.toThrow();
	});

	it("non-commit subagent cannot write status=fixed", () => {
		CallerContextStore.set({ kind: "subagent", phase: "triage" });
		expect(() => assertBugStatusOwnership("forge_store update-status bug", "fixed")).toThrow(PhaseOwnershipError);
	});

	it("orchestrator may always write status=fixed (force-finish path)", () => {
		CallerContextStore.set({ kind: "orchestrator" });
		expect(() => assertBugStatusOwnership("forge_store update-status bug", "fixed")).not.toThrow();
	});

	it("any subagent may write escalated/blocked/abandoned (in-band escalation)", () => {
		CallerContextStore.set({ kind: "subagent", phase: "review-plan" });
		for (const status of ["escalated", "blocked", "abandoned"]) {
			expect(() => assertBugStatusOwnership("forge_store update-status bug", status)).not.toThrow();
		}
	});

	it("subagents cannot write triaged or in-progress (orchestrator-only)", () => {
		CallerContextStore.set({ kind: "subagent", phase: "triage" });
		expect(() => assertBugStatusOwnership("forge_store update-status bug", "triaged")).toThrow(PhaseOwnershipError);
		expect(() => assertBugStatusOwnership("forge_store update-status bug", "in-progress")).toThrow(
			PhaseOwnershipError,
		);
	});
});

describe("assertOrchestratorOnlyEmit", () => {
	it("orchestrator may emit", () => {
		CallerContextStore.set({ kind: "orchestrator" });
		expect(() => assertOrchestratorOnlyEmit("forge_store emit")).not.toThrow();
	});

	it("any subagent is rejected from emit", () => {
		for (const phase of ["triage", "plan-fix", "implement", "commit"] as const) {
			CallerContextStore.set({ kind: "subagent", phase });
			expect(() => assertOrchestratorOnlyEmit("forge_store emit")).toThrow(PhaseOwnershipError);
		}
	});
});

describe("Summary-key matrix driven from BUG_SUMMARY_KEY_BY_ROLE", () => {
	const allKeys = Object.values(BUG_SUMMARY_KEY_BY_ROLE).filter((k): k is string => typeof k === "string");

	for (const [role, expectedKey] of Object.entries(BUG_SUMMARY_KEY_BY_ROLE)) {
		if (expectedKey === null) {
			it(`role '${role}' (no summary) — set-bug-summary always throws`, () => {
				CallerContextStore.set({ kind: "subagent", phase: role as never });
				for (const key of allKeys) {
					expect(() => assertPhaseOwnership("forge_store set-bug-summary", key)).toThrow(PhaseOwnershipError);
				}
			});
			continue;
		}
		it(`role '${role}' — set-bug-summary with key '${expectedKey}' is a no-op; other keys throw`, () => {
			CallerContextStore.set({ kind: "subagent", phase: role as never });
			expect(() => assertPhaseOwnership("forge_store set-bug-summary", expectedKey)).not.toThrow();
			for (const otherKey of allKeys) {
				if (otherKey === expectedKey) continue;
				expect(() => assertPhaseOwnership("forge_store set-bug-summary", otherKey)).toThrow(PhaseOwnershipError);
			}
		});
	}
});

describe("Materialization markers — base-pack triage.md", () => {
	it("the generated triage.md satisfies every checkMaterialization marker", () => {
		// Resolve the sibling forge/ clone's bundled triage.md. The path is
		// relative to this test file: forge-cli/test/.../phase-guard.test.ts
		// → forge-cli/../forge/forge/init/base-pack/workflows/triage.md
		const __dirname = fileURLToPath(new URL(".", import.meta.url));
		const triagePath = path.resolve(
			__dirname,
			"../../../../forge/forge/init/base-pack/workflows/triage.md",
		);
		const triageMd = readFileSync(triagePath, "utf8");
		const result = checkMaterialization(triagePath, triageMd);
		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
	});
});
