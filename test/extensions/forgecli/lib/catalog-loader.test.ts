// Unit tests for lib/catalog-loader.ts — FORGE-S25-T27.
//
// Coverage:
//   loadEnumCatalog(bundleRoot):
//     1. Returns non-empty enums for task/sprint/bug statuses
//     2. Returns non-empty commandNames
//   loadTransitions(bundleRoot):
//     3. TASK_TRANSITIONS draft → planned: allowed
//     4. TASK_TRANSITIONS draft → committed: denied
//     5. SPRINT_TRANSITIONS planning → active: allowed
//     6. BUG_TRANSITIONS fixed is empty Set (terminal state)
//   Error handling:
//     7. Missing catalog file throws descriptive error
//   Consistency (R-2 regression):
//     8. Every key in TASK_TRANSITIONS appears in TASK_STATUS_VALUES from catalog-types.ts
//     9. Every key in SPRINT_TRANSITIONS appears in SPRINT_STATUS_VALUES from catalog-types.ts
//   Module-level constants (lazy-loaded proxies):
//    10. Proxy-based TASK_TRANSITIONS works correctly
//    11. Proxy-based BUG_TRANSITIONS terminal state is empty

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadEnumCatalog,
	loadTransitions,
	resolveBundledPayloadRoot,
	TASK_TRANSITIONS,
	SPRINT_TRANSITIONS,
	BUG_TRANSITIONS,
} from "../../../../src/extensions/forgecli/lib/catalog-loader.js";
import {
	TASK_STATUS_VALUES,
	SPRINT_STATUS_VALUES,
} from "../../../../src/extensions/forgecli/lib/catalog-types.js";

const BUNDLE_ROOT = resolveBundledPayloadRoot();

describe("catalog-loader / loadEnumCatalog", () => {
	it("returns non-empty task status enum from bundled catalog", () => {
		const catalog = loadEnumCatalog(BUNDLE_ROOT);
		expect(Array.isArray(catalog.enums["task.status"])).toBe(true);
		expect(catalog.enums["task.status"].length).toBeGreaterThan(0);
		expect(catalog.enums["task.status"]).toContain("draft");
		expect(catalog.enums["task.status"]).toContain("committed");
	});

	it("returns non-empty sprint status enum", () => {
		const catalog = loadEnumCatalog(BUNDLE_ROOT);
		expect(catalog.enums["sprint.status"]).toContain("planning");
		expect(catalog.enums["sprint.status"]).toContain("completed");
	});

	it("returns non-empty commandNames", () => {
		const catalog = loadEnumCatalog(BUNDLE_ROOT);
		expect(Array.isArray(catalog.commandNames)).toBe(true);
		expect(catalog.commandNames.length).toBeGreaterThan(0);
		expect(catalog.commandNames.every((c: string) => c.startsWith("forge:"))).toBe(true);
	});

	it("throws a descriptive error if catalog file is missing", () => {
		const fakeRoot = path.join(BUNDLE_ROOT, "does-not-exist-T27");
		expect(() => loadEnumCatalog(fakeRoot)).toThrow("[catalog-loader] enum-catalog.json not found");
	});
});

describe("catalog-loader / loadTransitions", () => {
	it("TASK_TRANSITIONS draft → planned is allowed", () => {
		const t = loadTransitions(BUNDLE_ROOT);
		expect(t.task["draft"]?.has("planned")).toBe(true);
	});

	it("TASK_TRANSITIONS draft → committed is denied (non-terminal skip)", () => {
		const t = loadTransitions(BUNDLE_ROOT);
		expect(t.task["draft"]?.has("committed")).toBe(false);
	});

	it("SPRINT_TRANSITIONS planning → active is allowed", () => {
		const t = loadTransitions(BUNDLE_ROOT);
		expect(t.sprint["planning"]?.has("active")).toBe(true);
	});

	it("BUG_TRANSITIONS fixed is an empty Set (terminal state)", () => {
		const t = loadTransitions(BUNDLE_ROOT);
		expect(t.bug["fixed"]?.size).toBe(0);
	});

	it("throws a descriptive error if transitions file is missing", () => {
		const fakeRoot = path.join(BUNDLE_ROOT, "does-not-exist-T27");
		expect(() => loadTransitions(fakeRoot)).toThrow("[catalog-loader] transitions/task.json not found");
	});
});

describe("catalog-loader / consistency (R-2 regression)", () => {
	it("every key in TASK_TRANSITIONS appears in TASK_STATUS_VALUES", () => {
		const t = loadTransitions(BUNDLE_ROOT);
		const catalogKeys = Object.keys(t.task);
		const typeValues = Array.from(TASK_STATUS_VALUES);
		for (const key of catalogKeys) {
			expect(typeValues).toContain(key);
		}
	});

	it("every key in SPRINT_TRANSITIONS appears in SPRINT_STATUS_VALUES", () => {
		const t = loadTransitions(BUNDLE_ROOT);
		const catalogKeys = Object.keys(t.sprint);
		const typeValues = Array.from(SPRINT_STATUS_VALUES);
		for (const key of catalogKeys) {
			expect(typeValues).toContain(key);
		}
	});
});

describe("catalog-loader / module-level proxy constants", () => {
	it("TASK_TRANSITIONS proxy: draft → planned is allowed", () => {
		const allowed = TASK_TRANSITIONS["draft"];
		expect(allowed).toBeDefined();
		expect(allowed?.has("planned")).toBe(true);
	});

	it("TASK_TRANSITIONS proxy: committed is terminal (empty Set)", () => {
		const terminal = TASK_TRANSITIONS["committed"];
		expect(terminal).toBeDefined();
		expect(terminal?.size).toBe(0);
	});

	it("BUG_TRANSITIONS proxy: fixed is terminal", () => {
		const terminal = BUG_TRANSITIONS["fixed"];
		expect(terminal).toBeDefined();
		expect(terminal?.size).toBe(0);
	});

	it("SPRINT_TRANSITIONS proxy: planning → active is allowed", () => {
		const allowed = SPRINT_TRANSITIONS["planning"];
		expect(allowed?.has("active")).toBe(true);
	});
});
