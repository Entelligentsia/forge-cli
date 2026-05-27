// verifiers.test.ts — FORGE-S26-T17
// Unit tests for rewritten forge-init/verifiers.ts: async wrappers over verify-phase.cjs.
// Tests mock execFileAsync so no actual subprocess is spawned.

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the exec-helpers module so execFileAsync is controllable in tests
vi.mock("../../../../src/extensions/forgecli/lib/exec-helpers.js", () => ({
	execFileAsync: vi.fn(),
}));

import { execFileAsync } from "../../../../src/extensions/forgecli/lib/exec-helpers.js";
import {
	verifyPhase1,
	verifyPhase1Foundation,
	verifyPhase2,
	verifyPhase3,
	type VerifyResult,
} from "../../../../src/extensions/forgecli/forge-init/verifiers.js";

const mockExecFileAsync = execFileAsync as ReturnType<typeof vi.fn>;

/** Simulate exit 0 (pass). */
function mockPass(): void {
	mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
}

/** Simulate exit 1 with JSON output (fail). */
function mockFail(result: Partial<VerifyResult>): void {
	const err = Object.assign(new Error("Process exited with code 1"), {
		code: 1,
		stdout: JSON.stringify({ ok: false, missing: result.missing ?? [], reason: result.reason }),
		stderr: "",
	});
	mockExecFileAsync.mockRejectedValue(err);
}

/** Simulate a generic execution error (not exit 1). */
function mockError(msg: string): void {
	const err = Object.assign(new Error(msg), { code: 2, stdout: "", stderr: msg });
	mockExecFileAsync.mockRejectedValue(err);
}

/** Dummy cwd — resolveVerifyPhaseTool uses this to look for config.json (fails gracefully). */
const DUMMY_CWD = "/nonexistent/project";

// ── verifyPhase1 ────────────────────────────────────────────────────────────

describe("verifyPhase1", () => {
	beforeEach(() => { vi.clearAllMocks(); });
	afterEach(() => { vi.clearAllMocks(); });

	it("returns ok=true when verify-phase.cjs exits 0", async () => {
		mockPass();
		const result = await verifyPhase1(DUMMY_CWD);
		expect(result.ok).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("calls execFileAsync with --phase 1 argv array", async () => {
		mockPass();
		await verifyPhase1(DUMMY_CWD);
		expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
		const [cmd, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("node");
		expect(args).toContain("--phase");
		expect(args).toContain("1");
		// Must NOT contain --foundation-only
		expect(args).not.toContain("--foundation-only");
	});

	it("returns ok=false with missing list when verify-phase.cjs exits 1", async () => {
		mockFail({ missing: ["project.name", "version"] });
		const result = await verifyPhase1(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("project.name");
		expect(result.missing).toContain("version");
	});

	it("returns ok=false when config.json is not found (missing .forge/config.json)", async () => {
		mockFail({ missing: [".forge/config.json"], reason: "config file not written" });
		const result = await verifyPhase1(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain(".forge/config.json");
		expect(result.reason).toMatch(/config file not written/);
	});

	it("returns ok=false with reason on malformed JSON output from verify-phase", async () => {
		const err = Object.assign(new Error("exit 1"), { code: 1, stdout: "not-json", stderr: "" });
		mockExecFileAsync.mockRejectedValue(err);
		const result = await verifyPhase1(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/non-parseable/);
	});

	it("returns ok=false on general execution error (not exit 1)", async () => {
		mockError("ENOENT: verify-phase.cjs not found");
		const result = await verifyPhase1(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/verify-phase.cjs failed/);
	});
});

// ── verifyPhase1Foundation ──────────────────────────────────────────────────

describe("verifyPhase1Foundation", () => {
	beforeEach(() => { vi.clearAllMocks(); });
	afterEach(() => { vi.clearAllMocks(); });

	it("returns ok=true when verify-phase.cjs exits 0", async () => {
		mockPass();
		const result = await verifyPhase1Foundation(DUMMY_CWD);
		expect(result.ok).toBe(true);
	});

	it("calls execFileAsync with --phase 1 --foundation-only argv array", async () => {
		mockPass();
		await verifyPhase1Foundation(DUMMY_CWD);
		const [cmd, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("node");
		expect(args).toContain("--phase");
		expect(args).toContain("1");
		expect(args).toContain("--foundation-only");
	});

	it("returns ok=false when project.name is missing", async () => {
		mockFail({ missing: ["project.name"] });
		const result = await verifyPhase1Foundation(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("project.name");
	});

	it("returns ok=false when project.prefix is missing", async () => {
		mockFail({ missing: ["project.prefix"] });
		const result = await verifyPhase1Foundation(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("project.prefix");
	});
});

// ── verifyPhase2 ────────────────────────────────────────────────────────────

describe("verifyPhase2", () => {
	beforeEach(() => { vi.clearAllMocks(); });
	afterEach(() => { vi.clearAllMocks(); });

	it("returns ok=true when all 7 arch docs exist", async () => {
		mockPass();
		const result = await verifyPhase2(DUMMY_CWD, "engineering");
		expect(result.ok).toBe(true);
	});

	it("calls execFileAsync with --phase 2 --kb-path <kbPath> argv array", async () => {
		mockPass();
		await verifyPhase2(DUMMY_CWD, "my-kb");
		const [cmd, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("node");
		expect(args).toContain("--phase");
		expect(args).toContain("2");
		expect(args).toContain("--kb-path");
		expect(args).toContain("my-kb");
	});

	it("returns ok=false with missing docs list when exit 1", async () => {
		mockFail({ missing: ["engineering/architecture/database.md"] });
		const result = await verifyPhase2(DUMMY_CWD, "engineering");
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("engineering/architecture/database.md");
	});

	it("passes the kbPath argument verbatim", async () => {
		mockPass();
		await verifyPhase2(DUMMY_CWD, "custom-kb");
		const [, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
		const kbIdx = args.indexOf("--kb-path");
		expect(args[kbIdx + 1]).toBe("custom-kb");
	});
});

// ── verifyPhase3 ────────────────────────────────────────────────────────────

describe("verifyPhase3", () => {
	beforeEach(() => { vi.clearAllMocks(); });
	afterEach(() => { vi.clearAllMocks(); });

	it("returns ok=true when all dirs are non-empty", async () => {
		mockPass();
		const result = await verifyPhase3(DUMMY_CWD);
		expect(result.ok).toBe(true);
	});

	it("calls execFileAsync with --phase 3 argv array", async () => {
		mockPass();
		await verifyPhase3(DUMMY_CWD);
		const [cmd, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("node");
		expect(args).toContain("--phase");
		expect(args).toContain("3");
	});

	it("returns ok=false with empty dir names when exit 1", async () => {
		mockFail({ missing: [".forge/workflows/ (empty)", ".forge/personas/ (empty)"] });
		const result = await verifyPhase3(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain(".forge/workflows/ (empty)");
	});

	it("returns ok=false on general execution error", async () => {
		mockError("spawn error");
		const result = await verifyPhase3(DUMMY_CWD);
		expect(result.ok).toBe(false);
		expect(result.reason).toBeTruthy();
	});
});

// ── VerifyResult interface shape ────────────────────────────────────────────

describe("VerifyResult interface", () => {
	it("is exported from verifiers.ts", () => {
		// Type-level test: ensure the import compiles
		const r: VerifyResult = { ok: true, missing: [] };
		expect(r.ok).toBe(true);
	});
});
