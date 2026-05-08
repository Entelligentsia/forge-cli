// init-context.test.ts — Tests for init-context.ts (FORGE-S17-T02)
// Covers T25-T27 from PLAN.md test table.

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);

import {
	discoverProjectName,
	buildProjectContext,
	validateProjectContext,
	computeCalibrationBaseline,
} from "../../../src/extensions/forgecli/init-context.js";

describe("discoverProjectName", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// T25: package.json present → returns package.json:name
	it("T25: returns package.json name when present", () => {
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "my-cool-app", version: "1.0.0" }));

		const result = discoverProjectName("/some/project");
		expect(result).toBe("my-cool-app");
	});

	// T26: no package.json → returns cwd basename
	it("T26: returns cwd basename when package.json is absent", () => {
		mockFs.readFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const result = discoverProjectName("/some/project/my-project");
		expect(result).toBe("my-project");
	});

	it("returns cwd basename when package.json has no name", () => {
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: "1.0.0" }));

		const result = discoverProjectName("/some/project/my-project");
		expect(result).toBe("my-project");
	});

	it("returns cwd basename when package.json name is empty string", () => {
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: "" }));

		const result = discoverProjectName("/some/project/my-project");
		expect(result).toBe("my-project");
	});

	it("handles malformed package.json by returning basename", () => {
		mockFs.readFileSync.mockReturnValue("{ not valid json");

		const result = discoverProjectName("/some/project/my-project");
		expect(result).toBe("my-project");
	});
});

describe("buildProjectContext", () => {
	it("builds context with required fields from config", () => {
		const ctx = buildProjectContext(
			{ projectName: "Test App", prefix: "TST" },
			{ project: { name: "Test App", prefix: "TST" } },
		);

		expect(ctx.project.name).toBe("Test App");
		expect(ctx.project.prefix).toBe("TST");
	});

	it("uses discoveryResults when config lacks project fields", () => {
		const ctx = buildProjectContext(
			{ projectName: "Discovered App", prefix: "DA" },
			{},
		);

		expect(ctx.project.name).toBe("Discovered App");
		expect(ctx.project.prefix).toBe("DA");
	});

	it("config project fields take precedence over discovery", () => {
		const ctx = buildProjectContext(
			{ projectName: "Discovery Name", prefix: "DN" },
			{ project: { name: "Config Name", prefix: "CN" } },
		);

		expect(ctx.project.name).toBe("Config Name");
		expect(ctx.project.prefix).toBe("CN");
	});

	it("includes kbPath from discovery", () => {
		const ctx = buildProjectContext(
			{ projectName: "App", prefix: "APP", kbPath: "custom-kb" },
			{},
		);

		expect(ctx.knowledgeBase?.path).toBe("custom-kb");
	});

	it("defaults kbPath to engineering", () => {
		const ctx = buildProjectContext({ projectName: "App", prefix: "APP" }, {});
		expect(ctx.knowledgeBase?.path).toBe("engineering");
	});

	it("includes workflow commands when provided", () => {
		const ctx = buildProjectContext(
			{ projectName: "App", prefix: "APP", testCommand: "npm test", buildCommand: "npm run build" },
			{},
		);

		expect(ctx.workflow?.testCommand).toBe("npm test");
		expect(ctx.workflow?.buildCommand).toBe("npm run build");
	});
});

describe("validateProjectContext", () => {
	// T27: missing project.name → throws descriptive error
	it("T27: throws when project.name is missing", () => {
		const ctx = { project: { prefix: "APP" } };

		expect(() => validateProjectContext(ctx)).toThrow(/project\.name/);
	});

	it("throws when project is not an object", () => {
		expect(() => validateProjectContext({ project: "string" })).toThrow(/project/);
	});

	it("throws when ctx is not an object", () => {
		expect(() => validateProjectContext("string")).toThrow(/not an object/);
	});

	it("throws when project.prefix is missing", () => {
		const ctx = { project: { name: "My App" } };
		expect(() => validateProjectContext(ctx)).toThrow(/project\.prefix/);
	});

	it("does not throw for valid context", () => {
		const ctx = { project: { name: "My App", prefix: "MA" } };
		expect(() => validateProjectContext(ctx)).not.toThrow();
	});
});

describe("computeCalibrationBaseline", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a baseline with correct fields", () => {
		mockFs.readFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		mockFs.readdirSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const baseline = computeCalibrationBaseline("/proj", "engineering", "0.40.3");

		expect(baseline.version).toBe("0.40.3");
		expect(baseline.masterIndexHash).toBeNull();
		expect(baseline.sprintsCovered).toBe(0);
		expect(typeof baseline.lastCalibrated).toBe("string");
	});

	it("computes masterIndexHash when MASTER_INDEX.md exists", () => {
		mockFs.readFileSync.mockReturnValue("# MASTER_INDEX\n\nContent here");
		mockFs.readdirSync.mockReturnValue([]);

		const baseline = computeCalibrationBaseline("/proj", "engineering", "0.40.3");

		expect(typeof baseline.masterIndexHash).toBe("string");
		expect(baseline.masterIndexHash).not.toBeNull();
		expect(baseline.masterIndexHash!.length).toBe(64); // SHA-256 hex
	});

	it("counts sprint directories", () => {
		mockFs.readFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		mockFs.readdirSync.mockReturnValue([
			{ name: "FORGE-S01", isDirectory: () => true } as unknown as fs.Dirent,
			{ name: "FORGE-S02", isDirectory: () => true } as unknown as fs.Dirent,
			{ name: "MASTER_INDEX.md", isDirectory: () => false } as unknown as fs.Dirent,
		] as fs.Dirent[]);

		const baseline = computeCalibrationBaseline("/proj", "engineering", "0.40.3");
		expect(baseline.sprintsCovered).toBe(2);
	});
});
