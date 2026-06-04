// Unit tests for the /forge:run-task native Orchestrator handler (FORGE-S21-T02).
//
// All tests mock `createAgentSession` (the dispatch primitive in forge-subagent.ts),
// NOT `sendKickoff`. Mocking sendKickoff would not detect IL10 drift.
//
// IL10 enforcement: createAgentSession must be called once per non-review phase
// when no revisions occur. sendKickoff must NEVER be called from run-task.ts.
//
// Test coverage (≥10 cases):
//   1.  Happy path — full chain completes; createAgentSession called per phase
//   2.  Subagent failure (exitCode !== 0) — halts chain, persists state
//   3.  Resume from cached state (≤7d) — confirm offered; resumes from saved index
//   4.  Stale cached state (>7d) — notify + offer purge
//   5.  Audience refusal mid-chain — chain halts, state persisted
//   6.  Materialization marker missing — notify per marker, return early
//   7.  IL10 enforcement — createAgentSession invoked per phase; no sendKickoff in source
//   8.  FORGE_YES=1 auto-abort on failure (non-interactive)
//   9.  Preflight gate exit 1 — halt + persist state
//  10.  Verdict `revision` loops to predecessor; cap 3 → escalate
//  11.  Persona loaded per phase via loadForgePersona mock

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock createAgentSession before any import of forge-subagent ──────────
// Use vi.hoisted to ensure mockSession is defined before vi.mock runs.

const { mockSession } = vi.hoisted(() => {
	const mockSession = {
		subscribe: vi.fn(() => () => undefined),
		prompt: vi.fn(() => Promise.resolve()),
		abort: vi.fn(),
		dispose: vi.fn(),
		// Mirrors real AgentSession.agent — forge-subagent assigns sessionId
		// here for prompt-cache affinity.
		agent: { sessionId: undefined as string | undefined },
	};
	return { mockSession };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	// eslint-disable-next-line @typescript-eslint/no-extraneous-class
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

// Mock child_process for preflight gate spawnSync and store-resolver execFileAsync
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") })),
	execFile: vi.fn(),
}));

// Mock store-resolver so resolveToCanonicalId passes through canonical task IDs
// unchanged. Tests use canonical IDs (e.g. "FORGE-S21-T02") that don't need
// resolution, and the mock execFile doesn't return store-cli data.
vi.mock("../../../src/extensions/forgecli/store/store-resolver.js", () => ({
	resolveToCanonicalId: vi.fn(async (arg: string) => arg),
	resolveToolDir: vi.fn((forgeRoot: string) => forgeRoot + "/tools"),
}));

// Mock the halt-recovery advisor so the verdict-missing path can be asserted
// without spawning a real advisor subagent. Both exports are replaced; the
// advisor itself is covered by halt-advisor.test.ts.
vi.mock("../../../src/extensions/forgecli/orchestrators/halt-advisor.js", () => ({
	resolveAdvisorModel: vi.fn(() => undefined),
	runHaltAdvisor: vi.fn(() => Promise.resolve()),
}));

import { spawnSync } from "node:child_process";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { runHaltAdvisor } from "../../../src/extensions/forgecli/orchestrators/halt-advisor.js";
import { buildSummariesBlock, composeTaskBody, registerRunTask, runPreflightGate, runPostflightGate } from "../../../src/extensions/forgecli/orchestrators/run-task.js";

// ── Fixtures and helpers ────────────────────────────────────────────────────

let tmpRoot: string;

// Post-FORGE-S20-T11 (v0.10.0): scope FORGE_CLI_HOME so the path resolver
// reads/writes from a tmpdir, otherwise the real ~/.pi/forge-cli/config.json
// leaks into loadLayeredConfig() and silently changes model resolution.
const PRIOR_FORGE_CLI_HOME = process.env.FORGE_CLI_HOME;
const PRIOR_SKIP_MIG = process.env.FORGE_CLI_SKIP_MIGRATION;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-run-task-"));
	process.env.FORGE_CLI_HOME = path.join(tmpRoot, "forge-cli-user");
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";
	vi.mocked(createAgentSession).mockClear();
	vi.mocked(spawnSync).mockClear();
	mockSession.subscribe.mockClear();
	mockSession.prompt.mockClear();
	mockSession.dispose.mockClear();
});

afterEach(() => {
	// Restore env vars
	delete process.env.FORGE_YES;
	delete process.env.FORGE_NON_INTERACTIVE;
	if (PRIOR_FORGE_CLI_HOME === undefined) delete process.env.FORGE_CLI_HOME;
	else process.env.FORGE_CLI_HOME = PRIOR_FORGE_CLI_HOME;
	if (PRIOR_SKIP_MIG === undefined) delete process.env.FORGE_CLI_SKIP_MIGRATION;
	else process.env.FORGE_CLI_SKIP_MIGRATION = PRIOR_SKIP_MIG;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// Standard sub-workflow markdown that passes materialization checks
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

// Orchestrate task workflow that spawns sub-workflows
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

interface ScaffoldOpts {
	taskId?: string;
	withCache?: boolean;
	cacheAge?: "fresh" | "stale";
	cachePhaseIndex?: number;
	orchestrateWorkflowMd?: string;
	subWorkflowMd?: string;
	includePersonas?: boolean;
	verdictData?: Record<string, string>;
}

function scaffoldProject(opts: ScaffoldOpts = {}): { proj: string; taskId: string } {
	const taskId = opts.taskId ?? "FORGE-S21-T02";
	const proj = path.join(tmpRoot, "proj");

	// Create directory structure
	fs.mkdirSync(path.join(proj, ".forge", "workflows"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "personas"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "cache"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "store"), { recursive: true });

	// Write config
	fs.writeFileSync(
		path.join(proj, ".forge", "config.json"),
		JSON.stringify({ paths: { forgeRoot: "./forge-payload", store: ".forge/store" } }),
		"utf8",
	);

	// Write orchestrate_task.md
	const orchestrateMd = opts.orchestrateWorkflowMd ?? ORCHESTRATE_MD;
	fs.writeFileSync(path.join(proj, ".forge", "workflows", "orchestrate_task.md"), orchestrateMd, "utf8");

	// Write all sub-workflow files
	const subMd = opts.subWorkflowMd ?? GOOD_WORKFLOW_MD;
	const workflows = [
		"plan_task",
		"review_plan",
		"implement_plan",
		"review_code",
		"validate_task",
		"architect_approve",
		"collator_agent",
		"commit_task",
	];
	for (const w of workflows) {
		fs.writeFileSync(path.join(proj, ".forge", "workflows", `${w}.md`), subMd, "utf8");
	}

	// Write persona files (all roles)
	if (opts.includePersonas !== false) {
		const personas = ["engineer", "supervisor", "qa-engineer", "architect", "collator"];
		for (const p of personas) {
			fs.writeFileSync(
				path.join(proj, ".forge", "personas", `${p}.md`),
				`# ${p} persona\n\nYou are the ${p}. See .forge/personas/${p}.md.`,
				"utf8",
			);
		}
	}

	// Write fake forgeRoot with gate stubs (spawnSync is mocked — these files just need to exist
	// so fs.existsSync() passes and the gate path is used correctly in runPostflightGate)
	const forgePayload = path.join(proj, "forge-payload");
	fs.mkdirSync(path.join(forgePayload, "tools"), { recursive: true });
	// Create minimal stubs (won't actually run — spawnSync is mocked)
	fs.writeFileSync(path.join(forgePayload, "tools", "preflight-gate.cjs"), "process.exit(0);", "utf8");
	fs.writeFileSync(path.join(forgePayload, "tools", "postflight-gate.cjs"), "process.exit(0);", "utf8");
	fs.writeFileSync(path.join(forgePayload, "tools", "store-cli.cjs"), "process.exit(0);", "utf8");

	// Write cached state if needed
	if (opts.withCache) {
		const cacheFile = path.join(proj, ".forge", "cache", `run-task-state-${taskId}.json`);
		const savedAt =
			opts.cacheAge === "stale"
				? new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() // 8 days ago
				: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({
				taskId,
				phaseIndex: opts.cachePhaseIndex ?? 2,
				iterationCounts: {},
				halted: true,
				savedAt,
			}),
			"utf8",
		);
	}

	// Write verdict data for store-cli read mock
	if (opts.verdictData) {
		const taskRecord = {
			taskId,
			sprintId: "FORGE-S21",
			status: "in-progress",
			summaries: Object.fromEntries(
				Object.entries(opts.verdictData).map(([phase, verdict]) => [phase, { verdict }]),
			),
		};
		fs.writeFileSync(path.join(proj, ".forge", "store", `tasks-${taskId}.json`), JSON.stringify(taskRecord), "utf8");
	}

	return { proj, taskId };
}

function makePi() {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		registerCommand: vi.fn(
			(name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands.set(name, def);
			},
		),
		commands,
	};
	return pi;
}

function makeCtx(
	overrides: Partial<{
		confirm: (title: string, desc?: string) => Promise<boolean>;
	}> = {},
) {
	const notifications: { msg: string; level: string }[] = [];
	const statuses: { key: string; val: string | undefined }[] = [];
	const ctx = {
		ui: {
			notify: vi.fn((msg: string, level: string) => {
				notifications.push({ msg, level });
			}),
			confirm: vi.fn(() => Promise.resolve(true)),
			setStatus: vi.fn((key: string, val?: string) => {
				statuses.push({ key, val });
			}),
		},
		hasUI: true,
		notifications,
		statuses,
	};
	if (overrides.confirm) {
		ctx.ui.confirm = vi.fn(overrides.confirm);
	}
	return ctx;
}

async function invokeRunTask(
	pi: ReturnType<typeof makePi>,
	ctx: ReturnType<typeof makeCtx>,
	args: string,
): Promise<void> {
	const cmd = pi.commands.get("forge:run-task");
	if (!cmd) throw new Error("forge:run-task not registered");
	await cmd.handler(args, ctx);
}

// ── Mock spawnSync to return "approved" verdict from store-cli ────────────

function mockStoreCliVerdict(verdictByPhase: Record<string, string> = {}) {
	vi.mocked(spawnSync).mockImplementation((cmd: string, args?: readonly string[]) => {
		const argArr = args as string[] | undefined;
		// Detect store-cli read task calls
		if (argArr && argArr[0]?.endsWith("store-cli.cjs") && argArr[1] === "read" && argArr[2] === "task") {
			const taskId = argArr[3] ?? "";
			// Return a task record with summaries. The `approve` phase has no
			// summaries entry in real workflows — it transitions task.status
			// to "approved". The mock honors that contract: if verdictByPhase
			// includes `approve: "approved"`, the record's status is set
			// accordingly. All other verdicts populate summaries as given.
			const summaries: Record<string, { verdict: string }> = {};
			let status = "in-progress";
			for (const [phase, verdict] of Object.entries(verdictByPhase)) {
				if (phase === "approve") {
					if (verdict === "approved") status = "approved";
					continue;
				}
				summaries[phase] = { verdict };
			}
			const record = { taskId, status, summaries };
			return {
				status: 0,
				stdout: Buffer.from(JSON.stringify(record)),
				stderr: Buffer.from(""),
			};
		}
		// Default: preflight gate passes
		return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
	});
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerRunTask — registration", () => {
	it("registers the forge:run-task command", () => {
		const { proj } = scaffoldProject();
		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		expect(pi.commands.has("forge:run-task")).toBe(true);
		const cmd = pi.commands.get("forge:run-task")!;
		expect(cmd.description).toMatch(/run-task|orchestrat/i);
	});
});

describe("Test 1: Happy path — full chain completes", () => {
	it("calls createAgentSession once per phase and notifies completion", async () => {
		const { proj, taskId } = scaffoldProject();
		// All review phases return "approved"
		mockStoreCliVerdict({
			"review-plan": "approved",
			"review-code": "approved",
			validate: "approved",
			approve: "approved",
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should have called createAgentSession (8 phases total)
		const spawnCount = vi.mocked(createAgentSession).mock.calls.length;
		expect(spawnCount).toBeGreaterThanOrEqual(8);

		// Should notify completion
		const completionNotify = ctx.notifications.find(
			(n) => n.level === "info" && (n.msg.includes("done") || n.msg.includes("complete") || n.msg.includes("〇")),
		);
		expect(completionNotify).toBeDefined();
	});
});

describe("Test 1b: readVerdict resolves canonical workflow keys (forge#85-followup)", () => {
	// Regression for the systemic verdict-key mismatch:
	//   phase.role "review-code" → canonical summary key "code_review" (REVERSED — not "review_code")
	//   phase.role "validate"    → canonical summary key "validation"   (different word)
	//   phase.role "approve"     → no summary; task.status === "approved"
	// Live-observed symptom: chain escalated with "verdict missing for phase review-code"
	// even though the supervisor subagent had written summaries.code_review.verdict = "approved".
	it("finds verdict at canonical key for review-code, validate; reads task.status for approve", async () => {
		const { proj, taskId } = scaffoldProject();
		mockStoreCliVerdict({
			review_plan: "approved", // canonical for review-plan
			code_review: "approved", // canonical for review-code (was the broken case)
			validation: "approved", // canonical for validate
			approve: "approved", // → sets record.status = "approved"
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		const missingNotify = ctx.notifications.find((n) => n.msg.includes("verdict missing"));
		expect(missingNotify).toBeUndefined();

		const completionNotify = ctx.notifications.find(
			(n) => n.level === "info" && (n.msg.includes("done") || n.msg.includes("complete") || n.msg.includes("〇")),
		);
		expect(completionNotify).toBeDefined();
	});
});

describe("Test 1d: verdict missing routes through halt-recovery advisor (advisory ordering fix)", () => {
	// Regression: before the fix, a missing verdict at a review phase emitted a
	// bare "Escalating" error and returned status:"failed" WITHOUT invoking the
	// halt-recovery advisor (FORGE-S26-T18) — the advisor lived only in the
	// later postflight-gate branch, which the verdict-missing early-return
	// bypassed. A missing verdict IS a missing-output condition, so it must now
	// hand off to the advisor. Live symptom: CART-S02-T03 review-code.
	it("invokes runHaltAdvisor with the failing phase instead of a bare escalation", async () => {
		const { proj, taskId } = scaffoldProject();
		// review-plan approves so the chain advances to review-code; review-code
		// has NO code_review summary → readVerdict returns "missing".
		mockStoreCliVerdict({ review_plan: "approved" });

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		vi.mocked(runHaltAdvisor).mockClear();
		await invokeRunTask(pi, ctx, taskId);

		// Diagnostic notify is still emitted (now "Halting for advisory").
		const missingNotify = ctx.notifications.find((n) => n.msg.includes("verdict missing"));
		expect(missingNotify).toBeDefined();

		// And it now hands off to the advisor with a structured gate failure.
		expect(runHaltAdvisor).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runHaltAdvisor).mock.calls[0]![0];
		expect(opts.gateFailure.phase).toBe("review-code");
		expect(opts.gateFailure.reasonCode).toBe("verdict-missing");
		expect(opts.taskId).toBe(taskId);
	});
});

describe("Test 1a: readVerdict tolerates underscore summary keys (forge-cli#?)", () => {
	// phase.role is "review-plan" (hyphen) but set-summary stores at "review_plan"
	// (underscore — matches the verb form workflow text uses). readVerdict must
	// look up the underscore form so a successful review is not falsely
	// reported as "verdict missing". Regression observed live in
	// hello/forge-subagent-2026-05-13T03-03-52-970Z__supervisor__HLO-S01-T01__review-plan.json.
	it("finds verdict stored under underscore key when phase.role uses hyphen", async () => {
		const { proj, taskId } = scaffoldProject();
		// NOTE: summary keys are underscore-form (matches set-summary verb).
		mockStoreCliVerdict({
			review_plan: "approved",
			review_code: "approved",
			validate: "approved",
			approve: "approved",
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should NOT escalate with "verdict missing".
		const missingNotify = ctx.notifications.find((n) => n.msg.includes("verdict missing"));
		expect(missingNotify).toBeUndefined();

		// And the chain should reach completion.
		const completionNotify = ctx.notifications.find(
			(n) => n.level === "info" && (n.msg.includes("done") || n.msg.includes("complete") || n.msg.includes("〇")),
		);
		expect(completionNotify).toBeDefined();
	});
});

describe("Test 2: Subagent failure — halts chain, persists state", () => {
	it("halts chain when exitCode !== 0 from runForgeSubagent", async () => {
		const { proj, taskId } = scaffoldProject();

		// Make session.prompt throw on first real call (simulates error)
		vi.mocked(createAgentSession).mockImplementationOnce(async () => ({
			session: {
				...mockSession,
				prompt: vi.fn(() => Promise.reject(new Error("subagent failed"))),
				subscribe: vi.fn((listener: (e: { type: string }) => void) => {
					// Emit error stop reason
					listener({ type: "turn_end" });
					return () => undefined;
				}),
			},
		}));

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should have notified an error
		const errorNotify = ctx.notifications.find((n) => n.level === "error");
		expect(errorNotify).toBeDefined();

		// State file should be persisted
		const cacheFile = path.join(proj, ".forge", "cache", `run-task-state-${taskId}.json`);
		expect(fs.existsSync(cacheFile)).toBe(true);
		const state = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
			halted: boolean;
			taskId: string;
		};
		expect(state.halted).toBe(true);
		expect(state.taskId).toBe(taskId);
	});
});

describe("Test 3: Resume from cached state (≤7d)", () => {
	it("offers ctx.ui.confirm and resumes from saved phase index", async () => {
		const { proj, taskId } = scaffoldProject({
			withCache: true,
			cacheAge: "fresh",
			cachePhaseIndex: 2,
		});
		mockStoreCliVerdict({
			"review-code": "approved",
			validate: "approved",
			approve: "approved",
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx({ confirm: () => Promise.resolve(true) }); // accept resume

		await invokeRunTask(pi, ctx, taskId);

		// ctx.ui.confirm must have been called (resume offered)
		expect(ctx.ui.confirm).toHaveBeenCalled();
		// Should resume from phase index 2, not from 0
		// createAgentSession should be called fewer than 8 times (resumed from phase 2)
		const spawnCount = vi.mocked(createAgentSession).mock.calls.length;
		expect(spawnCount).toBeLessThan(8); // started from index 2, not 0
	});
});

describe("Test 4: Stale cached state (>7d)", () => {
	it("notifies about stale state and offers purge", async () => {
		const { proj, taskId } = scaffoldProject({
			withCache: true,
			cacheAge: "stale",
			cachePhaseIndex: 3,
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		// Decline purge / restart (resolve false to abort)
		const ctx = makeCtx({ confirm: () => Promise.resolve(false) });

		await invokeRunTask(pi, ctx, taskId);

		// Should notify about stale state
		const staleNotify = ctx.notifications.find(
			(n) => n.msg.includes("stale") || n.msg.includes("7") || n.msg.includes("old") || n.msg.includes("purge"),
		);
		expect(staleNotify).toBeDefined();
	});
});

describe("Test 5: Audience refusal mid-chain", () => {
	it("halts chain and persists state when assertAudience returns false", async () => {
		// Write a sub-workflow with audience: orchestrator-only (will be refused from subagent context)
		const badWorkflow = GOOD_WORKFLOW_MD.replace("audience: subagent", "audience: orchestrator-only");

		const { proj, taskId } = scaffoldProject({
			subWorkflowMd: badWorkflow,
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should have notified an error (audience refusal)
		const errorNotify = ctx.notifications.find(
			(n) =>
				n.level === "error" &&
				(n.msg.includes("orchestrator-only") || n.msg.includes("audience") || n.msg.includes("workflow")),
		);
		expect(errorNotify).toBeDefined();

		// createAgentSession should NOT have been called (halted before dispatch)
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
	});
});

describe("Test 6: Materialization marker missing", () => {
	it("notifies per missing marker and aborts without calling createAgentSession", async () => {
		// Sub-workflow missing required markers
		const badWorkflow = GOOD_WORKFLOW_MD.replace(/Store-Write Verification/g, "Store-Write XXX").replace(
			/Iron Laws/g,
			"Iron Rules",
		);

		const { proj, taskId } = scaffoldProject({
			subWorkflowMd: badWorkflow,
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should notify about missing markers
		const markerErrors = ctx.notifications.filter(
			(n) =>
				n.level === "error" &&
				(n.msg.includes("Store-Write Verification") ||
					n.msg.includes("Iron Laws") ||
					n.msg.includes("marker") ||
					n.msg.includes("workflow regression")),
		);
		expect(markerErrors.length).toBeGreaterThan(0);

		// createAgentSession must NOT have been called
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
	});
});

describe("Test 7: IL10 enforcement", () => {
	it("createAgentSession is called per phase; run-task.ts source has no sendKickoff(", () => {
		// Source-grep test: read run-task.ts and assert no sendKickoff(
		const thisDir = path.dirname(fileURLToPath(import.meta.url));
		const runTaskPath = path.resolve(thisDir, "../../../src/extensions/forgecli/orchestrators/run-task.ts");
		expect(fs.existsSync(runTaskPath), `run-task.ts must exist at ${runTaskPath}`).toBe(true);

		const source = fs.readFileSync(runTaskPath, "utf8");
		// Strip single-line comments before checking to avoid matching comment text.
		// Real call sites are NOT in comments.
		const sourceWithoutComments = source
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n");
		expect(sourceWithoutComments).not.toMatch(/sendKickoff\s*[(]/);
		expect(source).toMatch(/runForgeSubagent\s*[(]/);
	});

	it("createAgentSession spawn count equals phase count when no revisions", async () => {
		const { proj, taskId } = scaffoldProject();
		mockStoreCliVerdict({
			"review-plan": "approved",
			"review-code": "approved",
			validate: "approved",
			approve: "approved",
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// 8 phases total → 8 createAgentSession calls
		expect(vi.mocked(createAgentSession).mock.calls.length).toBe(8);
	});
});

describe("Test 8: FORGE_YES=1 auto-abort on failure (non-interactive)", () => {
	it("does not call ctx.ui.confirm when FORGE_YES=1 and state exists", async () => {
		process.env.FORGE_YES = "1";
		const { proj, taskId } = scaffoldProject({
			withCache: true,
			cacheAge: "fresh",
			cachePhaseIndex: 1,
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// In non-interactive mode, confirm should NOT be called
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});
});

describe("Test 9: Preflight gate exit 1 — halt + persist state", () => {
	it("halts and persists state when spawnSync returns status 1", async () => {
		const { proj, taskId } = scaffoldProject();

		// Preflight gate fails for first call
		vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
			const argArr = args as string[] | undefined;
			// Return exit code 1 for preflight-gate calls
			if (argArr && String(argArr[0]).includes("preflight-gate")) {
				return { status: 1, stdout: Buffer.from("phase not ready"), stderr: Buffer.from("") };
			}
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should have notified error
		const errorNotify = ctx.notifications.find((n) => n.level === "error");
		expect(errorNotify).toBeDefined();

		// State should be persisted
		const cacheFile = path.join(proj, ".forge", "cache", `run-task-state-${taskId}.json`);
		expect(fs.existsSync(cacheFile)).toBe(true);
		const state = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { halted: boolean };
		expect(state.halted).toBe(true);

		// createAgentSession must NOT have been called
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
	});
});

describe("Test 10: Verdict `revision` loops to predecessor; cap 3 → escalate", () => {
	it("revision verdict decrements phase to predecessor non-review phase", async () => {
		const { proj, taskId } = scaffoldProject();

		let reviewPlanCallCount = 0;
		mockStoreCliVerdict({
			// Will be overridden below per call
		});
		vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
			const argArr = args as string[] | undefined;
			if (argArr && String(argArr[0]).includes("store-cli") && argArr?.[1] === "read") {
				// review-plan returns revision 3 times then escalates
				reviewPlanCallCount++;
				const verdict = reviewPlanCallCount <= 3 ? "revision" : "approved";
				const summaries = {
					"review-plan": { verdict },
					"review-code": { verdict: "approved" },
					validate: { verdict: "approved" },
					approve: { verdict: "approved" },
				};
				return {
					status: 0,
					stdout: Buffer.from(JSON.stringify({ taskId, summaries })),
					stderr: Buffer.from(""),
				};
			}
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// After 3 revisions on review-plan, should escalate (not loop indefinitely)
		// The handler should either complete with escalation notify or stop gracefully
		const escalateOrErrorNotify = ctx.notifications.find(
			(n) =>
				n.msg.includes("escalat") ||
				n.msg.includes("cap") ||
				n.msg.includes("revision") ||
				n.msg.includes("loop") ||
				n.level === "error",
		);
		expect(escalateOrErrorNotify).toBeDefined();
	});
});

describe("Dashboard node-per-dispatch: each leaf renders once per run, no leaked running nodes", () => {
	// CART-BUG-003 dashboard regression: (a) revision loopback left the review
	// node `running` forever (stuck spinner, ticking timer); (b) re-dispatched
	// predecessor phases reused the same node ID so attempts merged into one
	// node. Contract: one tree node per dispatch, sequential :N suffixes, and
	// every node reaches a terminal state on every pipeline exit path.

	it("revision loop creates one node per dispatch and closes all of them", async () => {
		const { proj, taskId } = scaffoldProject({ taskId: "FORGE-S21-T77" });

		// review-plan ALWAYS returns revision → loop plan↔review-plan until the
		// cap (3) escalates. Dispatch sequence: plan:1, review-plan:1, plan:2,
		// review-plan:2, plan:3, review-plan:3 (escalates).
		vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
			const argArr = args as string[] | undefined;
			if (argArr && String(argArr[0]).includes("store-cli") && argArr?.[1] === "read") {
				const summaries = { "review-plan": { verdict: "revision" } };
				return {
					status: 0,
					stdout: Buffer.from(JSON.stringify({ taskId, sprintId: "FORGE-S21", summaries })),
					stderr: Buffer.from(""),
				};
			}
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();
		await invokeRunTask(pi, ctx, taskId);

		const { getOrchestratorTree } = await import("../../../src/extensions/forgecli/orchestrator-tree.js");
		const tree = getOrchestratorTree();

		// One node per dispatch, sequential suffixes — re-dispatches do NOT merge.
		for (const id of [`${taskId}:plan:1`, `${taskId}:plan:2`, `${taskId}:plan:3`]) {
			expect(tree.getNode(id), `${id} must exist as its own node`).toBeDefined();
			expect(tree.getNode(id)!.status).toBe("completed");
		}
		// Review dispatches: 1 and 2 finished cleanly (their verdict was
		// revision — an orchestration outcome, not a subagent failure); 3 hit
		// the cap and escalated.
		expect(tree.getNode(`${taskId}:review-plan:1`)?.status).toBe("completed");
		expect(tree.getNode(`${taskId}:review-plan:2`)?.status).toBe("completed");
		expect(tree.getNode(`${taskId}:review-plan:3`)?.status).toBe("escalated");

		// No dispatch beyond the escalation point.
		expect(tree.getNode(`${taskId}:plan:4`)).toBeUndefined();
		expect(tree.getNode(`${taskId}:implement:1`)).toBeUndefined();

		// THE invariant: no leaked running leaves anywhere under this task.
		for (const suffix of ["plan:1", "plan:2", "plan:3", "review-plan:1", "review-plan:2", "review-plan:3"]) {
			const node = tree.getNode(`${taskId}:${suffix}`);
			expect(node?.status, `${suffix} must not be left running`).not.toBe("running");
		}
	});

	it("phase failure (exitCode !== 0) closes the phase node as failed", async () => {
		const { proj, taskId } = scaffoldProject({ taskId: "FORGE-S21-T78" });
		mockStoreCliVerdict({});

		// First subagent (plan) fails.
		vi.mocked(createAgentSession).mockImplementationOnce(async () => {
			throw new Error("boom: provider stream died");
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();
		await invokeRunTask(pi, ctx, taskId);

		const { getOrchestratorTree } = await import("../../../src/extensions/forgecli/orchestrator-tree.js");
		const tree = getOrchestratorTree();
		const node = tree.getNode(`${taskId}:plan:1`);
		expect(node).toBeDefined();
		expect(node!.status).toBe("failed");
	});
});

describe("Test 11: Persona loaded per phase via loadForgePersona", () => {
	it("different persona names are passed to loadForgePersona for each phase", async () => {
		// Verify personas by checking which .forge/personas/*.md files are read.
		// vi.spyOn(fs, "readFileSync") is not available in ESM — instead, we use
		// the PHASES table (exported from run-task.ts) to assert that distinct
		// personaNoun values are declared, and that a successful happy-path run
		// (which requires loadForgePersona to succeed for each phase) proves the
		// per-phase persona loading contract.
		const { proj, taskId } = scaffoldProject();
		mockStoreCliVerdict({
			"review-plan": "approved",
			"review-code": "approved",
			validate: "approved",
			approve: "approved",
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Happy path must complete (proves all 8 persona loads succeeded)
		const completionNotify = ctx.notifications.find((n) => n.level === "info" && n.msg.includes("〇"));
		expect(completionNotify, "Pipeline must complete for all personas to be loaded").toBeDefined();

		// Verify the PHASES table has distinct persona nouns (contract: per-phase persona loading)
		const { PHASES } = await import("../../../src/extensions/forgecli/orchestrators/run-task.js");
		const personaNouns = new Set(PHASES.map((p) => p.personaNoun));
		// 5 distinct persona nouns: engineer, supervisor, qa-engineer, architect, collator
		expect(personaNouns.size).toBeGreaterThanOrEqual(3);
		expect(personaNouns.has("engineer")).toBe(true);
		expect(personaNouns.has("supervisor")).toBe(true);
		expect(personaNouns.has("architect")).toBe(true);

		// Verify createAgentSession was called for all 8 phases (each required a persona)
		expect(vi.mocked(createAgentSession).mock.calls.length).toBe(8);
	});
});

// ── Test 12: runPreflightGate entityType parameter (Code Review Finding #1 for FORGE-S21-T07) ──
//
// The preflight gate must use --bug for bug entities and --task for task entities.
// This test verifies the generalized runPreflightGate function produces
// the correct CLI flag based on the entityType parameter.

describe("Test 12: runPreflightGate entityType parameter", () => {
	it("should pass --task flag for entityType 'task'", () => {
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);

		const result = runPreflightGate("/fake/preflight-gate.cjs", "plan", "FORGE-S21-T01", "/tmp", "task");

		expect(result).toBe("proceed");
		const lastCall = vi.mocked(spawnSync).mock.calls[vi.mocked(spawnSync).mock.calls.length - 1];
		const args = lastCall[1] as string[];
		expect(args).toContain("--task");
		expect(args).toContain("FORGE-S21-T01");
		expect(args).not.toContain("--bug");

		vi.mocked(spawnSync).mockClear();
	});

	it("should default to --task when entityType is omitted (backward compat)", () => {
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);

		const result = runPreflightGate("/fake/preflight-gate.cjs", "plan", "FORGE-S21-T01", "/tmp");

		expect(result).toBe("proceed");
		const lastCall = vi.mocked(spawnSync).mock.calls[vi.mocked(spawnSync).mock.calls.length - 1];
		const args = lastCall[1] as string[];
		expect(args).toContain("--task");
		expect(args).not.toContain("--bug");

		vi.mocked(spawnSync).mockClear();
	});

	it("should pass --bug flag for entityType 'bug'", () => {
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);

		const result = runPreflightGate("/fake/preflight-gate.cjs", "triage", "FORGE-BUG-042", "/tmp", "bug");

		expect(result).toBe("proceed");
		const lastCall = vi.mocked(spawnSync).mock.calls[vi.mocked(spawnSync).mock.calls.length - 1];
		const args = lastCall[1] as string[];
		expect(args).toContain("--bug");
		expect(args).toContain("FORGE-BUG-042");
		expect(args).not.toContain("--task");

		vi.mocked(spawnSync).mockClear();
	});
});

// ── Test 13: Unprefixed task ID resolution (Issue #20) ───────────────────────
//
// The run-task handler now uses resolveToCanonicalId to resolve unprefixed
// task IDs before passing them to the pipeline. This test validates that
// the handler correctly: (a) passes raw args to the resolver, (b) uses the
// canonical ID for subsequent operations, and (c) halts on resolution failure.

describe("Test 13: Unprefixed task ID resolution (Issue #20)", () => {
	it("resolves canonical task ID and proceeds with pipeline", async () => {
		const { proj } = scaffoldProject();
		mockStoreCliVerdict({
			"review-plan": "approved",
			"review-code": "approved",
			validate: "approved",
			approve: "approved",
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		// Run with canonical ID — should resolve directly
		await invokeRunTask(pi, ctx, "FORGE-S21-T02");

		// Should NOT emit resolver error
		const resolverError = ctx.notifications.find((n) => n.level === "error" && n.msg.includes("could not resolve"));
		expect(resolverError).toBeUndefined();
	});

	it("halts on unresolvable task ID with actionable error", async () => {
		const { proj } = scaffoldProject();

		// Mock store-cli to return empty results for all queries
		vi.mocked(spawnSync).mockImplementation((_cmd: string, _args?: readonly string[]) => {
			return { status: 0, stdout: Buffer.from(JSON.stringify({ results: [] })), stderr: Buffer.from("") };
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		// This will fail because the resolver can't find the task
		await invokeRunTask(pi, ctx, "xyz-bogus");

		// Should have emitted an error about the unresolvable ID
		const errorNotify = ctx.notifications.find(
			(n) => n.level === "error" && (n.msg.includes("could not resolve") || n.msg.includes("No record")),
		);
		// Either the resolver or the handler should produce an error notification
		expect(errorNotify || ctx.notifications.some((n) => n.level === "error")).toBeTruthy();
	});
});

// Test 14: N-B-E — fail-fast on schema-invalid forge-cli config (Decision 9).
// Regression: runTaskPipeline must return status:"failed" and NOT call createAgentSession
// when loadLayeredConfig returns schema errors.
describe("Test 14: Fail-fast on schema-invalid forge-cli config (N-B-E)", () => {
	it("returns status:failed and does not spawn subagent when forge-cli config has schema errors", async () => {
		const { proj, taskId } = scaffoldProject();

		// Write a schema-invalid project config (persona-models must be an object of objects;
		// giving a string value triggers an Ajv error in loadLayeredConfig).
		const piConfigDir = path.join(proj, ".pi", "forge-cli");
		fs.mkdirSync(piConfigDir, { recursive: true });
		fs.writeFileSync(
			path.join(piConfigDir, "config.json"),
			JSON.stringify({ "persona-models": { engineer: "not-an-object" } }),
			"utf8",
		);

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// createAgentSession must NOT have been called (fail-fast before any subagent)
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();

		// Must have emitted at least one error notification containing the schema error
		const schemaErrorNotify = ctx.notifications.find(
			(n) => n.level === "error" && (n.msg.includes("schema error") || n.msg.includes("forge-cli config")),
		);
		expect(schemaErrorNotify).toBeDefined();
	});
});

// ── Postflight gate (FORGE-S26-T19) ──────────────────────────────────────

describe("Test 15: Postflight gate — FSM does not advance on output-missing failure", () => {
	it("halts and does not advance FSM when postflight gate returns exit 1", async () => {
		const { proj, taskId } = scaffoldProject();
		mockStoreCliVerdict({});

		// Postflight gate fails for first phase after subagent returns
		vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
			const argArr = args as string[] | undefined;
			if (argArr && String(argArr[0]).includes("postflight-gate")) {
				const failure = JSON.stringify({
					phase: "plan",
					reasonCode: "output-missing",
					detail: "output-missing: artifact absent: engineering/sprints/FORGE-S26/FORGE-S26-T19/PLAN.md",
					remediation: "Re-run the phase that produces this artifact, then retry.",
				});
				return { status: 1, stdout: Buffer.from(failure), stderr: Buffer.from("Postflight guard failed") };
			}
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should have emitted an error notification
		const errorNotify = ctx.notifications.find((n) => n.level === "error");
		expect(errorNotify).toBeDefined();

		// State should be persisted as halted
		const cacheFile = path.join(proj, ".forge", "cache", `run-task-state-${taskId}.json`);
		expect(fs.existsSync(cacheFile)).toBe(true);
		const state = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { halted: boolean; phaseIndex: number };
		expect(state.halted).toBe(true);
		// phaseIndex should NOT have advanced past the first phase
		expect(state.phaseIndex).toBe(0);
	});
});

describe("Test 15b: Postflight gate passes → FSM advances normally", () => {
	it("advances FSM when postflight gate returns exit 0", async () => {
		const { proj, taskId } = scaffoldProject();
		mockStoreCliVerdict({
			"review-plan": "approved",
			"review-code": "approved",
			validate: "approved",
			approve: "approved",
		});

		// All spawnSync calls pass (postflight gate also passes — default mock returns 0)
		// No additional mock needed — mockStoreCliVerdict already returns status 0 for non-store calls

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should have completed all phases (8 createAgentSession calls)
		const spawnCount = vi.mocked(createAgentSession).mock.calls.length;
		expect(spawnCount).toBe(8);

		// Should notify completion
		const completionNotify = ctx.notifications.find(
			(n) => n.level === "info" && (n.msg.includes("done") || n.msg.includes("complete") || n.msg.includes("〇")),
		);
		expect(completionNotify).toBeDefined();
	});
});

describe("Test 15c: Postflight gate unsatisfied → error notification emitted", () => {
	it("emits error notification when postflight returns output-missing", async () => {
		const { proj, taskId } = scaffoldProject();
		mockStoreCliVerdict({});

		const failure = JSON.stringify({
			phase: "plan",
			reasonCode: "output-missing",
			detail: "output-missing: artifact absent: engineering/sprints/FORGE-S26/FORGE-S26-T19/PLAN.md",
			remediation: "Re-run the phase.",
		});

		vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
			const argArr = args as string[] | undefined;
			if (argArr && String(argArr[0]).includes("postflight-gate")) {
				return { status: 1, stdout: Buffer.from(failure), stderr: Buffer.from("") };
			}
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should emit error notification
		const errorNotify = ctx.notifications.find((n) => n.level === "error");
		expect(errorNotify).toBeDefined();
	});
});

describe("Test 15d: Postflight gate failure → pipeline halts at first phase", () => {
	it("does not advance to next phase when postflight fails", async () => {
		const { proj, taskId } = scaffoldProject();
		mockStoreCliVerdict({});

		const failure = JSON.stringify({
			phase: "plan",
			reasonCode: "output-missing",
			detail: "output-missing: artifact absent: engineering/sprints/FORGE-S26/FORGE-S26-T19/PLAN.md",
			remediation: "Re-run the phase.",
		});

		vi.mocked(spawnSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
			const argArr = args as string[] | undefined;
			if (argArr && String(argArr[0]).includes("postflight-gate")) {
				return { status: 1, stdout: Buffer.from(failure), stderr: Buffer.from("") };
			}
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Pipeline halted — createAgentSession called at most once (plan phase)
		// The second phase (review-plan) must NOT have been started
		const sessionCallCount = vi.mocked(createAgentSession).mock.calls.length;
		expect(sessionCallCount).toBeLessThanOrEqual(1);
	});
});

// ── buildSummariesBlock + composeTaskBody (forge-cli#19) ──────────────────

describe("buildSummariesBlock", () => {
	it("returns empty string for undefined summaries", () => {
		expect(buildSummariesBlock(undefined)).toBe("");
	});

	it("returns empty string for empty summaries object", () => {
		expect(buildSummariesBlock({})).toBe("");
	});

	it("formats a single phase summary", () => {
		const summaries = {
			plan: {
				objective: "Implement auth module",
				key_changes: ["Add login endpoint", "Add JWT middleware"],
				verdict: "approved",
				artifact_ref: "engineering/sprints/S01/PLAN.md",
				written_at: "2026-05-23T10:00:00Z",
			},
		};
		const block = buildSummariesBlock(summaries);
		expect(block).toContain("## Prior phase summaries");
		expect(block).toContain("### plan");
		expect(block).toContain("Objective: Implement auth module");
		expect(block).toContain("Verdict: approved");
		expect(block).toContain("Key changes: Add login endpoint; Add JWT middleware");
		expect(block).toContain("Full artifact: engineering/sprints/S01/PLAN.md");
	});

	it("includes multiple phases in order", () => {
		const summaries = {
			implementation: { objective: "Coded it", written_at: "2026-05-23T12:00:00Z" },
			plan: { objective: "Planned it", written_at: "2026-05-23T10:00:00Z" },
			review_plan: { objective: "Reviewed plan", verdict: "approved", written_at: "2026-05-23T11:00:00Z" },
		};
		const block = buildSummariesBlock(summaries);
		const planIdx = block.indexOf("### plan");
		const reviewIdx = block.indexOf("### review_plan");
		const implIdx = block.indexOf("### implementation");
		expect(planIdx).toBeLessThan(reviewIdx);
		expect(reviewIdx).toBeLessThan(implIdx);
	});

	it("includes findings when present", () => {
		const summaries = {
			code_review: {
				objective: "Review implementation",
				findings: ["Missing error handling in auth.ts", "Unused import"],
				verdict: "revision",
				written_at: "2026-05-23T13:00:00Z",
			},
		};
		const block = buildSummariesBlock(summaries);
		expect(block).toContain("Findings: Missing error handling in auth.ts; Unused import");
	});

	it("skips unknown summary keys", () => {
		const summaries = {
			plan: { objective: "Planned it", written_at: "2026-05-23T10:00:00Z" },
			unknown_phase: { objective: "Should not appear", written_at: "2026-05-23T10:00:00Z" },
		};
		const block = buildSummariesBlock(summaries);
		expect(block).toContain("### plan");
		expect(block).not.toContain("unknown_phase");
	});
});

describe("composeTaskBody", () => {
	it("composes without summaries block", () => {
		const body = composeTaskBody("# Workflow\nStep 1", "T01");
		expect(body).toContain("Task ID: T01");
		expect(body).toContain("# Workflow\nStep 1");
		expect(body).not.toContain("Prior phase summaries");
	});

	it("injects summaries block between header and workflow", () => {
		const body = composeTaskBody("# Workflow\nStep 1", "T01", "## Prior phase summaries\n\n### plan\nObjective: X");
		expect(body).toContain("Task ID: T01");
		expect(body).toContain("## Prior phase summaries");
		expect(body).toContain("### plan");
		const summaryIdx = body.indexOf("Prior phase summaries");
		const workflowIdx = body.indexOf("# Workflow");
		expect(summaryIdx).toBeLessThan(workflowIdx);
	});
});
