// phase-descriptors.test.ts — FORGE-S25-T24 (B-5)
// Unit tests for forge-init/phase-descriptors.ts:
//   - runLlmPhase() runner: happy path, retry steer, abort (non-interactive, interactive)
//   - PHASE_1, PHASE_2, PHASE_3 descriptor objects

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PHASE_1,
	PHASE_2,
	PHASE_3,
	runLlmPhase,
	type LlmPhaseDescriptor,
	type VerifyResult,
} from "../../../../src/extensions/forgecli/forge-init/phase-descriptors.js";

// ── Test utilities ─────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "phase-desc-test-"));
}

function rmTmpDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function makeCtx(overrides: Partial<{
	confirm: (title: string, body: string) => Promise<boolean>;
	notify: (msg: string, level: string) => void;
	input: (title: string, placeholder: string) => Promise<string | null>;
	setStatus: (cmd: string, status: string | undefined) => void;
}> = {}): {
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

function makeOkDescriptor(phaseNum: 1 | 2 | 3 = 1): LlmPhaseDescriptor {
	return {
		phaseNum,
		label: `${phaseNum}/4: Test`,
		bannerName: "Test",
		bannerKey: "forge",
		buildPrompt: () => "test prompt",
		verify: () => ({ ok: true, missing: [] }),
		buildRetrySteer: () => "retry steer",
		nonInteractiveAbortMsg: (r) => `× abort: ${r.missing.join(",")}`,
		interactiveAbortPrompt: (r) => ({ title: "abort?", body: r.missing.join(",") }),
		abortNotify: "× aborted",
		partialContinueNotify: "△ continuing",
		completeNotify: "〇 complete",
	};
}

function makeFailDescriptor(phaseNum: 1 | 2 | 3 = 1, failCount = 1): LlmPhaseDescriptor {
	let callCount = 0;
	return {
		phaseNum,
		label: `${phaseNum}/4: Test`,
		bannerName: "Test",
		bannerKey: "forge",
		buildPrompt: () => "test prompt",
		verify: (): VerifyResult => {
			callCount++;
			if (callCount <= failCount) return { ok: false, missing: ["field-x"] };
			return { ok: true, missing: [] };
		},
		buildRetrySteer: () => "retry steer for field-x",
		nonInteractiveAbortMsg: () => "× failed non-interactive",
		interactiveAbortPrompt: () => ({ title: "failed?", body: "still missing field-x" }),
		abortNotify: "× aborted",
		partialContinueNotify: "△ continuing",
		completeNotify: "〇 complete",
	};
}

// ── runLlmPhase — happy path ───────────────────────────────────────────────

describe("runLlmPhase — happy path", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
		vi.stubEnv("FORGE_YES", "");
		vi.stubEnv("FORGE_NON_INTERACTIVE", "");
	});
	afterEach(() => {
		rmTmpDir(tmpDir);
		vi.unstubAllEnvs();
	});

	it("returns 'ok' when verify passes on first attempt", async () => {
		const ctx = makeCtx();
		const desc = makeOkDescriptor(1);
		// Create init-progress dir
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });

		const result = await runLlmPhase(
			desc,
			ctx as never,
			tmpDir,
			tmpDir,
			tmpDir,
			"TestProject",
			{},
			vi.fn(),
			vi.fn().mockResolvedValue(undefined),
			() => false,
		);

		expect(result).toBe("ok");
	});

	it("calls sendToAgent with the built prompt", async () => {
		const ctx = makeCtx();
		const sendToAgent = vi.fn();
		const desc = makeOkDescriptor(1);
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, sendToAgent, vi.fn().mockResolvedValue(undefined), () => false);

		expect(sendToAgent).toHaveBeenCalledWith("test prompt");
	});

	it("calls waitForIdle after sendToAgent", async () => {
		const ctx = makeCtx();
		const waitForIdle = vi.fn().mockResolvedValue(undefined);
		const desc = makeOkDescriptor(1);
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, vi.fn(), waitForIdle, () => false);

		expect(waitForIdle).toHaveBeenCalledTimes(1);
	});

	it("calls postVerify when verify succeeds", async () => {
		const postVerify = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx();
		const desc: LlmPhaseDescriptor = { ...makeOkDescriptor(1), postVerify };
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, vi.fn(), vi.fn().mockResolvedValue(undefined), () => false);

		expect(postVerify).toHaveBeenCalledTimes(1);
	});

	it("writes init-progress marker on success", async () => {
		const ctx = makeCtx();
		const desc = makeOkDescriptor(1);
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, vi.fn(), vi.fn().mockResolvedValue(undefined), () => false);

		expect(fs.existsSync(path.join(tmpDir, ".forge", "init-progress.json"))).toBe(true);
	});
});

// ── runLlmPhase — retry steer ──────────────────────────────────────────────

describe("runLlmPhase — retry steer", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		vi.stubEnv("FORGE_YES", "");
		vi.stubEnv("FORGE_NON_INTERACTIVE", "");
	});
	afterEach(() => {
		rmTmpDir(tmpDir);
		vi.unstubAllEnvs();
	});

	it("sends retry steer when first verify fails", async () => {
		const sendToAgent = vi.fn();
		const ctx = makeCtx();
		const desc = makeFailDescriptor(1, 1); // fails first, passes on retry

		const result = await runLlmPhase(
			desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {},
			sendToAgent, vi.fn().mockResolvedValue(undefined), () => false,
		);

		expect(result).toBe("ok");
		// First call: initial prompt. Second call: retry steer.
		expect(sendToAgent).toHaveBeenCalledTimes(2);
		expect(sendToAgent.mock.calls[1][0]).toContain("retry steer");
	});

	it("calls waitForIdle twice when retry is needed", async () => {
		const waitForIdle = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx();
		const desc = makeFailDescriptor(1, 1);

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, vi.fn(), waitForIdle, () => false);

		expect(waitForIdle).toHaveBeenCalledTimes(2);
	});
});

// ── runLlmPhase — abort paths ──────────────────────────────────────────────

describe("runLlmPhase — abort: non-interactive mode", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		vi.stubEnv("FORGE_YES", "1");
	});
	afterEach(() => {
		rmTmpDir(tmpDir);
		vi.unstubAllEnvs();
	});

	it("returns 'abort' when verify fails twice in non-interactive mode", async () => {
		const ctx = makeCtx();
		const desc = makeFailDescriptor(1, 99); // always fails

		const result = await runLlmPhase(
			desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {},
			vi.fn(), vi.fn().mockResolvedValue(undefined), () => true,
		);

		expect(result).toBe("abort");
	});

	it("emits nonInteractiveAbortMsg when aborting", async () => {
		const notify = vi.fn();
		const ctx = makeCtx({ notify });
		const desc = makeFailDescriptor(1, 99);

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, vi.fn(), vi.fn().mockResolvedValue(undefined), () => true);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("failed non-interactive"), "error");
	});
});

describe("runLlmPhase — abort: interactive confirm-no", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		vi.stubEnv("FORGE_YES", "");
		vi.stubEnv("FORGE_NON_INTERACTIVE", "");
	});
	afterEach(() => {
		rmTmpDir(tmpDir);
		vi.unstubAllEnvs();
	});

	it("returns 'abort' when user declines to continue after double failure", async () => {
		const ctx = makeCtx({ confirm: vi.fn().mockResolvedValue(false) });
		const desc = makeFailDescriptor(1, 99);

		const result = await runLlmPhase(
			desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {},
			vi.fn(), vi.fn().mockResolvedValue(undefined), () => false,
		);

		expect(result).toBe("abort");
	});

	it("returns 'ok' with partial continue when user accepts", async () => {
		const ctx = makeCtx({ confirm: vi.fn().mockResolvedValue(true) });
		const desc = makeFailDescriptor(1, 99);

		const result = await runLlmPhase(
			desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {},
			vi.fn(), vi.fn().mockResolvedValue(undefined), () => false,
		);

		expect(result).toBe("ok");
	});

	it("calls postVerify on partial-continue", async () => {
		const postVerify = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ confirm: vi.fn().mockResolvedValue(true) });
		const desc: LlmPhaseDescriptor = { ...makeFailDescriptor(1, 99), postVerify };

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, vi.fn(), vi.fn().mockResolvedValue(undefined), () => false);

		expect(postVerify).toHaveBeenCalledTimes(1);
	});
});

// ── runLlmPhase — hardFailOnVerifyError (Phase 3) ─────────────────────────

describe("runLlmPhase — hardFailOnVerifyError", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		vi.stubEnv("FORGE_YES", "");
		vi.stubEnv("FORGE_NON_INTERACTIVE", "");
	});
	afterEach(() => {
		rmTmpDir(tmpDir);
		vi.unstubAllEnvs();
	});

	it("returns 'abort' immediately when hardFailOnVerifyError=true and verify fails", async () => {
		const ctx = makeCtx();
		const desc: LlmPhaseDescriptor = {
			...makeFailDescriptor(3, 99),
			hardFailOnVerifyError: true,
			buildPrompt: () => null,
		};

		const result = await runLlmPhase(
			desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {},
			vi.fn(), vi.fn().mockResolvedValue(undefined), () => false,
		);

		expect(result).toBe("abort");
	});

	it("does NOT call sendToAgent when buildPrompt returns null (deterministic phase)", async () => {
		const sendToAgent = vi.fn();
		const ctx = makeCtx();
		const desc: LlmPhaseDescriptor = { ...makeOkDescriptor(3), buildPrompt: () => null };
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, sendToAgent, vi.fn().mockResolvedValue(undefined), () => false);

		expect(sendToAgent).not.toHaveBeenCalled();
	});

	it("calls runDeterministic when buildPrompt returns null", async () => {
		const runDeterministic = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx();
		const desc: LlmPhaseDescriptor = {
			...makeOkDescriptor(3),
			buildPrompt: () => null,
			runDeterministic,
		};
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });

		await runLlmPhase(desc, ctx as never, tmpDir, tmpDir, tmpDir, "P", {}, vi.fn(), vi.fn().mockResolvedValue(undefined), () => false);

		expect(runDeterministic).toHaveBeenCalledTimes(1);
	});
});

// ── PHASE_1 descriptor ─────────────────────────────────────────────────────

describe("PHASE_1 descriptor", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = makeTmpDir(); });
	afterEach(() => rmTmpDir(tmpDir));

	it("has phaseNum=1 and bannerKey='north'", () => {
		expect(PHASE_1.phaseNum).toBe(1);
		expect(PHASE_1.bannerKey).toBe("north");
	});

	it("buildPrompt returns a non-empty string", () => {
		const prompt = PHASE_1.buildPrompt(tmpDir, tmpDir, "TestProject", {});
		expect(typeof prompt).toBe("string");
		expect(prompt!.length).toBeGreaterThan(50);
	});

	it("verify delegates to verifyPhase1", () => {
		// No config.json → fails
		const result = PHASE_1.verify(tmpDir, {});
		expect(result.ok).toBe(false);
		expect(result.missing).toContain(".forge/config.json");
	});

	it("buildRetrySteer references missing fields", () => {
		const steer = PHASE_1.buildRetrySteer({ ok: false, missing: ["project.name"] }, tmpDir, tmpDir);
		expect(steer).toContain("project.name");
	});

	it("nonInteractiveAbortMsg includes missing field info", () => {
		const msg = PHASE_1.nonInteractiveAbortMsg({ ok: false, missing: ["project.prefix"] });
		expect(msg).toContain("project.prefix");
	});
});

// ── PHASE_2 descriptor ─────────────────────────────────────────────────────

describe("PHASE_2 descriptor", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = makeTmpDir(); });
	afterEach(() => rmTmpDir(tmpDir));

	it("has phaseNum=2 and bannerKey='oracle'", () => {
		expect(PHASE_2.phaseNum).toBe(2);
		expect(PHASE_2.bannerKey).toBe("oracle");
	});

	it("buildPrompt returns non-empty string using configCache kbPath", () => {
		const prompt = PHASE_2.buildPrompt(tmpDir, tmpDir, "P", { paths: { engineering: "my-kb" } });
		expect(typeof prompt).toBe("string");
		expect(prompt!).toContain("my-kb");
	});

	it("buildPrompt uses 'engineering' default when configCache has no kbPath", () => {
		const prompt = PHASE_2.buildPrompt(tmpDir, tmpDir, "P", {});
		expect(prompt!).toContain("engineering");
	});

	it("verify delegates to verifyPhase2 using configCache kbPath", () => {
		const result = PHASE_2.verify(tmpDir, { paths: { engineering: "docs" } });
		expect(result.ok).toBe(false); // no docs exist
		expect(result.missing.length).toBeGreaterThan(0);
	});

	it("buildRetrySteer references the generate-kb-doc.md rulebook", () => {
		const steer = PHASE_2.buildRetrySteer({ ok: false, missing: ["engineering/architecture/stack.md"] }, tmpDir, tmpDir);
		expect(steer).toContain("generate-kb-doc.md");
	});
});

// ── PHASE_3 descriptor ─────────────────────────────────────────────────────

describe("PHASE_3 descriptor", () => {
	it("has phaseNum=3 and bannerKey='supervisor'", () => {
		expect(PHASE_3.phaseNum).toBe(3);
		expect(PHASE_3.bannerKey).toBe("supervisor");
	});

	it("buildPrompt returns null (deterministic phase)", () => {
		expect(PHASE_3.buildPrompt("", "", "", {})).toBeNull();
	});

	it("hardFailOnVerifyError is true", () => {
		expect(PHASE_3.hardFailOnVerifyError).toBe(true);
	});

	it("buildRetrySteer returns null (not used by Phase 3)", () => {
		expect(PHASE_3.buildRetrySteer({ ok: false, missing: [] }, "", "")).toBeNull();
	});

	it("verify delegates to verifyPhase3", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-desc-"));
		try {
			const result = PHASE_3.verify(tmpDir, {});
			expect(result.ok).toBe(false);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("nonInteractiveAbortMsg includes substitute-placeholders guidance", () => {
		const msg = PHASE_3.nonInteractiveAbortMsg({ ok: false, missing: [".forge/workflows/ (empty)"] });
		expect(msg).toContain("substitute-placeholders");
	});

	it("has runDeterministic defined", () => {
		expect(typeof PHASE_3.runDeterministic).toBe("function");
	});
});
