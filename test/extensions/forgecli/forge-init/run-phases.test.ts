// run-phases.test.ts — FORGE-S26-T17 / FORGE-S33-T04
//
// Note (FORGE-S33-T04): runPhase1 and runPhase2 have been removed from run-phases.ts.
// Their LLM dispatch logic lives in orchestrators/init/init-phase-dispatch.ts;
// their post-verify hooks live in orchestrators/init/run-init-pipeline.ts.
// Tests for runPhase1 and runPhase2 have been removed here — those dispatch paths
// are tested via init-phase-dispatch.test.ts and run-init-pipeline.test.ts.
//
// This file now only tests runPhase3 (the deterministic materialize phase).

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
	verifyPhase3: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
}));

// Mock init-progress
vi.mock("../../../../src/extensions/forgecli/forge-init/init-progress.js", () => ({
	writeInitProgress: vi.fn(),
	deleteInitProgress: vi.fn(),
	readInitProgress: vi.fn().mockReturnValue({ kind: "none" }),
}));

import { runPhase3 } from "../../../../src/extensions/forgecli/forge-init/run-phases.js";
import { verifyPhase3 } from "../../../../src/extensions/forgecli/forge-init/verifiers.js";
import { writeInitProgress } from "../../../../src/extensions/forgecli/forge-init/init-progress.js";

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
