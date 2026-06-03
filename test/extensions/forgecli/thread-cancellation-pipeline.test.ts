// thread-cancellation-pipeline.test.ts — tests for cancellation in runTaskPipeline
// and runBugPipeline.
//
// Verifies that the AbortSignal wiring causes pipelines to return "cancelled"
// when the signal fires between phases or during a subagent run.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock createAgentSession ────────────────────────────────────────────────

const { mockSession, subscriberRef } = vi.hoisted(() => {
	// Captured turn_end listener so per-test prompt impls can emit usage-bearing
	// assistant messages mid-run (incomplete-attempt token emission tests).
	const subscriberRef: { current: ((e: unknown) => void) | null } = { current: null };
	const mockSession = {
		subscribe: vi.fn((listener: (e: unknown) => void) => {
			subscriberRef.current = listener;
			return () => {
				subscriberRef.current = null;
			};
		}),
		prompt: vi.fn(() => Promise.resolve()),
		abort: vi.fn(),
		dispose: vi.fn(),
		agent: { sessionId: undefined as string | undefined },
	};
	return { mockSession, subscriberRef };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	class MockDefaultResourceLoader {
		reload() {
			return Promise.resolve();
		}
	}
	return {
		...actual,
		createAgentSession: vi.fn(async () => ({ session: mockSession })),
		DefaultResourceLoader: MockDefaultResourceLoader,
		AuthStorage: { create: vi.fn(() => ({})) },
		ModelRegistry: { create: vi.fn(() => ({ getAvailable: vi.fn(() => []) })) },
		SessionManager: { inMemory: vi.fn(() => ({})) },
		parseFrontmatter: vi.fn((raw: string) => ({ frontmatter: {}, body: raw })),
		getAgentDir: vi.fn(() => "/fake/agent-dir"),
	};
});

// Mock child_process for preflight gate / store-cli
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") })),
	execFile: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { type RunBugPipelineResult, runBugPipeline } from "../../../src/extensions/forgecli/fix-bug.js";
import { type RunTaskPipelineResult, runTaskPipeline } from "../../../src/extensions/forgecli/run-task.js";
import { getSessionRegistry } from "../../../src/extensions/forgecli/session-registry.js";

// ── Setup / teardown ──────────────────────────────────────────────────────

let tmpRoot: string;
const PRIOR_FORGE_CLI_HOME = process.env.FORGE_CLI_HOME;
const PRIOR_SKIP_MIG = process.env.FORGE_CLI_SKIP_MIGRATION;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-cancel-"));
	process.env.FORGE_CLI_HOME = path.join(tmpRoot, "forge-cli-user");
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";
	vi.mocked(spawnSync).mockClear();
	mockSession.subscribe.mockClear();
	mockSession.prompt.mockClear();
	mockSession.dispose.mockClear();
});

afterEach(() => {
	delete process.env.FORGE_YES;
	delete process.env.FORGE_NON_INTERACTIVE;
	if (PRIOR_FORGE_CLI_HOME === undefined) delete process.env.FORGE_CLI_HOME;
	else process.env.FORGE_CLI_HOME = PRIOR_FORGE_CLI_HOME;
	if (PRIOR_SKIP_MIG === undefined) delete process.env.FORGE_CLI_SKIP_MIGRATION;
	else process.env.FORGE_CLI_SKIP_MIGRATION = PRIOR_SKIP_MIG;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

const GOOD_WORKFLOW_MD = [
	"---",
	"deps:",
	"  personas: [engineer]",
	"audience: subagent",
	"---",
	"",
	"# Phase Workflow",
	"",
	"## Iron Laws",
	"",
	"Follow the Iron Laws. See .forge/personas/engineer.md for full identity.",
	"",
	"## Store-Write Verification",
	"",
	"After every write, verify via forge_store.",
	"",
	"## Algorithm",
	"",
	"1. Run forge_store_query to load context.",
	"2. Execute task.",
].join("\n");

const ORCHESTRATE_MD = [
	"---",
	"deps:",
	"  personas: [engineer]",
	"audience: orchestrator-only",
	"---",
	"",
	"# Orchestrate Task",
	"",
	"## Iron Laws",
	"",
	"Follow the Iron Laws.",
	"",
	"## Store-Write Verification",
	"",
	"After every write, verify via forge_store.",
	"",
	"## Algorithm",
	"",
	"1. Run forge_store_query to load context.",
	"2. Execute phases: plan → review-plan → implement → review-code → validate → approve → writeback → commit.",
].join("\n");

function scaffoldProject(): string {
	const proj = path.join(tmpRoot, "proj");
	fs.mkdirSync(path.join(proj, ".forge", "workflows"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "personas"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "cache"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "store"), { recursive: true });

	fs.writeFileSync(
		path.join(proj, ".forge", "config.json"),
		JSON.stringify({ paths: { forgeRoot: "./forge-payload", store: ".forge/store" } }),
		"utf8",
	);

	fs.writeFileSync(path.join(proj, ".forge", "workflows", "orchestrate_task.md"), ORCHESTRATE_MD, "utf8");

	const workflows = [
		"plan_task",
		"review_plan",
		"implement_plan",
		"review_code",
		"validate_task",
		"architect_approve",
		"collator_agent",
		"commit_task",
		"fix_bug",
	];
	for (const w of workflows) {
		fs.writeFileSync(path.join(proj, ".forge", "workflows", `${w}.md`), GOOD_WORKFLOW_MD, "utf8");
	}

	const personas = ["engineer", "supervisor", "qa-engineer", "architect", "collator", "bug-fixer"];
	for (const p of personas) {
		fs.writeFileSync(
			path.join(proj, ".forge", "personas", `${p}.md`),
			`# ${p} persona\n\nYou are the ${p}. See .forge/personas/${p}.md.`,
			"utf8",
		);
	}

	const forgePayload = path.join(proj, "forge-payload");
	fs.mkdirSync(path.join(forgePayload, "tools"), { recursive: true });
	fs.writeFileSync(path.join(forgePayload, "tools", "preflight-gate.cjs"), "process.exit(0);", "utf8");
	fs.writeFileSync(path.join(forgePayload, "tools", "store-cli.cjs"), "process.exit(0);", "utf8");

	return proj;
}

function makeCtx() {
	const notifications: { msg: string; level: string }[] = [];
	return {
		ui: {
			notify: vi.fn((msg: string, level: string) => {
				notifications.push({ msg, level });
			}),
			confirm: vi.fn(() => Promise.resolve(true)),
			setStatus: vi.fn(),
		},
		hasUI: true,
		modelRegistry: { getAvailable: vi.fn(() => []), refresh: vi.fn() },
		notifications,
	};
}

function mockStoreCliVerdict(verdictByPhase: Record<string, string> = {}) {
	vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
		const argArr = args as string[] | undefined;
		if (argArr && String(argArr[0]).includes("store-cli") && argArr[1] === "read") {
			const taskId = argArr[3] ?? "";
			const summaries: Record<string, { verdict: string }> = {};
			let status = "in-progress";
			for (const [phase, verdict] of Object.entries(verdictByPhase)) {
				if (phase === "approve") {
					if (verdict === "approved") status = "approved";
					continue;
				}
				summaries[phase] = { verdict };
			}
			return {
				status: 0,
				stdout: Buffer.from(JSON.stringify({ taskId, status, summaries })),
				stderr: Buffer.from(""),
			};
		}
		return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
	});
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runTaskPipeline — cancellation via AbortSignal", () => {
	it("returns 'cancelled' when signal is already aborted before pipeline starts", async () => {
		const proj = scaffoldProject();
		const registry = getSessionRegistry();
		registry.startSession("CANCEL-T01");

		const controller = new AbortController();
		controller.abort(); // pre-abort

		const ctx = makeCtx();
		const result: RunTaskPipelineResult = await runTaskPipeline({
			taskId: "CANCEL-T01",
			cwd: proj,
			ctx: ctx as never,
			forgeRoot: path.join(proj, "forge-payload"),
			storeCli: path.join(proj, "forge-payload", "tools", "store-cli.cjs"),
			preflightGate: path.join(proj, "forge-payload", "tools", "preflight-gate.cjs"),
			registry,
			signal: controller.signal,
		});

		expect(result.status).toBe("cancelled");
	});
});

// ── Incomplete-attempt token emission (bug B: aborted-pass tokens were lost) ──
//
// The provider bills every turn of a cancelled/failed phase attempt, but the
// cancel and halt-on-failure branches used to return WITHOUT emitting a phase
// event — so collate's COST_REPORT under-counted real spend (CART-S02-T03
// baseline: 259,950 tokens across 2 aborted plan passes, invisible).
// These tests lock the fix: token-bearing incomplete attempts emit a phase
// event with verdict "aborted" (cancel) / "failed" (halt); zero-token
// attempts emit nothing (no husk noise).

function emitAssistantTurn(usage: { input: number; output: number; totalTokens: number }): void {
	subscriberRef.current?.({
		type: "turn_end",
		message: {
			role: "assistant",
			model: "fake-model",
			provider: "fake",
			content: [{ type: "text", text: "…" }],
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: usage.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	});
}

/** store-cli mock: read returns a record WITH sprintId; capture emit payloads. */
function mockStoreCliWithSprint(emitted: Array<Record<string, unknown>>): void {
	vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
		const argArr = args as string[] | undefined;
		if (argArr && String(argArr[0]).includes("store-cli")) {
			if (argArr[1] === "read") {
				const taskId = argArr[3] ?? "";
				return {
					status: 0,
					stdout: Buffer.from(
						JSON.stringify({ taskId, sprintId: "CANCEL-S01", status: "draft", summaries: {} }),
					),
					stderr: Buffer.from(""),
				};
			}
			if (argArr[1] === "emit") {
				emitted.push(JSON.parse(argArr[3] ?? "{}") as Record<string, unknown>);
				return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
			}
		}
		return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
	});
}

describe("runTaskPipeline — incomplete-attempt token emission", () => {
	it("emits a phase event with verdict 'aborted' + tokens when cancelled mid-phase", async () => {
		const proj = scaffoldProject();
		const registry = getSessionRegistry();
		registry.startSession("CANCEL-T02");
		const emitted: Array<Record<string, unknown>> = [];
		mockStoreCliWithSprint(emitted);

		const controller = new AbortController();
		mockSession.prompt.mockImplementationOnce(async () => {
			emitAssistantTurn({ input: 1234, output: 56, totalTokens: 1290 });
			controller.abort(); // user cancels mid-phase, after a billed turn
		});

		const ctx = makeCtx();
		const result: RunTaskPipelineResult = await runTaskPipeline({
			taskId: "CANCEL-T02",
			cwd: proj,
			ctx: ctx as never,
			forgeRoot: path.join(proj, "forge-payload"),
			storeCli: path.join(proj, "forge-payload", "tools", "store-cli.cjs"),
			preflightGate: path.join(proj, "forge-payload", "tools", "preflight-gate.cjs"),
			registry,
			signal: controller.signal,
		});

		expect(result.status).toBe("cancelled");
		const abortEvents = emitted.filter((e) => e.verdict === "aborted");
		expect(abortEvents).toHaveLength(1);
		expect(abortEvents[0].taskId).toBe("CANCEL-T02");
		expect(abortEvents[0].phase).toBe("plan");
		expect(abortEvents[0].inputTokens).toBe(1234);
		expect(abortEvents[0].outputTokens).toBe(56);
		expect(abortEvents[0].tokenSource).toBe("reported");
	});

	it("emits a phase event with verdict 'failed' + tokens when the phase halts", async () => {
		const proj = scaffoldProject();
		const registry = getSessionRegistry();
		registry.startSession("CANCEL-T03");
		const emitted: Array<Record<string, unknown>> = [];
		mockStoreCliWithSprint(emitted);

		mockSession.prompt.mockImplementationOnce(async () => {
			emitAssistantTurn({ input: 777, output: 11, totalTokens: 788 });
			throw new Error("provider blew up");
		});

		const ctx = makeCtx();
		const result: RunTaskPipelineResult = await runTaskPipeline({
			taskId: "CANCEL-T03",
			cwd: proj,
			ctx: ctx as never,
			forgeRoot: path.join(proj, "forge-payload"),
			storeCli: path.join(proj, "forge-payload", "tools", "store-cli.cjs"),
			preflightGate: path.join(proj, "forge-payload", "tools", "preflight-gate.cjs"),
			registry,
		});

		expect(result.status).toBe("failed");
		const failEvents = emitted.filter((e) => e.verdict === "failed");
		expect(failEvents).toHaveLength(1);
		expect(failEvents[0].inputTokens).toBe(777);
		expect(failEvents[0].tokenSource).toBe("reported");
	});

	it("does NOT emit when the cancelled attempt billed zero tokens (no husk noise)", async () => {
		const proj = scaffoldProject();
		const registry = getSessionRegistry();
		registry.startSession("CANCEL-T04");
		const emitted: Array<Record<string, unknown>> = [];
		mockStoreCliWithSprint(emitted);

		const controller = new AbortController();
		mockSession.prompt.mockImplementationOnce(async () => {
			controller.abort(); // cancelled before any billed turn
		});

		const ctx = makeCtx();
		const result: RunTaskPipelineResult = await runTaskPipeline({
			taskId: "CANCEL-T04",
			cwd: proj,
			ctx: ctx as never,
			forgeRoot: path.join(proj, "forge-payload"),
			storeCli: path.join(proj, "forge-payload", "tools", "store-cli.cjs"),
			preflightGate: path.join(proj, "forge-payload", "tools", "preflight-gate.cjs"),
			registry,
			signal: controller.signal,
		});

		expect(result.status).toBe("cancelled");
		expect(emitted).toHaveLength(0);
	});
});

describe("runBugPipeline — cancellation via AbortSignal", () => {
	it("returns 'cancelled' when signal is already aborted before pipeline starts", async () => {
		const proj = scaffoldProject();
		const registry = getSessionRegistry();
		registry.startSession("FORGE-BUG-099");

		const controller = new AbortController();
		controller.abort(); // pre-abort

		const ctx = makeCtx();
		const result: RunBugPipelineResult = await runBugPipeline({
			bugId: "FORGE-BUG-099",
			cwd: proj,
			ctx: ctx as never,
			forgeRoot: path.join(proj, "forge-payload"),
			storeCli: path.join(proj, "forge-payload", "tools", "store-cli.cjs"),
			preflightGate: path.join(proj, "forge-payload", "tools", "preflight-gate.cjs"),
			registry,
			signal: controller.signal,
		});

		expect(result.status).toBe("cancelled");
	});
});
