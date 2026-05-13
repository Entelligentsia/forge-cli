// Unit test for formatLocalTime — render ISO timestamps in the user's local
// timezone for resume / stale prompts. Replaces raw UTC ISO strings in user-
// facing UI.

import { describe, expect, it } from "vitest";

import { formatLocalTime } from "../../../src/extensions/forgecli/run-task.js";

describe("formatLocalTime", () => {
	it("returns a non-empty string for a valid ISO timestamp", () => {
		const out = formatLocalTime("2026-05-13T03:03:52.988Z");
		expect(out).toBeTruthy();
		expect(out.length).toBeGreaterThan(0);
	});

	it("does not contain the raw 'T' separator from ISO 8601", () => {
		const out = formatLocalTime("2026-05-13T03:03:52.988Z");
		// Locale-rendered output uses a space between date and time, not 'T'.
		expect(out).not.toMatch(/\dT\d/);
	});

	it("does not end with a literal 'Z' (UTC marker)", () => {
		// Local rendering should not preserve the trailing Z from the ISO input.
		const out = formatLocalTime("2026-05-13T03:03:52.988Z");
		expect(out.endsWith("Z")).toBe(false);
	});

	it("includes the year and second component", () => {
		const out = formatLocalTime("2026-05-13T03:03:52.988Z");
		expect(out).toMatch(/2026/);
		expect(out).toMatch(/52/);
	});

	it("falls back to the raw ISO string for invalid input", () => {
		const bad = "not-a-real-timestamp";
		const out = formatLocalTime(bad);
		expect(out).toBe(bad);
	});
});
