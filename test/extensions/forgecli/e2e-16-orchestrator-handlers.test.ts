// e2e-16-orchestrator-handlers.test.ts — FORGE-S23-T13
//
// Smoke gate E2E-16 (vitest): assert per-archetype IL10 shape for the three
// new handlers shipped in FORGE-S23-T08 and FORGE-S23-T09.
//
// Playbook §2.1 (doc/forge-cli/command-porting-playbook.md, line 33):
//   "Smoke gate E2E-16 (planned): assert any Orchestrator handler imports +
//    calls runForgeSubagent."
//
// Handler archetypes:
//   calibrate.ts  — Orchestrator: imports + calls runForgeSubagent (IL10)
//   migrate.ts    — Hybrid (structural branch): imports + calls runForgeSubagent (IL10)
//   materialize.ts — Atomic: does NOT import runForgeSubagent (correct atomic shape; uses spawn argv-arrays per IL6)
//
// Acceptance criteria (FORGE-S23-T13):
//   AC#1: Smoke gate asserts per-archetype shape for all three handlers
//   AC#2: EXPLICITLY_REGISTERED_NAMES entry confirmed for each
//   AC#3: Gate runs in CI (vitest)
//
// Note: AC#1 as written in the task prompt says "all three import runForgeSubagent".
//       materialize.ts is intentionally Atomic (no runForgeSubagent). The gate
//       asserts the architecturally correct per-archetype shape, not the literal
//       mis-specified AC text. See PLAN.md §"Scope Clarification" for rationale.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { __test__ as forgeCommandsTest } from "../../../src/extensions/forgecli/forge-commands.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const SRC_DIR = path.resolve(__dirname, "../../../src/extensions/forgecli");

function readSrc(filename: string): string {
	return fs.readFileSync(path.join(SRC_DIR, filename), "utf8");
}

/** Strip comment lines before checking for call sites, matching smoke.sh E2E-16 pattern. */
function stripComments(src: string): string {
	return src
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n");
}

// ── E2E-16 — Orchestrator handler IL10 shape ──────────────────────────────────

describe("E2E-16: Orchestrator handler IL10 shape (FORGE-S23-T13)", () => {
	// ── calibrate.ts — Orchestrator archetype ────────────────────────────────

	describe("calibrate.ts — Orchestrator archetype", () => {
		const src = readSrc("calibrate.ts");
		const srcNoComments = stripComments(src);

		it("imports runForgeSubagent", () => {
			// The import line is a non-comment code line. It must be present as an
			// ES import or re-export to satisfy IL10.
			expect(src).toMatch(/import.*runForgeSubagent/);
		});

		it("calls runForgeSubagent (non-comment call site present)", () => {
			// A bare comment referencing runForgeSubagent does not satisfy IL10.
			// Strip comment lines first, then assert the call is present.
			expect(srcNoComments).toMatch(/runForgeSubagent\s*\(/);
		});

		it("EXPLICITLY_REGISTERED_NAMES does NOT contain 'forge:calibrate' (removed v1.0; handler reused by /forge:health --fix)", () => {
			expect(forgeCommandsTest.EXPLICITLY_REGISTERED_NAMES.has("forge:calibrate")).toBe(false);
		});
	});

	// ── migrate.ts — Hybrid archetype (structural branch uses runForgeSubagent) ─

	describe("migrate.ts — Hybrid archetype (structural branch)", () => {
		const src = readSrc("migrate.ts");
		const srcNoComments = stripComments(src);

		it("imports runForgeSubagent", () => {
			expect(src).toMatch(/import.*runForgeSubagent/);
		});

		it("calls runForgeSubagent (non-comment call site present)", () => {
			expect(srcNoComments).toMatch(/runForgeSubagent\s*\(/);
		});

		it("EXPLICITLY_REGISTERED_NAMES does NOT contain 'forge:migrate' (removed v1.0; handler reused by /forge:init --migrate)", () => {
			expect(forgeCommandsTest.EXPLICITLY_REGISTERED_NAMES.has("forge:migrate")).toBe(false);
		});
	});

	// ── materialize.ts — Atomic archetype (no runForgeSubagent — correct) ────

	describe("materialize.ts — Atomic archetype", () => {
		const src = readSrc("materialize.ts");
		const srcNoComments = stripComments(src);

		it("does NOT import runForgeSubagent (atomic handler: uses spawn argv-arrays per IL6)", () => {
			// Atomic handlers MUST NOT use runForgeSubagent. Asserting absence
			// locks this shape against future accidental drift.
			expect(srcNoComments).not.toMatch(/import.*runForgeSubagent/);
		});

		it("EXPLICITLY_REGISTERED_NAMES does NOT contain 'forge:materialize' (removed v1.0)", () => {
			expect(forgeCommandsTest.EXPLICITLY_REGISTERED_NAMES.has("forge:materialize")).toBe(false);
		});
	});
});
