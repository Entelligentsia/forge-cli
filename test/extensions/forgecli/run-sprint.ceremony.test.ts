// Ceremony / event-emission tests for /forge:run-sprint that exercise the REAL
// stack: real session-registry, real forge-subagent (with scripted streamFn),
// real spawnSync against the real forge store-cli, and real schema validation.
//
// Companion to run-sprint.test.ts. The existing file mocks
// forge-subagent / run-task / session-registry at module level — fine for
// orchestration-coordination assertions, but those mocks erase the schema gate
// and the event-emission seam, so schema drift in sprint-complete /
// sprint-halted payloads is undetectable there. This file deliberately uses
// the pi `streamFn` seam (see forge-subagent.ts and test/helpers/scripted-subagent.ts)
// and the disposable testbench (test/fixtures/sprint-fixture.ts) to lock the
// emission path against the real event.schema.json.
//
// See forge-cli#17 acceptance criteria for the broader scope; this file is the
// PoC ceremony rewrite. Remaining ceremony cases follow the same harness shape.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

import { registerRunSprint } from "../../../src/extensions/forgecli/run-sprint.js";
import { buildSprintFixture, realForgeRoot, type SprintFixture } from "../../fixtures/sprint-fixture.js";
import {
	scriptArchitectCeremony,
	scriptHalt,
	type StreamFnFactory,
} from "../../helpers/scripted-subagent.js";

// Use forge's built-in dependency-free validator (same one store-cli.cjs uses
// internally on write). Importing the real validator means schema drift is
// caught at test time even if store-cli's emit path were ever bypassed.
const requireFromHere = createRequire(import.meta.url);
const VALIDATE_JS = path.join(realForgeRoot(), "tools", "lib", "validate.js");
function realValidateRecord(record: unknown, schema: unknown): Array<{ message: string }> {
	const { validateRecord } = requireFromHere(VALIDATE_JS);
	return validateRecord(record, schema, { entity: "event" });
}

// ── Fixtures ────────────────────────────────────────────────────────────

let fixture: SprintFixture | undefined;

beforeEach(() => {
	delete process.env.FORGE_YES;
	delete process.env.FORGE_NON_INTERACTIVE;
});

afterEach(() => {
	delete process.env.FORGE_YES;
	delete process.env.FORGE_NON_INTERACTIVE;
	delete process.env.FORGE_ROOT;
	fixture?.cleanup();
	fixture = undefined;
	vi.restoreAllMocks();
});

function makePi() {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	return {
		registerCommand: vi.fn((name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def);
		}),
		commands,
	};
}

interface CtxOptions {
	confirm?: (title: string, desc?: string) => Promise<boolean>;
}

function makeCtx(opts: CtxOptions = {}) {
	const notifications: { msg: string; level: string }[] = [];
	const statuses: { key: string; val: string | undefined }[] = [];
	return {
		ui: {
			notify: vi.fn((msg: string, level: string) => {
				notifications.push({ msg, level });
			}),
			confirm: vi.fn(opts.confirm ?? (() => Promise.resolve(true))),
			setStatus: vi.fn((key: string, val?: string) => {
				statuses.push({ key, val });
			}),
		},
		hasUI: true,
		notifications,
		statuses,
	};
}

async function invokeRunSprint(
	pi: ReturnType<typeof makePi>,
	ctx: ReturnType<typeof makeCtx>,
	args: string,
): Promise<void> {
	const cmd = pi.commands.get("forge:run-sprint");
	if (!cmd) throw new Error("forge:run-sprint not registered");
	await cmd.handler(args, ctx);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Plan 12 ceremony: clean-complete dispatches architect and emits schema-valid sprint-complete event (real stack)", () => {
	it("emits a sprint-complete event that validates against the real event.schema.json", async () => {
		// Pre-commit both tasks in the fixture so the orchestrator's
		// "skip already-completed tasks" path accumulates them as completed
		// without exercising the per-phase pipeline. Sprint status is
		// pre-set to "completed" so the post-ceremony verdict read
		// resolves to "complete" (the architect's real role of calling
		// update-status is exercised in dedicated architect tests, not here).
		fixture = buildSprintFixture({
			sprintId: "FORGE-S99",
			sprintStatus: "completed",
			tasks: [
				{ id: "FORGE-S99-T01", status: "committed" },
				{ id: "FORGE-S99-T02", status: "committed" },
			],
		});
		process.env.FORGE_YES = "1";

		const streamFnFactory: StreamFnFactory = (ctx) => {
			if (ctx.kind === "ceremony") {
				return scriptArchitectCeremony({
					model:    "test-architect-model",
					provider: "test-architect-provider",
				});
			}
			return undefined;
		};

		const pi = makePi();
		registerRunSprint(pi as never, {
			cwd: fixture.projDir,
			streamFnFactory,
		});
		const ctx = makeCtx();

		await invokeRunSprint(pi, ctx, fixture.sprintId);

		// Real event was written to .forge/store/events/<sprintId>/ via real
		// store-cli emit — which already schema-validates on write. Re-validate
		// here to make the schema gate explicit at the test layer.
		const events = fixture.readEmittedEvents();
		const sprintComplete = events.find((e) => e.type === "sprint-complete");
		expect(sprintComplete, "sprint-complete event was written").toBeDefined();
		if (!sprintComplete) return;

		// Required Plan-12 §4.2 fields
		expect(sprintComplete.sprintId).toBe(fixture.sprintId);
		expect(sprintComplete.role).toBe("architect");
		expect(sprintComplete.action).toBe("sprint-complete");
		expect(sprintComplete.verdict).toBe("complete");
		expect(sprintComplete.taskCount).toBe(2);
		expect(Array.isArray(sprintComplete.completedTaskIds)).toBe(true);
		expect((sprintComplete.completedTaskIds as string[]).sort()).toEqual([
			"FORGE-S99-T01",
			"FORGE-S99-T02",
		]);
		// Model / provider carry-through from scripted ceremony
		expect(sprintComplete.model).toBe("test-architect-model");
		expect(sprintComplete.provider).toBe("test-architect-provider");

		// Explicit schema validation against the real event.schema.json
		const schema = JSON.parse(fs.readFileSync(fixture.eventSchemaPath, "utf8"));
		const errors = realValidateRecord(sprintComplete, schema);
		expect(errors, `expected zero schema errors, got: ${JSON.stringify(errors)}`).toEqual([]);
	});

	it("does NOT dispatch ceremony and emits a schema-valid sprint-halted event when the first phase fails", async () => {
		// Real runTaskPipeline executes for T01. The streamFnFactory injects
		// scriptHalt at the "plan" phase, so runForgeSubagent for that phase
		// returns exitCode=1 → pipeline halts → orchestrator emits sprint-halted
		// (no ceremony dispatched).
		fixture = buildSprintFixture({
			sprintId: "FORGE-S98",
			sprintStatus: "active",
			tasks: [
				{ id: "FORGE-S98-T01" },
				{ id: "FORGE-S98-T02" },
			],
		});
		process.env.FORGE_YES = "1";

		let ceremonyDispatched = false;
		const streamFnFactory: StreamFnFactory = (ctx) => {
			if (ctx.kind === "ceremony") {
				ceremonyDispatched = true;
				return scriptArchitectCeremony();
			}
			if (ctx.phase === "plan") {
				return scriptHalt({ errorMessage: "scripted plan-phase failure" });
			}
			return scriptHalt({ errorMessage: "should not reach this phase" });
		};

		const pi = makePi();
		registerRunSprint(pi as never, {
			cwd: fixture.projDir,
			streamFnFactory,
		});
		const ctx = makeCtx();

		await invokeRunSprint(pi, ctx, fixture.sprintId);

		expect(ceremonyDispatched, "ceremony was NOT dispatched on halt").toBe(false);

		const events = fixture.readEmittedEvents();
		const sprintHalted = events.find((e) => e.type === "sprint-halted");
		expect(sprintHalted, "sprint-halted event was written").toBeDefined();
		if (!sprintHalted) return;

		expect(sprintHalted.sprintId).toBe(fixture.sprintId);
		expect(sprintHalted.haltedAtTaskId).toBe("FORGE-S98-T01");
		expect(sprintHalted.haltedAtTaskIndex).toBe(0);

		const schema = JSON.parse(fs.readFileSync(fixture.eventSchemaPath, "utf8"));
		const errors = realValidateRecord(sprintHalted, schema);
		expect(errors, `expected zero schema errors, got: ${JSON.stringify(errors)}`).toEqual([]);
	});

	it("emits sprint-complete with verdict=partial when the architect ceremony does not transition sprint status", async () => {
		// Sprint pre-set to "active" — ceremony subagent runs successfully but
		// doesn't update sprint status (scripted stream emits no tool calls).
		// Orchestrator reads sprint.status afterwards, fails to resolve
		// "completed" or "partially-completed", falls back to verdict=
		// "revision-required" → mapped at emission boundary to "partial" so
		// the sprint-complete event still emits with the fallback verdict.
		fixture = buildSprintFixture({
			sprintId: "FORGE-S97",
			sprintStatus: "active",
			tasks: [
				{ id: "FORGE-S97-T01", status: "committed" },
			],
		});
		process.env.FORGE_YES = "1";

		const streamFnFactory: StreamFnFactory = (ctx) =>
			ctx.kind === "ceremony" ? scriptArchitectCeremony() : undefined;

		const pi = makePi();
		registerRunSprint(pi as never, { cwd: fixture.projDir, streamFnFactory });
		const ctx = makeCtx();

		await invokeRunSprint(pi, ctx, fixture.sprintId);

		const events = fixture.readEmittedEvents();
		const sprintComplete = events.find((e) => e.type === "sprint-complete");
		expect(sprintComplete).toBeDefined();
		if (!sprintComplete) return;

		// Either "partial" (mapped fallback when verdict resolution drops) is fine.
		expect(["partial", "revision-required"]).toContain(sprintComplete.verdict);

		const schema = JSON.parse(fs.readFileSync(fixture.eventSchemaPath, "utf8"));
		expect(realValidateRecord(sprintComplete, schema)).toEqual([]);
	});

	it("threads the streamFnFactory through to per-task pipeline dispatch (run-task.ts seam)", async () => {
		// Smoke test for the streamFnFactory threading through
		// runTaskPipeline → runForgeSubagent. T01 is not pre-committed, so the
		// real pipeline runs at least one phase. We inject scriptHalt at "plan"
		// and assert the factory was invoked with kind=task-phase + phase=plan.
		// This locks the seam against accidental removal of the threading.
		fixture = buildSprintFixture({
			sprintId: "FORGE-S95",
			sprintStatus: "active",
			tasks: [{ id: "FORGE-S95-T01" }],
		});
		process.env.FORGE_YES = "1";

		const factoryCalls: Array<{ kind: string; phase?: string; taskId?: string; persona: string }> = [];
		const streamFnFactory: StreamFnFactory = (sfctx) => {
			factoryCalls.push({ kind: sfctx.kind, phase: sfctx.phase, taskId: sfctx.taskId, persona: sfctx.persona });
			if (sfctx.kind === "ceremony") return scriptArchitectCeremony();
			return scriptHalt({ errorMessage: `scripted halt at ${sfctx.phase}` });
		};

		const pi = makePi();
		registerRunSprint(pi as never, { cwd: fixture.projDir, streamFnFactory });
		const ctx = makeCtx();

		await invokeRunSprint(pi, ctx, fixture.sprintId);

		// Factory called for at least one task-phase dispatch with phase=plan
		// (the first phase in PHASES).
		const planCalls = factoryCalls.filter(
			(c) => c.kind === "task-phase" && c.phase === "plan" && c.taskId === "FORGE-S95-T01",
		);
		expect(planCalls.length, `expected ≥1 task-phase factory call at plan; got: ${JSON.stringify(factoryCalls)}`).toBeGreaterThanOrEqual(1);

		// Ceremony was NOT dispatched (pipeline halted)
		const ceremonyCalls = factoryCalls.filter((c) => c.kind === "ceremony");
		expect(ceremonyCalls).toEqual([]);

		// sprint-halted event emitted
		const events = fixture.readEmittedEvents();
		const sprintHalted = events.find((e) => e.type === "sprint-halted");
		expect(sprintHalted).toBeDefined();
	});
});
