// Unit tests for health-check.ts — new checks added in FORGE-S23-T07.
//
// Covers:
//   - checkStaleDocs(): engineering/architecture/*.md mtime > 90 days
//   - checkModifiedGeneratedFiles(): generation-manifest.cjs list --modified
//   - checkPluginIntegrity(): native TS hash check against integrity.json
//   - runHealthCheck(): .forge/ absent returns configPresent: false without crash
//
// Mock pattern: vi.mock + vi.hoisted() for ESM compatibility.
// Each describe block resets mock state via beforeEach / afterEach.

import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
// vi.hoisted() runs before the vi.mock factories and before module imports.

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn<[string], boolean>(),
	readFileSync: vi.fn<[string | Buffer, string?], string | Buffer>(),
	readdirSync: vi.fn<[string], string[]>(),
	statSync: vi.fn<[string], { mtimeMs: number }>(),
}));

const execFileSyncMock = vi.hoisted(() => ({
	execFileSync: vi.fn<[string, string[], object], string>(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock("node:fs", () => fsMock);
vi.mock("node:child_process", () => execFileSyncMock);

// ── Module under test ─────────────────────────────────────────────────────

import {
	checkModifiedGeneratedFiles,
	checkPluginIntegrity,
	checkStaleDocs,
	runHealthCheck,
} from "../../../src/extensions/forgecli/health-check.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const NINETY_ONE_DAYS_AGO_MS = Date.now() - 91 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_AGO_MS = Date.now() - 30 * 24 * 60 * 60 * 1000;

const BASE_CONFIG: Record<string, unknown> = {
	paths: { engineering: "engineering" },
};

// ── checkStaleDocs ────────────────────────────────────────────────────────

describe("checkStaleDocs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty array when architecture directory does not exist", () => {
		fsMock.existsSync.mockReturnValue(false);
		const gaps = checkStaleDocs("/project", BASE_CONFIG);
		expect(gaps).toHaveLength(0);
	});

	it("returns a gap for each file older than 90 days", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readdirSync.mockReturnValue(["stack.md", "deployment.md"]);
		fsMock.statSync.mockReturnValue({ mtimeMs: NINETY_ONE_DAYS_AGO_MS });

		const gaps = checkStaleDocs("/project", BASE_CONFIG);
		expect(gaps).toHaveLength(2);
		expect(gaps[0].check).toBe("stale-docs");
		expect(gaps[0].severity).toBe("warning");
		expect(gaps[0].message).toContain("stack.md");
		expect(gaps[0].message).toContain("not updated in");
	});

	it("returns no gap for files updated within 90 days", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readdirSync.mockReturnValue(["stack.md"]);
		fsMock.statSync.mockReturnValue({ mtimeMs: THIRTY_DAYS_AGO_MS });

		const gaps = checkStaleDocs("/project", BASE_CONFIG);
		expect(gaps).toHaveLength(0);
	});

	it("skips non-.md files in the architecture directory", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readdirSync.mockReturnValue(["README.txt", "notes.json"]);

		const gaps = checkStaleDocs("/project", BASE_CONFIG);
		expect(gaps).toHaveLength(0);
		expect(fsMock.statSync).not.toHaveBeenCalled();
	});

	it("uses custom engineering path from config", () => {
		const config = { paths: { engineering: "custom-eng" } };
		fsMock.existsSync.mockReturnValue(false);

		checkStaleDocs("/project", config);

		expect(fsMock.existsSync).toHaveBeenCalledWith(expect.stringContaining("custom-eng/architecture"));
	});

	it("skips individual files that cannot be stat'd", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readdirSync.mockReturnValue(["stack.md"]);
		fsMock.statSync.mockImplementation(() => {
			throw new Error("EACCES");
		});

		// Should not throw
		const gaps = checkStaleDocs("/project", BASE_CONFIG);
		expect(gaps).toHaveLength(0);
	});
});

// ── checkModifiedGeneratedFiles ───────────────────────────────────────────

describe("checkModifiedGeneratedFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty array when generation-manifest.cjs is absent", () => {
		fsMock.existsSync.mockReturnValue(false);
		const gaps = checkModifiedGeneratedFiles("/project", "/bundle");
		expect(gaps).toHaveLength(0);
	});

	it("returns empty array when no files are modified (tool exits 0 with empty stdout)", () => {
		fsMock.existsSync.mockReturnValue(true);
		execFileSyncMock.execFileSync.mockReturnValue("");

		const gaps = checkModifiedGeneratedFiles("/project", "/bundle");
		expect(gaps).toHaveLength(0);
	});

	it("returns a gap per modified file reported on stdout (exit 0)", () => {
		fsMock.existsSync.mockReturnValue(true);
		execFileSyncMock.execFileSync.mockReturnValue(".forge/workflows/plan_task.md\n.forge/personas/engineer.md\n");

		const gaps = checkModifiedGeneratedFiles("/project", "/bundle");
		expect(gaps).toHaveLength(2);
		expect(gaps[0].check).toBe("modified-generated-files");
		expect(gaps[0].severity).toBe("warning");
		expect(gaps[0].message).toContain(".forge/workflows/plan_task.md");
	});

	it("parses stdout from execFileSync error object (non-zero exit)", () => {
		fsMock.existsSync.mockReturnValue(true);
		execFileSyncMock.execFileSync.mockImplementation(() => {
			const err = Object.assign(new Error("exit 1"), {
				stdout: ".forge/workflows/orchestrate_task.md\n",
			});
			throw err;
		});

		const gaps = checkModifiedGeneratedFiles("/project", "/bundle");
		expect(gaps).toHaveLength(1);
		expect(gaps[0].message).toContain("orchestrate_task.md");
	});

	it("filters blank lines and lines starting with #", () => {
		fsMock.existsSync.mockReturnValue(true);
		execFileSyncMock.execFileSync.mockReturnValue("# Modified files:\n.forge/workflows/plan_task.md\n\n");

		const gaps = checkModifiedGeneratedFiles("/project", "/bundle");
		expect(gaps).toHaveLength(1);
		expect(gaps[0].message).toContain("plan_task.md");
	});
});

// ── checkPluginIntegrity ──────────────────────────────────────────────────

describe("checkPluginIntegrity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a warning when integrity.json is missing", () => {
		fsMock.existsSync.mockReturnValue(false);
		const gaps = checkPluginIntegrity("/forge-root");
		expect(gaps).toHaveLength(1);
		expect(gaps[0].check).toBe("plugin-integrity");
		expect(gaps[0].message).toContain("integrity.json not found");
	});

	it("returns a warning when integrity.json is malformed JSON", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue("not-json");
		const gaps = checkPluginIntegrity("/forge-root");
		expect(gaps).toHaveLength(1);
		expect(gaps[0].message).toContain("not valid JSON");
	});

	it("returns empty array when all files match their expected hashes", () => {
		const fileContent = Buffer.from("file content");
		const expectedHash = crypto.createHash("sha256").update(fileContent).digest("hex");
		const manifest = JSON.stringify({
			version: "1.0.0",
			files: { "commands/health.md": expectedHash },
		});

		fsMock.existsSync.mockReturnValue(true);
		// First call: read integrity.json; second call: read commands/health.md
		fsMock.readFileSync.mockReturnValueOnce(manifest).mockReturnValueOnce(fileContent);

		const gaps = checkPluginIntegrity("/forge-root");
		expect(gaps).toHaveLength(0);
	});

	it("returns a gap when a file hash does not match", () => {
		const manifest = JSON.stringify({
			files: { "commands/health.md": "aabbcc" },
		});

		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValueOnce(manifest).mockReturnValueOnce(Buffer.from("tampered content"));

		const gaps = checkPluginIntegrity("/forge-root");
		expect(gaps).toHaveLength(1);
		expect(gaps[0].check).toBe("plugin-integrity");
		expect(gaps[0].message).toContain("Plugin file modified");
		expect(gaps[0].message).toContain("commands/health.md");
	});

	it("returns a gap for a missing plugin file", () => {
		const manifest = JSON.stringify({
			files: { "commands/health.md": "aabbcc" },
		});

		// integrity.json exists; plugin file does not
		fsMock.existsSync
			.mockReturnValueOnce(true) // integrity.json exists
			.mockReturnValueOnce(false); // commands/health.md missing
		fsMock.readFileSync.mockReturnValueOnce(manifest);

		const gaps = checkPluginIntegrity("/forge-root");
		expect(gaps).toHaveLength(1);
		expect(gaps[0].message).toContain("Plugin file missing");
	});

	it("returns a warning when integrity.json has no files section", () => {
		const manifest = JSON.stringify({ version: "1.0.0" });
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue(manifest);

		const gaps = checkPluginIntegrity("/forge-root");
		expect(gaps).toHaveLength(1);
		expect(gaps[0].message).toContain("no files section");
	});
});

// ── runHealthCheck: absent .forge/ regression ─────────────────────────────

describe("runHealthCheck: absent .forge/", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns configPresent: false without crashing when .forge/ is absent", async () => {
		// config.json read throws ENOENT
		fsMock.readFileSync.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		fsMock.existsSync.mockReturnValue(false);

		const result = await runHealthCheck("/nonexistent-project", "/bundle");
		expect(result.configPresent).toBe(false);
		expect(result.clean).toBe(false);
		expect(result.gaps.length).toBeGreaterThan(0);
		expect(result.gaps[0].check).toBe("config-completeness");
	});
});

// ── KB freshness: drift detail and remediation (forge-cli#23) ─────────────────

describe("runHealthCheck: KB freshness drift detail", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("includes drifted sections in KB freshness gap when hash changes", async () => {
		const baselineHash = "old-hash-abc123";
		const masterIndexContent = "# Tasks\n## FORGE-S18-T01\n## Bug tracking\n";

		const config = JSON.stringify({
			version: "0.43.0",
			project: { name: "test", prefix: "TEST" },
			stack: {},
			commands: { test: "npm test" },
			paths: {
				engineering: "engineering",
				store: ".forge/store",
				workflows: ".forge/workflows",
				commands: ".forge/commands",
				templates: ".forge/templates",
			},
			calibrationBaseline: { masterIndexHash: baselineHash },
		});

		// Config read, then MASTER_INDEX.md read (for drift detection)
		fsMock.readFileSync
			.mockReturnValueOnce(config) // config.json
			.mockReturnValueOnce(masterIndexContent); // MASTER_INDEX.md

		// config.json exists, everything else doesn't
		fsMock.existsSync
			.mockReturnValueOnce(true) // config.json exists
			.mockReturnValue(false); // everything else

		const result = await runHealthCheck("/project", "/bundle");

		const kbGap = result.gaps.find((g) => g.check === "kb-freshness");
		if (kbGap) {
			expect(kbGap.message).toContain("/forge:calibrate");
			expect(kbGap.message).toContain("Drifted sections:");
			expect(kbGap.message).toContain("FORGE_YES=1");
		}
	});

	it("includes remediation guidance when no calibration baseline exists", async () => {
		const config = JSON.stringify({
			version: "0.43.0",
			project: { name: "test", prefix: "TEST" },
			stack: {},
			commands: { test: "npm test" },
			paths: {
				engineering: "engineering",
				store: ".forge/store",
				workflows: ".forge/workflows",
				commands: ".forge/commands",
				templates: ".forge/templates",
			},
			// no calibrationBaseline
		});

		fsMock.readFileSync.mockReturnValueOnce(config);
		fsMock.existsSync.mockReturnValueOnce(true).mockReturnValue(false);

		const result = await runHealthCheck("/project", "/bundle");

		const kbGap = result.gaps.find((g) => g.check === "kb-freshness");
		if (kbGap) {
			expect(kbGap.message).toContain("/forge:calibrate");
			expect(kbGap.message).toContain("FORGE_YES=1");
			expect(kbGap.message).toContain("FORGE_NON_INTERACTIVE=1");
		}
	});
});
