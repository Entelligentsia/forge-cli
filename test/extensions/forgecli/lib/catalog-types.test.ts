// Unit tests for lib/catalog-types.ts — FORGE-S25-T27.
//
// Coverage:
//   1. FRICTION_SUBKINDS contains the 5 expected subkinds
//   2. FRICTION_SUBKINDS values all match the event.schema.json subkind regex
//   3. SYNTHETIC_EVENT_TYPES contains the 3 expected discriminants
//   4. ROLE_KINDS contains expected orchestrator roles
//   5. ACTION_KINDS contains expected event actions
//   6. No value appears twice in any const (no duplicates)
//   7. TASK_STATUS_VALUES contains known task statuses
//   8. SPRINT_STATUS_VALUES contains known sprint statuses
//   9. BUG_STATUS_VALUES contains known bug statuses

import { describe, expect, it } from "vitest";
import {
	ACTION_KINDS,
	BUG_STATUS_VALUES,
	COMMAND_NAME_VALUES,
	FRICTION_SUBKINDS,
	ROLE_KINDS,
	SPRINT_STATUS_VALUES,
	SYNTHETIC_EVENT_TYPES,
	TASK_STATUS_VALUES,
} from "../../../../src/extensions/forgecli/lib/catalog-types.js";

// event.schema.json subkind pattern: ^(skill_unused|skill_failed|skill_missing|skill_stale|skill_redundant|x_[a-z_]+)$
// The five named values (no x_ experimental prefix) that must appear in FRICTION_SUBKINDS.
const EXPECTED_FRICTION_SUBKINDS = [
	"skill_unused",
	"skill_failed",
	"skill_missing",
	"skill_stale",
	"skill_redundant",
] as const;

// Pattern from event.schema.json — allows named values + x_ experimental prefix.
const SUBKIND_PATTERN = /^(skill_unused|skill_failed|skill_missing|skill_stale|skill_redundant|x_[a-z_]+)$/;

describe("catalog-types / FRICTION_SUBKINDS", () => {
	it("contains all 5 expected subkinds", () => {
		expect(Array.from(FRICTION_SUBKINDS)).toHaveLength(5);
		for (const subkind of EXPECTED_FRICTION_SUBKINDS) {
			expect(FRICTION_SUBKINDS).toContain(subkind);
		}
	});

	it("all values match event.schema.json subkind pattern", () => {
		for (const subkind of FRICTION_SUBKINDS) {
			expect(subkind).toMatch(SUBKIND_PATTERN);
		}
	});
});

describe("catalog-types / SYNTHETIC_EVENT_TYPES", () => {
	it("contains init-complete, sprint-collate-complete, migration-applied", () => {
		expect(SYNTHETIC_EVENT_TYPES).toContain("init-complete");
		expect(SYNTHETIC_EVENT_TYPES).toContain("sprint-collate-complete");
		expect(SYNTHETIC_EVENT_TYPES).toContain("migration-applied");
	});

	it("is non-empty", () => {
		expect(SYNTHETIC_EVENT_TYPES.length).toBeGreaterThan(0);
	});
});

describe("catalog-types / ROLE_KINDS", () => {
	it("contains expected orchestrator phase roles", () => {
		expect(ROLE_KINDS).toContain("plan");
		expect(ROLE_KINDS).toContain("implement");
		expect(ROLE_KINDS).toContain("approve");
		expect(ROLE_KINDS).toContain("orchestrator");
		expect(ROLE_KINDS).toContain("review-plan");
		expect(ROLE_KINDS).toContain("review-code");
	});

	it("is non-empty", () => {
		expect(ROLE_KINDS.length).toBeGreaterThan(0);
	});
});

describe("catalog-types / ACTION_KINDS", () => {
	it("contains expected event actions", () => {
		expect(ACTION_KINDS).toContain("start");
		expect(ACTION_KINDS).toContain("complete");
		expect(ACTION_KINDS).toContain("escalated");
		expect(ACTION_KINDS).toContain("gate_failed");
	});

	it("is non-empty", () => {
		expect(ACTION_KINDS.length).toBeGreaterThan(0);
	});
});

describe("catalog-types / no duplicates", () => {
	function noDuplicates(arr: readonly string[]): boolean {
		return new Set(arr).size === arr.length;
	}

	it("FRICTION_SUBKINDS has no duplicates", () => {
		expect(noDuplicates(FRICTION_SUBKINDS)).toBe(true);
	});

	it("SYNTHETIC_EVENT_TYPES has no duplicates", () => {
		expect(noDuplicates(SYNTHETIC_EVENT_TYPES)).toBe(true);
	});

	it("ROLE_KINDS has no duplicates", () => {
		expect(noDuplicates(ROLE_KINDS)).toBe(true);
	});

	it("ACTION_KINDS has no duplicates", () => {
		expect(noDuplicates(ACTION_KINDS)).toBe(true);
	});

	it("TASK_STATUS_VALUES has no duplicates", () => {
		expect(noDuplicates(TASK_STATUS_VALUES)).toBe(true);
	});

	it("SPRINT_STATUS_VALUES has no duplicates", () => {
		expect(noDuplicates(SPRINT_STATUS_VALUES)).toBe(true);
	});

	it("BUG_STATUS_VALUES has no duplicates", () => {
		expect(noDuplicates(BUG_STATUS_VALUES)).toBe(true);
	});
});

describe("catalog-types / status values", () => {
	it("TASK_STATUS_VALUES contains known task statuses", () => {
		expect(TASK_STATUS_VALUES).toContain("draft");
		expect(TASK_STATUS_VALUES).toContain("committed");
		expect(TASK_STATUS_VALUES).toContain("plan-approved");
		expect(TASK_STATUS_VALUES).toContain("implementing");
		expect(TASK_STATUS_VALUES).toContain("blocked");
		expect(TASK_STATUS_VALUES).toContain("escalated");
		expect(TASK_STATUS_VALUES).toContain("abandoned");
	});

	it("SPRINT_STATUS_VALUES contains known sprint statuses", () => {
		expect(SPRINT_STATUS_VALUES).toContain("planning");
		expect(SPRINT_STATUS_VALUES).toContain("active");
		expect(SPRINT_STATUS_VALUES).toContain("completed");
		expect(SPRINT_STATUS_VALUES).toContain("retrospective-done");
	});

	it("BUG_STATUS_VALUES contains known bug statuses", () => {
		expect(BUG_STATUS_VALUES).toContain("reported");
		expect(BUG_STATUS_VALUES).toContain("triaged");
		expect(BUG_STATUS_VALUES).toContain("in-progress");
		expect(BUG_STATUS_VALUES).toContain("fixed");
	});

	it("COMMAND_NAME_VALUES contains forge:plan and forge:init", () => {
		expect(COMMAND_NAME_VALUES).toContain("forge:plan");
		expect(COMMAND_NAME_VALUES).toContain("forge:init");
		expect(COMMAND_NAME_VALUES).toContain("forge:run-task");
	});
});
