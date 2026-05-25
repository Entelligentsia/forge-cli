// verifiers.test.ts — FORGE-S25-T23 (B-4, N-B-A)
// Unit tests for forge-init/verifiers.ts: verifyPhase1/2/3.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPhase1, verifyPhase2, verifyPhase3 } from "../../../../src/extensions/forgecli/forge-init/verifiers.js";

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "verifiers-test-"));
}

function rmTmpDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

function writeConfig(dir: string, obj: Record<string, unknown>): void {
	const forgeDir = path.join(dir, ".forge");
	fs.mkdirSync(forgeDir, { recursive: true });
	fs.writeFileSync(path.join(forgeDir, "config.json"), JSON.stringify(obj), "utf8");
}

const VALID_CONFIG = {
	version: "1",
	project: { name: "Test", prefix: "TST" },
	stack: { primary: ["node"] },
	commands: { test: "npm test" },
	paths: {
		engineering: "engineering",
		store: ".forge/store",
		workflows: ".forge/workflows",
	},
};

// ── verifyPhase1 ────────────────────────────────────────────────────────────

describe("verifyPhase1", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	it("returns ok=true when config.json contains all required fields", () => {
		writeConfig(tmpDir, VALID_CONFIG);
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("returns ok=false when config.json does not exist", () => {
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain(".forge/config.json");
		expect(result.reason).toMatch(/not written/);
	});

	it("returns ok=false when config.json is invalid JSON", () => {
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".forge", "config.json"), "{ not valid json", "utf8");
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/JSON parse failed/);
	});

	it("reports missing version field", () => {
		const cfg = { ...VALID_CONFIG };
		const { version: _v, ...rest } = cfg;
		writeConfig(tmpDir, rest);
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("version");
	});

	it("reports missing project.name", () => {
		writeConfig(tmpDir, { ...VALID_CONFIG, project: { prefix: "TST" } });
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("project.name");
	});

	it("reports missing project.prefix", () => {
		writeConfig(tmpDir, { ...VALID_CONFIG, project: { name: "Test" } });
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("project.prefix");
	});

	it("reports missing stack", () => {
		const { stack: _s, ...rest } = VALID_CONFIG;
		writeConfig(tmpDir, rest);
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("stack");
	});

	it("reports missing commands", () => {
		const { commands: _c, ...rest } = VALID_CONFIG;
		writeConfig(tmpDir, rest);
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("commands");
	});

	it("reports missing paths.engineering", () => {
		writeConfig(tmpDir, { ...VALID_CONFIG, paths: { store: ".forge/store", workflows: ".forge/workflows" } });
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("paths.engineering");
	});

	it("reports missing paths.store", () => {
		writeConfig(tmpDir, { ...VALID_CONFIG, paths: { engineering: "engineering", workflows: ".forge/workflows" } });
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("paths.store");
	});

	it("reports missing paths.workflows", () => {
		writeConfig(tmpDir, { ...VALID_CONFIG, paths: { engineering: "engineering", store: ".forge/store" } });
		const result = verifyPhase1(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("paths.workflows");
	});
});

// ── verifyPhase2 ────────────────────────────────────────────────────────────

describe("verifyPhase2", () => {
	let tmpDir: string;
	const KB_PATH = "engineering";
	const ARCH_DOCS = ["stack", "processes", "database", "routing", "deployment", "entity-model", "stack-checklist"];

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	function writeAllDocs(): void {
		const archDir = path.join(tmpDir, KB_PATH, "architecture");
		fs.mkdirSync(archDir, { recursive: true });
		for (const d of ARCH_DOCS) {
			fs.writeFileSync(path.join(archDir, `${d}.md`), `# ${d}`, "utf8");
		}
	}

	it("returns ok=true when all 7 architecture docs exist", () => {
		writeAllDocs();
		const result = verifyPhase2(tmpDir, KB_PATH);
		expect(result.ok).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("returns ok=false when architecture directory is empty", () => {
		const result = verifyPhase2(tmpDir, KB_PATH);
		expect(result.ok).toBe(false);
		expect(result.missing).toHaveLength(7);
	});

	it("reports the specific missing doc when one is absent", () => {
		writeAllDocs();
		fs.unlinkSync(path.join(tmpDir, KB_PATH, "architecture", "database.md"));
		const result = verifyPhase2(tmpDir, KB_PATH);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain(`${KB_PATH}/architecture/database.md`);
		expect(result.missing).toHaveLength(1);
	});
});

// ── verifyPhase3 ────────────────────────────────────────────────────────────

describe("verifyPhase3", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	function writeAllDirs(): void {
		for (const d of ["workflows", "personas", "skills", "templates"]) {
			const dir = path.join(tmpDir, ".forge", d);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "example.md"), "# example", "utf8");
		}
	}

	it("returns ok=true when all four .forge dirs contain at least one .md file", () => {
		writeAllDirs();
		const result = verifyPhase3(tmpDir);
		expect(result.ok).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("returns ok=false when .forge dirs are empty", () => {
		// Create the dirs but leave them empty
		for (const d of ["workflows", "personas", "skills", "templates"]) {
			fs.mkdirSync(path.join(tmpDir, ".forge", d), { recursive: true });
		}
		const result = verifyPhase3(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toHaveLength(4);
	});

	it("reports empty dir by name when one dir has no .md or .json files", () => {
		writeAllDirs();
		// Remove the only file from "skills"
		fs.unlinkSync(path.join(tmpDir, ".forge", "skills", "example.md"));
		const result = verifyPhase3(tmpDir);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain(".forge/skills/ (empty)");
		expect(result.missing).toHaveLength(1);
	});

	it("accepts .json files as valid content (not just .md)", () => {
		for (const d of ["workflows", "personas", "skills", "templates"]) {
			const dir = path.join(tmpDir, ".forge", d);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "data.json"), "{}", "utf8");
		}
		const result = verifyPhase3(tmpDir);
		expect(result.ok).toBe(true);
	});
});
