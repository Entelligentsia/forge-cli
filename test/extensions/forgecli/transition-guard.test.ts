// Regression tests for transition-guard.ts — FORGE-S25-T27.
//
// Verifies that the catalog-driven ENTITY_TABLES (loaded from transitions/*.json)
// produce correct allow/deny decisions for known FSM transitions.
//
// These tests fail if the catalog tables are absent or malformed (AC#3).
// They also catch regressions where terminal states incorrectly allow transitions.
//
// Coverage:
//   1. task: draft → planned: allowed
//   2. task: draft → committed: denied (non-adjacent skip)
//   3. task: committed → planned: denied (terminal state — T25 ADR canonical)
//   4. sprint: planning → active: allowed

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock spawn-store-cli to control the "current status" returned by the guard.
const mockSpawnStoreCliRead = vi.fn();
vi.mock("../../../src/extensions/forgecli/lib/spawn-store-cli.js", () => ({
	spawnStoreCliRead: (...args: unknown[]) => mockSpawnStoreCliRead(...args),
}));

import { checkTransition } from "../../../src/extensions/forgecli/transition-guard.js";

beforeEach(() => {
	mockSpawnStoreCliRead.mockReset();
});

describe("transition-guard / task transitions (catalog-driven)", () => {
	it("draft → planned: allowed", () => {
		// Return current status = "draft"
		mockSpawnStoreCliRead.mockReturnValue({ status: "draft" });
		const result = checkTransition({ entity: "task", entityId: "T-001", toStatus: "planned" }, "/fake/forge-root");
		expect(result.allowed).toBe(true);
	});

	it("draft → committed: denied (non-adjacent skip)", () => {
		mockSpawnStoreCliRead.mockReturnValue({ status: "draft" });
		const result = checkTransition({ entity: "task", entityId: "T-001", toStatus: "committed" }, "/fake/forge-root");
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/draft.*committed/);
	});

	it("committed → planned: denied (terminal state — T25 ADR canonical)", () => {
		mockSpawnStoreCliRead.mockReturnValue({ status: "committed" });
		const result = checkTransition({ entity: "task", entityId: "T-001", toStatus: "planned" }, "/fake/forge-root");
		expect(result.allowed).toBe(false);
		// committed is a terminal state with no legal transitions
		expect(result.reason).toMatch(/committed.*planned/);
	});
});

describe("transition-guard / sprint transitions (catalog-driven)", () => {
	it("planning → active: allowed", () => {
		mockSpawnStoreCliRead.mockReturnValue({ status: "planning" });
		const result = checkTransition({ entity: "sprint", entityId: "S-001", toStatus: "active" }, "/fake/forge-root");
		expect(result.allowed).toBe(true);
	});
});
