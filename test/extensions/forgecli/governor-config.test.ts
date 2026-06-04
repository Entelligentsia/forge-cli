// Unit tests for governor-config.ts — FORGE-BUG-043 PR 2.
//
// Coverage:
//   IL7 defaults:
//     Test 1: undefined cwd → defaults
//     Test 2: missing .forge/config.json → defaults
//     Test 3: malformed JSON → defaults
//   Config-driven values:
//     Test 4: prefix / paths.store / paths.engineering read from config
//     Test 5: partial config — missing fields fall back individually
//   Prefix validation:
//     Test 6: non-identifier prefix (regex-injection shape) → default prefix

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGovernorProjectConfig } from "../../../src/extensions/forgecli/governor-config.js";

const tmpDirs: string[] = [];

function makeProject(config?: unknown): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "governor-config-test-"));
	tmpDirs.push(dir);
	if (config !== undefined) {
		fs.mkdirSync(path.join(dir, ".forge"), { recursive: true });
		const body = typeof config === "string" ? config : JSON.stringify(config);
		fs.writeFileSync(path.join(dir, ".forge", "config.json"), body, "utf8");
	}
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadGovernorProjectConfig: IL7 defaults", () => {
	it("Test 1: undefined cwd → defaults", () => {
		expect(loadGovernorProjectConfig(undefined)).toEqual({
			prefix: "FORGE",
			storePath: ".forge/store",
			engineeringPath: "engineering",
		});
	});

	it("Test 2: missing .forge/config.json → defaults", () => {
		const dir = makeProject(); // no config written
		expect(loadGovernorProjectConfig(dir)).toEqual({
			prefix: "FORGE",
			storePath: ".forge/store",
			engineeringPath: "engineering",
		});
	});

	it("Test 3: malformed JSON → defaults (never throws)", () => {
		const dir = makeProject("{not json!!");
		expect(() => loadGovernorProjectConfig(dir)).not.toThrow();
		expect(loadGovernorProjectConfig(dir).prefix).toBe("FORGE");
	});
});

describe("loadGovernorProjectConfig: config-driven values", () => {
	it("Test 4: prefix / paths.store / paths.engineering read from config", () => {
		const dir = makeProject({
			project: { prefix: "CART" },
			paths: { store: ".forge/data", engineering: "eng" },
		});
		expect(loadGovernorProjectConfig(dir)).toEqual({
			prefix: "CART",
			storePath: ".forge/data",
			engineeringPath: "eng",
		});
	});

	it("Test 5: partial config — missing fields fall back individually", () => {
		const dir = makeProject({ project: { prefix: "HLO" } });
		expect(loadGovernorProjectConfig(dir)).toEqual({
			prefix: "HLO",
			storePath: ".forge/store",
			engineeringPath: "engineering",
		});
	});
});

describe("loadGovernorProjectConfig: prefix validation", () => {
	it("Test 6: non-identifier prefix (regex-injection shape) → default prefix", () => {
		const dir = makeProject({ project: { prefix: "BAD.*+(PREFIX" } });
		expect(loadGovernorProjectConfig(dir).prefix).toBe("FORGE");
	});
});
