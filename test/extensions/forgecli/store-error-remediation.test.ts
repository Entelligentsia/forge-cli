// Tests for lib/store-error-remediation.ts — forge-cli#24
//
// Validates parseValidationError, remediateError, remediateValidationOutput,
// and enhanceBlockMessage — the shared remediation surface for store validation
// errors surfaced to users.

import { describe, it } from "vitest";
import {
	inferEntityType,
	parseValidationError,
	remediateError,
	remediateValidationOutput,
	enhanceBlockMessage,
} from "../../../src/extensions/forgecli/lib/store-error-remediation.js";
import { expect } from "vitest";

// ── parseValidationError ────────────────────────────────────────────────────────

describe("parseValidationError", () => {
	it("parses enum violation", () => {
		const result = parseValidationError('status: value "verified" not in [reported, triaged, in-progress, fixed]');
		expect(result.field).toBe("status");
		expect(result.errorKind).toBe("enum");
		expect(result.observed).toBe("verified");
		expect(result.enumValues).toEqual(["reported", "triaged", "in-progress", "fixed"]);
	});

	it("parses required field violation", () => {
		const result = parseValidationError("taskId: missing required field");
		expect(result.field).toBe("taskId");
		expect(result.errorKind).toBe("required");
	});

	it("parses undeclared field violation", () => {
		const result = parseValidationError("xyz: undeclared field");
		expect(result.field).toBe("xyz");
		expect(result.errorKind).toBe("undeclared");
	});

	it("parses type mismatch", () => {
		const result = parseValidationError("sprintId: expected string, got number");
		expect(result.field).toBe("sprintId");
		expect(result.errorKind).toBe("type");
	});

	it("parses date-time format error", () => {
		const result = parseValidationError('createdAt: value "today" is not a valid date-time');
		expect(result.field).toBe("createdAt");
		expect(result.errorKind).toBe("datetime");
	});

	it("parses pattern mismatch", () => {
		const result = parseValidationError('prefix: value "AB" does not match pattern ^[A-Z]+-[A-Z]$');
		expect(result.field).toBe("prefix");
		expect(result.errorKind).toBe("pattern");
	});

	it("parses length below minimum", () => {
		const result = parseValidationError("title: value length 0 is below minLength 1");
		expect(result.field).toBe("title");
		expect(result.errorKind).toBe("length");
	});

	it("parses length exceeds maximum", () => {
		const result = parseValidationError("description: value length 500 exceeds maxLength 300");
		expect(result.field).toBe("description");
		expect(result.errorKind).toBe("length");
	});

	it("falls back to 'other' for unrecognized patterns", () => {
		const result = parseValidationError("something went wrong in mysterious ways");
		expect(result.field).toBe("unknown");
		expect(result.errorKind).toBe("other");
	});
});

// ── inferEntityType ────────────────────────────────────────────────────────────

describe("inferEntityType", () => {
	it("infers bug from BUG prefix", () => {
		expect(inferEntityType("FORGE-BUG-015")).toBe("bug");
	});

	it("infers bug from bug- prefix", () => {
		expect(inferEntityType("bug-031")).toBe("bug");
	});

	it("infers sprint from S number", () => {
		expect(inferEntityType("FORGE-S18")).toBe("sprint");
	});

	it("infers sprint from lowercase sprint", () => {
		expect(inferEntityType("sprint-01")).toBe("sprint");
	});

	it("infers feature from feat", () => {
		expect(inferEntityType("FORGE-F01")).toBe("feature");
	});

	it("defaults to task for typical ID patterns", () => {
		expect(inferEntityType("FORGE-S18-T02")).toBe("task");
	});

	it("defaults to task for unknown patterns", () => {
		expect(inferEntityType("unknown-entity")).toBe("task");
	});
});

// ── remediateError ──────────────────────────────────────────────────────────────

describe("remediateError", () => {
	it("remediates enum violation for task status with legal values", () => {
		const result = remediateError(
			'status: value "verified" not in [draft, planned, plan-approved, implementing, implemented, review-approved, approved, committed, plan-revision-required, code-revision-required, blocked, escalated, abandoned]',
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain('"verified" is not a legal task status');
		expect(result.hint).toContain("Legal values:");
		expect(result.command).toContain("update-status task FORGE-S18-T02 status");
		expect(result.command).toContain("draft");
	});

	it("remediates enum violation for bug status", () => {
		const result = remediateError(
			'status: value "approved" not in [reported, triaged, in-progress, fixed]',
			"bug",
			"FORGE-BUG-015",
		);
		expect(result.hint).toContain('"approved"');
		expect(result.hint).toContain("bug");
		expect(result.command).toContain("update-status bug FORGE-BUG-015 status");
	});

	it("remediates missing required field", () => {
		const result = remediateError(
			"taskId: missing required field",
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain("missing field");
		expect(result.command).toContain("store-cli.cjs\" template task");
	});

	it("remediates undeclared field", () => {
		const result = remediateError(
			"xyz: undeclared field",
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain("undeclared");
		expect(result.command).toContain("describe task");
	});

	it("remediates type mismatch", () => {
		const result = remediateError(
			"sprintId: expected string, got number",
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain("correct type");
		expect(result.command).toContain("describe");
	});

	it("remediates date-time format error", () => {
		const result = remediateError(
			'createdAt: value "today" is not a valid date-time',
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain("ISO 8601");
		expect(result.command).toContain("describe");
	});

	it("remediates pattern mismatch", () => {
		const result = remediateError(
			'prefix: value "AB" does not match pattern ^[A-Z]+-[A-Z]$',
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain("pattern");
		expect(result.command).toContain("describe");
	});

	it("remediates length violation", () => {
		const result = remediateError(
			"title: value length 0 is below minLength 1",
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain("length");
		expect(result.command).toContain("describe");
	});

	it("provides generic remediation for unknown errors", () => {
		const result = remediateError(
			"something mysterious happened",
			"task",
			"FORGE-S18-T02",
		);
		expect(result.hint).toContain("schema");
		expect(result.command).toContain("template");
	});
});

// ── remediateValidationOutput ───────────────────────────────────────────────────

describe("remediateValidationOutput", () => {
	it("parses validate-store --dry-run output with ERROR prefix", () => {
		const output = [
			"ERROR  FORGE-S18-T02: status: value \"verified\" not in [reported, triaged, in-progress, fixed]",
			"WARN   FORGE-S18-T02: description: value length 500 exceeds maxLength 300",
		].join("\n");

		const results = remediateValidationOutput(output);
		expect(results.length).toBeGreaterThanOrEqual(1);
		// First result should have remediation for the status enum violation
		expect(results[0].remediation.hint).toContain("verified");
	});

	it("parses store-cli validate stderr output", () => {
		const output = 'status: value "verified" not in [reported, triaged, in-progress, fixed]';
		const results = remediateValidationOutput(output, "bug");
		expect(results).toHaveLength(1);
		expect(results[0].remediation.hint).toContain('"verified"');
	});

	it("skips hint lines from validate.js", () => {
		const output = [
			'status: value "verified" not in [reported, triaged, in-progress, fixed]',
			"(hint: run 'node store-cli.cjs template bug' for a canonical sample)",
		].join("\n");

		const results = remediateValidationOutput(output, "bug");
		// Should only produce one result — the hint line is skipped
		expect(results).toHaveLength(1);
	});

	it("returns empty array for empty input", () => {
		expect(remediateValidationOutput("")).toEqual([]);
		expect(remediateValidationOutput("  \n  ")).toEqual([]);
	});
});

// ── enhanceBlockMessage ────────────────────────────────────────────────────────

describe("enhanceBlockMessage", () => {
	it("adds remediation hint to enum violation in block message", () => {
		const reason = [
			"❌ Forge schema violation — write blocked",
			"Path: .forge/store/bugs/BUG-031.json",
			"Kind: bug",
			"Violations:",
			'  - status: value "approved" not in [reported, triaged, in-progress, fixed]',
		].join("\n");

		const enhanced = enhanceBlockMessage(reason, "bug", "BUG-031");
		expect(enhanced).toContain("💡");
		expect(enhanced).toContain('"approved"');
		expect(enhanced).toContain("update-status bug BUG-031 status");
	});

	it("adds remediation hint to missing required field in block message", () => {
		const reason = [
			"Violations:",
			"  - taskId: missing required field",
		].join("\n");

		const enhanced = enhanceBlockMessage(reason, "task", "FORGE-S18-T02");
		expect(enhanced).toContain("💡");
		expect(enhanced).toContain("missing field");
		expect(enhanced).toContain("template task");
	});

	it("preserves non-error lines unchanged", () => {
		const reason = "❌ Forge schema violation — write blocked\nPath: .forge/store/config.json\nKind: config";
		const enhanced = enhanceBlockMessage(reason);
		expect(enhanced).toContain("Forge schema violation");
		expect(enhanced).toContain("Path: .forge/store/config.json");
	});

	it("handles store-validator raw stderr format", () => {
		const reason = 'status: value "verified" not in [reported, triaged, in-progress, fixed]';
		const enhanced = enhanceBlockMessage(reason, "bug", "BUG-015");
		expect(enhanced).toContain("💡");
		expect(enhanced).toContain("update-status");
	});
});