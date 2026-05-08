// init-progress.test.ts — Tests for init-progress.ts (FORGE-S17-T02)
// Covers T01-T05 from PLAN.md test table.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock fs to avoid real disk writes
vi.mock("node:fs");

const mockFs = vi.mocked(fs);

import {
	deleteInitProgress,
	readInitProgress,
	writeInitProgress,
} from "../../../src/extensions/forgecli/init-progress.js";

describe("readInitProgress", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// T01: file does not exist → kind: "none"
	it("T01: returns none when file does not exist", () => {
		mockFs.readFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("none");
	});

	// T02: file exists but is malformed JSON → kind: "malformed"
	it("T02: returns malformed when JSON parse fails", () => {
		mockFs.readFileSync.mockReturnValue("{ not valid json");

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("malformed");
	});

	// T03: stale checkpoint — lastPhase=7 (>4) → kind: "stale"
	it("T03: returns stale when lastPhase > 4 (12-phase legacy)", () => {
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ lastPhase: 7, timestamp: "2026-01-01T00:00:00Z" }),
		);

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("stale");
		if (result.kind === "stale") {
			expect(result.reason).toContain("lastPhase=7 > 4");
		}
	});

	// T04: stale checkpoint — "mode" key present → kind: "stale"
	it("T04: returns stale when mode key is present (legacy 12-phase format)", () => {
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ lastPhase: 4, timestamp: "2026-01-01T00:00:00Z", mode: "fast" }),
		);

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("stale");
		if (result.kind === "stale") {
			expect(result.reason).toContain('"mode"');
		}
	});

	it("returns stale when phase-7-substep-map key is present", () => {
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				lastPhase: 3,
				timestamp: "2026-01-01T00:00:00Z",
				"phase-7-substep-map": {},
			}),
		);

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("stale");
		if (result.kind === "stale") {
			expect(result.reason).toContain("phase-7-substep-map");
		}
	});

	it("returns stale when timestamp is missing", () => {
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ lastPhase: 2 }));

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("stale");
	});

	// T05: valid phase 2 checkpoint → kind: "valid"
	it("T05: returns valid for clean 4-phase checkpoint", () => {
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ lastPhase: 2, timestamp: "2026-05-09T00:00:00Z" }),
		);

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("valid");
		if (result.kind === "valid") {
			expect(result.progress.lastPhase).toBe(2);
			expect(result.progress.timestamp).toBe("2026-05-09T00:00:00Z");
		}
	});

	it("returns valid for phase 1", () => {
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ lastPhase: 1, timestamp: "2026-05-09T00:00:00Z" }),
		);

		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("valid");
		if (result.kind === "valid") {
			expect(result.progress.lastPhase).toBe(1);
		}
	});

	it("returns malformed for non-object JSON", () => {
		mockFs.readFileSync.mockReturnValue(JSON.stringify("just a string"));
		const result = readInitProgress("/some/project");
		expect(result.kind).toBe("malformed");
	});
});

describe("writeInitProgress", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFs.mkdirSync.mockImplementation(() => undefined);
		mockFs.writeFileSync.mockImplementation(() => undefined);
	});

	it("writes correct JSON structure for phase 1", () => {
		writeInitProgress("/some/project", 1, "2026-05-09T12:00:00Z");

		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			path.join("/some/project", ".forge", "init-progress.json"),
			expect.stringContaining('"lastPhase": 1'),
			"utf8",
		);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining('"timestamp": "2026-05-09T12:00:00Z"'),
			"utf8",
		);
	});

	it("creates .forge/ directory before writing", () => {
		writeInitProgress("/some/project", 2);
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(
			path.join("/some/project", ".forge"),
			{ recursive: true },
		);
	});

	it("uses current time when timestamp not provided", () => {
		const before = new Date().toISOString();
		writeInitProgress("/some/project", 3);
		const after = new Date().toISOString();

		const calls = mockFs.writeFileSync.mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const content = calls[0][1] as string;
		const parsed = JSON.parse(content) as { timestamp: string };
		expect(parsed.timestamp >= before).toBe(true);
		expect(parsed.timestamp <= after).toBe(true);
	});
});

describe("deleteInitProgress", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("deletes the progress file", () => {
		mockFs.unlinkSync.mockImplementation(() => undefined);
		deleteInitProgress("/some/project");
		expect(mockFs.unlinkSync).toHaveBeenCalledWith(
			path.join("/some/project", ".forge", "init-progress.json"),
		);
	});

	it("ignores ENOENT when file does not exist", () => {
		mockFs.unlinkSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		expect(() => deleteInitProgress("/some/project")).not.toThrow();
	});

	it("rethrows non-ENOENT errors", () => {
		mockFs.unlinkSync.mockImplementation(() => {
			const err = new Error("EACCES") as NodeJS.ErrnoException;
			err.code = "EACCES";
			throw err;
		});

		expect(() => deleteInitProgress("/some/project")).toThrow("EACCES");
	});
});
