// bundled-base-pack-markers.test.ts
//
// Regression guard: the bundled base-pack workflows shipped in
// dist/forge-payload/.base-pack/workflows/ MUST contain the four Pack-06
// materialization markers required by the /forge:plan and /forge:implement
// kickoff shims. If any marker is missing, every fresh `forge init` produces
// a workflow that hard-fails on dispatch with `× workflow regression: ...`.
//
// Root cause that motivated this test: forge-cli FORGE-S20-T05/T06 added the
// kickoff-shim materialization preconditions but never updated the meta sources
// in forge/forge/meta/workflows/. Bumping the bundled forge plugin version
// without re-checking these markers reintroduces the same break.
//
// Asserts (against the real bundled base-pack, not a fixture):
//   1. plan_task.md passes checkMaterialization (architect persona).
//   2. implement_plan.md passes checkMaterialization (engineer persona).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { checkMaterialization as checkPlanMaterialization } from "../../../src/extensions/forgecli/plan.js";
import { checkMaterialization as checkImplementMaterialization } from "../../../src/extensions/forgecli/implement.js";
import { checkMaterialization as checkEnhanceMaterialization } from "../../../src/extensions/forgecli/enhance.js";
import { getBundledPayloadRoot } from "../../../src/extensions/forgecli/forge-init.js";

describe("bundled base-pack: Pack-06 materialization markers", () => {
	const basePackWorkflows = path.join(getBundledPayloadRoot(), ".base-pack", "workflows");

	it("plan_task.md carries Iron Laws + Store-Write Verification + forge_store + architect.md", () => {
		const wfPath = path.join(basePackWorkflows, "plan_task.md");
		const md = fs.readFileSync(wfPath, "utf8");
		const res = checkPlanMaterialization(wfPath, md);
		expect(res.missing).toEqual([]);
		expect(res.ok).toBe(true);
	});

	it("implement_plan.md carries Iron Laws + Store-Write Verification + forge_store + engineer.md", () => {
		const wfPath = path.join(basePackWorkflows, "implement_plan.md");
		const md = fs.readFileSync(wfPath, "utf8");
		const res = checkImplementMaterialization(wfPath, md);
		expect(res.missing).toEqual([]);
		expect(res.ok).toBe(true);
	});

	it("enhance.md carries Iron Laws + Store-Write Verification + forge_store + engineer.md", () => {
		const wfPath = path.join(basePackWorkflows, "enhance.md");
		expect(fs.existsSync(wfPath)).toBe(true);
		const md = fs.readFileSync(wfPath, "utf8");
		const res = checkEnhanceMaterialization(wfPath, md);
		expect(res.missing).toEqual([]);
		expect(res.ok).toBe(true);
	});
});
