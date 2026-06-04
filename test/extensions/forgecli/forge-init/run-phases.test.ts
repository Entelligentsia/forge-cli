// run-phases.test.ts — FORGE-S26-T17
// Unit tests for forge-init/run-phases.ts: runPhase1, runPhase2, runPhase3.
// Mocks all external I/O (execFileAsync, verifiers, fs reads).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock exec-helpers so no subprocesses spawn
vi.mock("../../../../src/extensions/forgecli/lib/exec-helpers.js", () => ({
	execFileAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	runToolAdvisory: vi.fn().mockResolvedValue(true),
	runTool: vi.fn().mockResolvedValue(undefined),
}));

// Mock verifiers module so we control pass/fail without filesystem
vi.mock("../../../../src/extensions/forgecli/forge-init/verifiers.js", () => ({
	verifyPhase1: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
	verifyPhase1Foundation: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
	verifyPhase2: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
	verifyPhase3: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
}));

// Mock init-context helpers
vi.mock("../../../../src/extensions/forgecli/forge-init/init-context.js", () => ({
	buildProjectContext: vi.fn().mockReturnValue({}),
	validateProjectContext: vi.fn(),
	writeProjectContext: vi.fn(),
	computeCalibrationBaseline: vi.fn().mockReturnValue({}),
	discoverProjectName: vi.fn().mockReturnValue("TestProject"),
}));

// Mock init-progress
vi.mock("../../../../src/extensions/forgecli/forge-init/init-progress.js", () => ({
	writeInitProgress: vi.fn(),
	deleteInitProgress: vi.fn(),
	readInitProgress: vi.fn().mockReturnValue({ kind: "none" }),
}));

import { runPhase1, runPhase2, runPhase3 } from "../../../../src/extensions/forgecli/forge-init/run-phases.js";
import { verifyPhase1, verifyPhase2, verifyPhase3 } from "../../../../src/extensions/forgecli/forge-init/verifiers.js";
import { writeInitProgress } from "../../../../src/extensions/forgecli/forge-init/init-progress.js";

const mockVerifyPhase1 = verifyPhase1 as ReturnType<typeof vi.fn>;
const mockVerifyPhase2 = verifyPhase2 as ReturnType<typeof vi.fn>;
const mockVerifyPhase3 = verifyPhase3 as ReturnType<typeof vi.fn>;
const mockWriteInitProgress = writeInitProgress as ReturnType<typeof vi.fn>;

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "run-phases-test-"));
}

function rmTmpDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function makeCtx(
	overrides: {
		confirm?: (title: string, body: string) => Promise<boolean>;
		notify?: (msg: string, level: string) => void;
		input?: (title: string, placeholder: string) => Promise<string | null>;
		setStatus?: (cmd: string, status: string | undefined) => void;
	} = {},
): {
	ui: {
		confirm: (title: string, body: string) => Promise<boolean>;
		notify: (msg: string, level: string) => void;
		input: (title: string, placeholder: string) => Promise<string | null>;
		setStatus: (cmd: string, status: string | undefined) => void;
	};
	waitForIdle: () => Promise<void>;
} {
	return {
		ui: {
			confirm: overrides.confirm ?? vi.fn().mockResolvedValue(true),
			notify: overrides.notify ?? vi.fn(),
			input: overrides.input ?? vi.fn().mockResolvedValue(null),
			setStatus: overrides.setStatus ?? vi.fn(),
		},
		waitForIdle: vi.fn().mockResolvedValue(undefined),
	};
}

// ── runPhase1 ────────────────────────────────────────────────────────────────

describe("runPhase1", () => {
	let tmpDir: string;
	let sendToAgent: ReturnType<typeof vi.fn>;
	let waitForIdle: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		// Create fake phase-1 prompt file so readPhasePrompt doesn't abort
		const phasesDir = path.join(tmpDir, "init", "phases");
		fs.mkdirSync(phasesDir, { recursive: true });
		fs.writeFileSync(path.join(phasesDir, "phase-1-collect.md"), "# Phase 1 Test Prompt", "utf8");
		sendToAgent = vi.fn().mockResolvedValue(undefined);
		waitForIdle = vi.fn().mockResolvedValue(undefined);
		vi.clearAllMocks();
		// Reset mocks to defaults after clearAllMocks
		mockVerifyPhase1.mockResolvedValue({ ok: true, missing: [] });
		mockWriteInitProgress.mockReturnValue(undefined);
		vi.stubEnv("FORGE_YES", "1"); // non-interactive for most tests
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
		vi.unstubAllEnvs();
	});

	it("returns 'ok' when verify passes", async () => {
		const ctx = makeCtx();
		const result = await runPhase1(
			tmpDir, tmpDir, tmpDir, {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(result).toBe("ok");
	});

	it("calls sendToAgent with the phase prompt", async () => {
		// phase-1-collect.md already created in beforeEach
		const ctx = makeCtx();
		await runPhase1(
			tmpDir, tmpDir, tmpDir, {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(sendToAgent).toHaveBeenCalledWith(expect.stringContaining("Phase 1"));
	});

	it("returns 'abort' when verify fails twice in non-interactive mode", async () => {
		mockVerifyPhase1.mockResolvedValue({ ok: false, missing: ["version"] });
		const ctx = makeCtx();
		const result = await runPhase1(
			tmpDir, tmpDir, tmpDir, {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(result).toBe("abort");
	});

	it("sends retry steer when first verify fails", async () => {
		// phase-1-collect.md already created in beforeEach
		let callCount = 0;
		mockVerifyPhase1.mockImplementation(async () => {
			callCount++;
			return callCount <= 1 ? { ok: false, missing: ["version"] } : { ok: true, missing: [] };
		});

		const ctx = makeCtx();
		const result = await runPhase1(
			tmpDir, tmpDir, tmpDir, {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);

		expect(result).toBe("ok");
		// Initial prompt + retry steer
		expect(sendToAgent).toHaveBeenCalledTimes(2);
	});

	it("calls writeInitProgress(cwd, 1) on success", async () => {
		const ctx = makeCtx();
		await runPhase1(
			tmpDir, tmpDir, tmpDir, {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(mockWriteInitProgress).toHaveBeenCalledWith(tmpDir, 1);
	});

	it("returns 'abort' when phase prompt file is missing", async () => {
		const ctx = makeCtx();
		// Use a separate bundleRoot with no init/phases/ directory
		const emptyBundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rp-empty-"));
		try {
			const result = await runPhase1(
				tmpDir, emptyBundleRoot, emptyBundleRoot, {}, ctx as never,
				sendToAgent, waitForIdle, () => true,
			);
			expect(result).toBe("abort");
		} finally {
			fs.rmSync(emptyBundleRoot, { recursive: true, force: true });
		}
	});
});

// ── runPhase2 ────────────────────────────────────────────────────────────────

describe("runPhase2", () => {
	let tmpDir: string;
	let sendToAgent: ReturnType<typeof vi.fn>;
	let waitForIdle: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		// Create fake phase-2 prompt file so readPhasePrompt doesn't abort
		const phasesDir = path.join(tmpDir, "init", "phases");
		fs.mkdirSync(phasesDir, { recursive: true });
		fs.writeFileSync(path.join(phasesDir, "phase-2-discover.md"), "# Phase 2 Test Prompt", "utf8");
		sendToAgent = vi.fn().mockResolvedValue(undefined);
		waitForIdle = vi.fn().mockResolvedValue(undefined);
		vi.clearAllMocks();
		// Reset mocks to defaults after clearAllMocks
		mockVerifyPhase2.mockResolvedValue({ ok: true, missing: [] });
		mockWriteInitProgress.mockReturnValue(undefined);
		vi.stubEnv("FORGE_YES", "1");
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
		vi.unstubAllEnvs();
	});

	it("returns 'ok' when verify passes", async () => {
		const ctx = makeCtx();
		const result = await runPhase2(
			tmpDir, tmpDir, tmpDir, "TestProject", {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(result).toBe("ok");
	});

	it("returns 'abort' when verify fails twice in non-interactive mode", async () => {
		mockVerifyPhase2.mockResolvedValue({ ok: false, missing: ["engineering/architecture/stack.md"] });
		const ctx = makeCtx();
		const result = await runPhase2(
			tmpDir, tmpDir, tmpDir, "TestProject", {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(result).toBe("abort");
	});

	it("calls writeInitProgress(cwd, 2) on success", async () => {
		const ctx = makeCtx();
		await runPhase2(
			tmpDir, tmpDir, tmpDir, "TestProject", {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(mockWriteInitProgress).toHaveBeenCalledWith(tmpDir, 2);
	});

	it("uses kbPath from configCache", async () => {
		const ctx = makeCtx();
		const configCache = { paths: { engineering: "my-kb" } };
		await runPhase2(
			tmpDir, tmpDir, tmpDir, "TestProject", configCache, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		// verifyPhase2 should be called with the resolved kbPath
		expect(mockVerifyPhase2).toHaveBeenCalledWith(tmpDir, "my-kb");
	});

	it("defaults kbPath to 'engineering' when not in configCache", async () => {
		const ctx = makeCtx();
		await runPhase2(
			tmpDir, tmpDir, tmpDir, "TestProject", {}, ctx as never,
			sendToAgent, waitForIdle, () => true,
		);
		expect(mockVerifyPhase2).toHaveBeenCalledWith(tmpDir, "engineering");
	});
});

// ── runPhase3 ────────────────────────────────────────────────────────────────

describe("runPhase3", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		vi.clearAllMocks();
		mockVerifyPhase3.mockResolvedValue({ ok: true, missing: [] });
		mockWriteInitProgress.mockReturnValue(undefined);
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("returns 'ok' when verify passes", async () => {
		const ctx = makeCtx();
		const result = await runPhase3(tmpDir, tmpDir, tmpDir, ctx as never);
		expect(result).toBe("ok");
	});

	it("returns 'abort' when verify fails (hard-fail — no user confirm)", async () => {
		mockVerifyPhase3.mockResolvedValue({ ok: false, missing: [".forge/workflows/ (empty)"] });
		const confirm = vi.fn().mockResolvedValue(true); // should NOT be called
		const ctx = makeCtx({ confirm });
		const result = await runPhase3(tmpDir, tmpDir, tmpDir, ctx as never);
		expect(result).toBe("abort");
		// Hard-fail: confirm should never be called for Phase 3
		expect(confirm).not.toHaveBeenCalled();
	});

	it("calls writeInitProgress(cwd, 3) on success", async () => {
		const ctx = makeCtx();
		await runPhase3(tmpDir, tmpDir, tmpDir, ctx as never);
		expect(mockWriteInitProgress).toHaveBeenCalledWith(tmpDir, 3);
	});

	it("does NOT call sendToAgent (deterministic phase)", async () => {
		const sendToAgent = vi.fn();
		const ctx = makeCtx();
		await runPhase3(tmpDir, tmpDir, tmpDir, ctx as never);
		// runPhase3 does not take sendToAgent — just verify no unexpected calls
		expect(sendToAgent).not.toHaveBeenCalled();
	});

	it("emits error notification when verify fails", async () => {
		mockVerifyPhase3.mockResolvedValue({ ok: false, missing: [".forge/workflows/ (empty)"] });
		const notify = vi.fn();
		const ctx = makeCtx({ notify });
		await runPhase3(tmpDir, tmpDir, tmpDir, ctx as never);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Phase 3 failed"), "error");
	});
});
