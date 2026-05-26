// Unit tests for FORGE-S26-T11 additions to pipeline handler files:
//   - review-plan.ts: buildReviewLoopContext, readMaxReviewIterations
//   - review-code.ts: same helpers (parallel implementation)
//
// The handler-level guard integration is covered by the pipeline-guard.test.ts
// unit tests on runPipelineGuard. Here we verify the iteration-context helpers
// and the composeKickoff extensions.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildReviewLoopContext,
	composeKickoff as composeReviewPlanKickoff,
	readMaxReviewIterations,
} from "../../../src/extensions/forgecli/review-plan.js";

import {
	buildReviewLoopContext as buildRCLoopContext,
	composeKickoff as composeReviewCodeKickoff,
	readMaxReviewIterations as readRCMaxIterations,
} from "../../../src/extensions/forgecli/review-code.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-guard-handlers-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function scaffoldConfig(projectRoot: string, configOverrides: Record<string, unknown> = {}): void {
	const forgeDir = path.join(projectRoot, ".forge");
	fs.mkdirSync(forgeDir, { recursive: true });
	fs.writeFileSync(
		path.join(forgeDir, "config.json"),
		JSON.stringify({ paths: { forgeRoot: "./forge" }, ...configOverrides }, null, 2),
		"utf8",
	);
}

// ── review-plan: buildReviewLoopContext ───────────────────────────────────────

describe("review-plan / buildReviewLoopContext", () => {
	it("default (maxIterations=3): not final iteration", () => {
		const ctx = buildReviewLoopContext(3);
		expect(ctx).toContain("### Review Loop Context");
		expect(ctx).toContain("Iteration: 1 of 3");
		expect(ctx).toContain("Is final iteration: false");
	});

	it("maxIterations=1: IS final iteration", () => {
		const ctx = buildReviewLoopContext(1);
		expect(ctx).toContain("Iteration: 1 of 1");
		expect(ctx).toContain("Is final iteration: true");
	});

	it("maxIterations=5: not final iteration", () => {
		const ctx = buildReviewLoopContext(5);
		expect(ctx).toContain("Iteration: 1 of 5");
		expect(ctx).toContain("Is final iteration: false");
	});
});

// ── review-plan: readMaxReviewIterations ──────────────────────────────────────

describe("review-plan / readMaxReviewIterations", () => {
	it("returns 3 when no config file", () => {
		const projDir = path.join(tmpRoot, "no-config");
		fs.mkdirSync(projDir);
		expect(readMaxReviewIterations(projDir)).toBe(3);
	});

	it("returns 3 when config has no maxReviewIterations field", () => {
		const projDir = path.join(tmpRoot, "no-field");
		scaffoldConfig(projDir);
		expect(readMaxReviewIterations(projDir)).toBe(3);
	});

	it("returns configured value when valid", () => {
		const projDir = path.join(tmpRoot, "configured");
		scaffoldConfig(projDir, { maxReviewIterations: 5 });
		expect(readMaxReviewIterations(projDir)).toBe(5);
	});

	it("returns 3 when field is non-integer", () => {
		const projDir = path.join(tmpRoot, "bad-type");
		scaffoldConfig(projDir, { maxReviewIterations: "three" });
		expect(readMaxReviewIterations(projDir)).toBe(3);
	});

	it("returns 3 when field is less than 1", () => {
		const projDir = path.join(tmpRoot, "too-small");
		scaffoldConfig(projDir, { maxReviewIterations: 0 });
		expect(readMaxReviewIterations(projDir)).toBe(3);
	});
});

// ── review-plan: composeKickoff with reviewLoopContext ────────────────────────

describe("review-plan / composeKickoff with reviewLoopContext", () => {
	const baseOpts = {
		workflowMd: "## Algorithm\n1. Review the plan.",
		personaIdentity: "I am the architect.",
		parsed: { mode: "empty" as const, taskRef: "", sourceLabel: "(no input)" },
	};

	it("injects reviewLoopContext before workflow body", () => {
		const loopCtx = buildReviewLoopContext(3);
		const kickoff = composeReviewPlanKickoff({ ...baseOpts, reviewLoopContext: loopCtx });
		// Context block appears before the workflow section
		const ctxIdx = kickoff.indexOf("### Review Loop Context");
		const workflowIdx = kickoff.indexOf("## Workflow");
		expect(ctxIdx).toBeGreaterThan(-1);
		expect(workflowIdx).toBeGreaterThan(-1);
		expect(ctxIdx).toBeLessThan(workflowIdx);
	});

	it("omits reviewLoopContext block when undefined", () => {
		const kickoff = composeReviewPlanKickoff({ ...baseOpts });
		expect(kickoff).not.toContain("### Review Loop Context");
	});

	it("omits reviewLoopContext block when empty string", () => {
		const kickoff = composeReviewPlanKickoff({ ...baseOpts, reviewLoopContext: "" });
		expect(kickoff).not.toContain("### Review Loop Context");
	});
});

// ── review-code: parallel helpers mirror review-plan ─────────────────────────

describe("review-code / buildReviewLoopContext", () => {
	it("matches review-plan output for same maxIterations", () => {
		expect(buildRCLoopContext(3)).toEqual(buildReviewLoopContext(3));
		expect(buildRCLoopContext(1)).toEqual(buildReviewLoopContext(1));
	});
});

describe("review-code / readMaxReviewIterations", () => {
	it("returns 3 when no config", () => {
		const projDir = path.join(tmpRoot, "rc-no-config");
		fs.mkdirSync(projDir);
		expect(readRCMaxIterations(projDir)).toBe(3);
	});

	it("returns configured value", () => {
		const projDir = path.join(tmpRoot, "rc-configured");
		scaffoldConfig(projDir, { maxReviewIterations: 7 });
		expect(readRCMaxIterations(projDir)).toBe(7);
	});
});

describe("review-code / composeKickoff with reviewLoopContext", () => {
	const baseOpts = {
		workflowMd: "## Algorithm\n1. Review the code.",
		personaIdentity: "I am the supervisor.",
		parsed: { mode: "empty" as const, taskRef: "", sourceLabel: "(no input)" },
	};

	it("injects reviewLoopContext before workflow body", () => {
		const loopCtx = buildRCLoopContext(3);
		const kickoff = composeReviewCodeKickoff({ ...baseOpts, reviewLoopContext: loopCtx });
		const ctxIdx = kickoff.indexOf("### Review Loop Context");
		const workflowIdx = kickoff.indexOf("## Workflow");
		expect(ctxIdx).toBeGreaterThan(-1);
		expect(ctxIdx).toBeLessThan(workflowIdx);
	});

	it("omits context block when undefined", () => {
		const kickoff = composeReviewCodeKickoff({ ...baseOpts });
		expect(kickoff).not.toContain("### Review Loop Context");
	});
});
