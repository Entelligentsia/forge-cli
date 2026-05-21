// test/helpers/scripted-subagent.ts — scripted StreamFn builders for forge-cli tests.
//
// Built on top of pi's `streamFn` seam (see forge-subagent.ts and forge-cli#17).
// The agent loop still executes real tool calls; only the LLM provider is
// replaced. Use these helpers to script the LLM's stop reason / final message
// while letting real Bash/Read/Write/MCP tools run against a real working dir.
//
// Builders:
//   scriptArchitectCeremony  — successful ceremony completion (no tool calls)
//   scriptTaskPipelinePhase  — successful single-phase completion (no tool calls)
//   scriptHalt               — emits an error event (subagent returns exitCode=1)
//   scriptTaskPipeline       — StreamFnFactory for sprint-level orchestration
//                              (script per phase + ceremony in one place)
//
// Verdict resolution (e.g., "did the architect approve?") is driven by the
// TESTBENCH FIXTURE state, not by the script. The orchestrator reads sprint /
// task status from the real store after the subagent returns — set the
// status in the fixture to control the verdict the orchestrator resolves.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Api, Provider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

// ── Shared assistant-message builder ─────────────────────────────────────

interface MessageOptions {
	model?: string;
	provider?: string;
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}

function buildAssistantMessage(opts: MessageOptions): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: opts.text ?? "" }],
		api: "anthropic" as Api,
		provider: (opts.provider ?? "test-provider") as Provider,
		model: opts.model ?? "test-model",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: opts.stopReason ?? "stop",
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

// ── Builders ─────────────────────────────────────────────────────────────

export interface ScriptArchitectCeremonyOptions {
	/**
	 * Documentation hint for the test reader — the actual verdict the
	 * orchestrator resolves comes from the sprint status in the testbench
	 * store, not from the scripted stream. Setting this affects nothing in
	 * the script; use it to flag intent for human readers.
	 */
	verdict?: "complete" | "partial" | "revision-required";
	model?: string;
	provider?: string;
	text?: string;
}

/** Successful architect-ceremony stream — emits start + done. */
export function scriptArchitectCeremony(opts: ScriptArchitectCeremonyOptions = {}): StreamFn {
	return () =>
		emitDoneStream({
			model: opts.model ?? "test-architect-model",
			provider: opts.provider ?? "test-architect-provider",
			text: opts.text ?? "Ceremony completed.",
		});
}

export interface ScriptTaskPipelinePhaseOptions {
	model?: string;
	provider?: string;
	text?: string;
}

/** Successful pipeline-phase stream — emits start + done. */
export function scriptTaskPipelinePhase(opts: ScriptTaskPipelinePhaseOptions = {}): StreamFn {
	return () =>
		emitDoneStream({
			model: opts.model ?? "test-phase-model",
			provider: opts.provider ?? "test-phase-provider",
			text: opts.text ?? "Phase completed.",
		});
}

export interface ScriptHaltOptions {
	errorMessage?: string;
	model?: string;
	provider?: string;
}

/** Failing stream — emits start + error. runForgeSubagent returns exitCode=1. */
export function scriptHalt(opts: ScriptHaltOptions = {}): StreamFn {
	return () =>
		emitErrorStream({
			model: opts.model ?? "test-halt-model",
			provider: opts.provider ?? "test-halt-provider",
			errorMessage: opts.errorMessage ?? "scripted halt",
		});
}

// ── Approved-phase summaries for fixture pre-population ──────────────────
//
// When scripting a task through the full pipeline (all phases complete
// successfully), review phases call readVerdict() which reads from the store.
// Pre-populate these summaries in the fixture so each review gate passes.
// The "approve" phase is special — it reads task.status === "approved" rather
// than a summary verdict. Set fixture.updateTaskStatus(taskId, "approved")
// before running the pipeline with these summaries in place.

export interface PhaseSummary {
	objective: string;
	written_at: string;
	verdict: string;
}

/** Approved-phase summaries for every review gate in the task pipeline. */
export const APPROVED_PHASE_SUMMARIES: Record<string, PhaseSummary> = {
	plan:          { objective: "Plan created",       written_at: "2026-01-01T00:00:00Z", verdict: "approved" },
	review_plan:   { objective: "Plan reviewed",      written_at: "2026-01-01T00:01:00Z", verdict: "approved" },
	implementation: { objective: "Implementation done", written_at: "2026-01-01T00:02:00Z", verdict: "approved" },
	code_review:   { objective: "Code reviewed",      written_at: "2026-01-01T00:03:00Z", verdict: "approved" },
	validation:   { objective: "Validation passed",   written_at: "2026-01-01T00:04:00Z", verdict: "approved" },
};

/**
 * Prepare a task for full pipeline completion by pre-populating all review
 * verdict summaries and transitioning task status through to "approved".
 * The verdicts let the pipeline's readVerdict() checks pass, so the task
 * can complete all phases when scripted with scriptTaskPipelinePhase().
 *
 * Status transitions: plan-approved → implementing → implemented →
 * review-approved → approved (via real store-cli).
 *
 * Note: we stop at "approved" rather than "committed" because the sprint
 * handler skips tasks with status "committed" or "completed". A task at
 * "approved" status will run through the pipeline normally.
 */
export function approveTaskInFixture(
	updateTaskStatus: (taskId: string, status: string) => void,
	addTaskSummaries: (taskId: string, phases: Record<string, PhaseSummary>) => void,
	taskId: string,
): void {
	addTaskSummaries(taskId, APPROVED_PHASE_SUMMARIES);
	// Transition through valid statuses to reach "approved".
	// The sprint handler skips tasks at "committed"/"completed" but NOT
	// "approved", so a task at "approved" will run through the pipeline.
	for (const status of ["implementing", "implemented", "review-approved", "approved"]) {
		updateTaskStatus(taskId, status);
	}
}

// ── Factory for sprint-level orchestration ────────────────────────────────

export interface ScriptFactoryContext {
	kind: "task-phase" | "ceremony";
	persona: string;
	phase?: string;
	taskId?: string;
}

export type StreamFnFactory = (ctx: ScriptFactoryContext) => StreamFn | undefined;

export interface ScriptTaskPipelineOptions {
	/** Phase role name to inject a halt at (e.g. "plan", "implement"). */
	failAt?: string;
	/** Override the ceremony stream. Default: scriptArchitectCeremony(). */
	ceremony?: StreamFn;
	model?: string;
	provider?: string;
}

/**
 * Build a StreamFnFactory that scripts both per-phase task pipeline and the
 * ceremony in one place. Pass the returned factory through to
 * `runTaskPipeline({ streamFnFactory })` or `registerRunSprint({ streamFnFactory })`.
 */
export function scriptTaskPipeline(opts: ScriptTaskPipelineOptions = {}): StreamFnFactory {
	return (ctx) => {
		if (ctx.kind === "ceremony") {
			return opts.ceremony ?? scriptArchitectCeremony({ model: opts.model, provider: opts.provider });
		}
		if (opts.failAt && ctx.phase === opts.failAt) {
			return scriptHalt({ errorMessage: `scripted failure at phase ${opts.failAt}` });
		}
		return scriptTaskPipelinePhase({ model: opts.model, provider: opts.provider });
	};
}

// ── Internal stream emitters ─────────────────────────────────────────────

function emitDoneStream(opts: MessageOptions): ReturnType<StreamFn> {
	const stream = createAssistantMessageEventStream();
	const msg = buildAssistantMessage({ ...opts, stopReason: "stop" });
	queueMicrotask(() => {
		stream.push({ type: "start", partial: msg });
		stream.push({ type: "done", reason: "stop", message: msg });
	});
	return stream;
}

function emitErrorStream(opts: MessageOptions): ReturnType<StreamFn> {
	const stream = createAssistantMessageEventStream();
	const msg = buildAssistantMessage({ ...opts, stopReason: "error" });
	queueMicrotask(() => {
		stream.push({ type: "start", partial: msg });
		stream.push({ type: "error", reason: "error", error: msg });
	});
	return stream;
}
