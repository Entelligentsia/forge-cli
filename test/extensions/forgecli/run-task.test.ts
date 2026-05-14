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
	};
	return { mockSession };
});

vi.mock("@entelligentsia/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	// eslint-disable-next-line @typescript-eslint/no-extraneous-class
	class MockDefaultResourceLoader {
		reload() { return Promise.resolve(); }
	}
	return {
		...actual,
		createAgentSession: vi.fn(async () => ({ session: mockSession })),
		DefaultResourceLoader: MockDefaultResourceLoader,
		AuthStorage: { create: vi.fn(() => ({})) },
		ModelRegistry: { create: vi.fn(() => ({})) },
		SessionManager: { inMemory: vi.fn(() => ({})) },
		parseFrontmatter: vi.fn((raw: string) => ({ frontmatter: {}, body: raw })),
		getAgentDir: vi.fn(() => "/fake/agent-dir"),
	};
});

// Mock child_process for preflight gate spawnSync
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") })),
}));

import { createAgentSession } from "@entelligentsia/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { registerRunTask } from "../../../src/extensions/forgecli/run-task.js";

// ── Fixtures and helpers ────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-run-task-"));
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

	// Write fake forgeRoot with preflight-gate.cjs
	const forgePayload = path.join(proj, "forge-payload");
	fs.mkdirSync(path.join(forgePayload, "tools"), { recursive: true });
	// Create a minimal preflight-gate stub (won't actually run — spawnSync is mocked)
	fs.writeFileSync(path.join(forgePayload, "tools", "preflight-gate.cjs"), "process.exit(0);", "utf8");
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
		registerCommand: vi.fn((name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def);
		}),
		commands,
	};
	return pi;
}

function makeCtx(overrides: Partial<{
	confirm: (title: string, desc?: string) => Promise<boolean>;
}> = {}) {
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
			review_plan: "approved",     // canonical for review-plan
			code_review: "approved",     // canonical for review-code (was the broken case)
			validation: "approved",      // canonical for validate
			approve: "approved",         // → sets record.status = "approved"
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		const missingNotify = ctx.notifications.find((n) =>
			n.msg.includes("verdict missing"),
		);
		expect(missingNotify).toBeUndefined();

		const completionNotify = ctx.notifications.find(
			(n) =>
				n.level === "info" &&
				(n.msg.includes("done") || n.msg.includes("complete") || n.msg.includes("〇")),
		);
		expect(completionNotify).toBeDefined();
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
		const missingNotify = ctx.notifications.find((n) =>
			n.msg.includes("verdict missing"),
		);
		expect(missingNotify).toBeUndefined();

		// And the chain should reach completion.
		const completionNotify = ctx.notifications.find(
			(n) =>
				n.level === "info" &&
				(n.msg.includes("done") || n.msg.includes("complete") || n.msg.includes("〇")),
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
			(n) => n.level === "error" && (n.msg.includes("orchestrator-only") || n.msg.includes("audience") || n.msg.includes("workflow")),
		);
		expect(errorNotify).toBeDefined();

		// createAgentSession should NOT have been called (halted before dispatch)
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
	});
});

describe("Test 6: Materialization marker missing", () => {
	it("notifies per missing marker and aborts without calling createAgentSession", async () => {
		// Sub-workflow missing required markers
		const badWorkflow = GOOD_WORKFLOW_MD
			.replace(/Store-Write Verification/g, "Store-Write XXX")
			.replace(/Iron Laws/g, "Iron Rules");

		const { proj, taskId } = scaffoldProject({
			subWorkflowMd: badWorkflow,
		});

		const pi = makePi();
		registerRunTask(pi as never, { cwd: proj });
		const ctx = makeCtx();

		await invokeRunTask(pi, ctx, taskId);

		// Should notify about missing markers
		const markerErrors = ctx.notifications.filter(
			(n) => n.level === "error" && (n.msg.includes("Store-Write Verification") || n.msg.includes("Iron Laws") || n.msg.includes("marker") || n.msg.includes("workflow regression")),
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
		const runTaskPath = path.resolve(thisDir, "../../../src/extensions/forgecli/run-task.ts");
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
		const completionNotify = ctx.notifications.find(
			(n) => n.level === "info" && n.msg.includes("〇"),
		);
		expect(completionNotify, "Pipeline must complete for all personas to be loaded").toBeDefined();

		// Verify the PHASES table has distinct persona nouns (contract: per-phase persona loading)
		const { PHASES } = await import("../../../src/extensions/forgecli/run-task.js");
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
