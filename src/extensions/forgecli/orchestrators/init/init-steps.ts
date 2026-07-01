// init-steps.ts — the /forge:init step machine (FORGE-S35-T02, Slice 1).
//
// Replaces the coarse four-phase `INIT_PHASES` walk with a flat table of
// `Step` descriptors. Each Step declares:
//   - `dependsOn`     — ordering edges (the only serialization constraint);
//   - `precondition`  — a deterministic input-readiness/ordering gate checked
//                       BEFORE any run/dispatch (halts pre-dispatch on failure);
//   - `run`           — a discriminated union: a deterministic thunk (local
//                       tool/fs work, spawns NO subagent) OR a scoped subagent
//                       descriptor dispatched through the existing
//                       runForgeSubagent path (IL10 unchanged);
//   - `requiredOutput`— a deterministic postcondition; on failure the step is
//                       rerun up to `retryPolicy.maxReruns`, then the pipeline
//                       halts;
//   - `retryPolicy`   — `{ maxReruns }` (0 = hard-halt on first failure).
//
// `topoSortWaves` groups steps with no unresolved dependency into the same wave
// (Kahn layering); `runWave` dispatches a wave's steps concurrently via
// `Promise.all` (no new npm dependency — built-ins only). Steps sharing a wave
// are independent and overlap; cross-reference edges are the sole ordering
// constraint.
//
// This module holds ONLY the reusable machine + the `Step` contract. The
// concrete `INIT_STEPS` table (which closes over pipeline runtime state and the
// forge-init deterministic helpers) is assembled by the orchestrator in
// run-init-pipeline.ts. Keeping the primitives free of forge-init imports keeps
// them independently unit-testable (init-steps.test.ts).
//
// Layering: type-only imports from sibling subagent modules; no runtime deps.

import type { PhaseRole } from "../../subagent/caller-context.js";
import type { SubagentResult } from "../../forge-subagent.js";

// ── Step contract ─────────────────────────────────────────────────────────────

export type StepId = string;

/**
 * Runtime context threaded through a single pipeline run. Opaque to the machine
 * primitives — the orchestrator defines the concrete shape and reads/writes its
 * own mutable pipeline state (configCache, verify flags, …) through it.
 *
 * NOTE: within a wave, steps run CONCURRENTLY and share this one ctx object, so
 * the machine never stashes per-step run results on it (that would race). A
 * subagent step's `requiredOutput` receives its own dispatch result as the
 * second argument instead. Only single-step waves (deterministic gates) mutate
 * ctx fields, so those reads/writes are race-free.
 */
export interface StepRuntimeCtx {
	// Orchestrator-owned mutable pipeline fields live here.
	[key: string]: unknown;
}

export interface StepCheckResult {
	ok: boolean;
	reason?: string;
}

/**
 * Deterministic precondition / postcondition — never fabricates LLM facts.
 * `requiredOutput` receives the step's own subagent dispatch result (if any) as
 * `lastResult`; `precondition` is always called with `lastResult` undefined.
 */
export type StepCheck = (ctx: StepRuntimeCtx, lastResult?: SubagentResult) => Promise<StepCheckResult>;

/** A deterministic step: local tool/fs work, spawns NO subagent. */
export interface DeterministicRun {
	kind: "deterministic";
	thunk: (ctx: StepRuntimeCtx) => Promise<void>;
}

/** A scoped single-responsibility subagent descriptor. */
export interface SubagentRun {
	kind: "subagent";
	/** Which bundled phase prompt to read (1 = collect, 2 = discover). */
	promptPhase: 1 | 2;
	/** Dispatch label / OrchestratorTree node id fragment. */
	subLabel: string;
	/** CallerContextStore role the dispatch runs under. */
	subRole: PhaseRole;
	/** ROLE_TIER key for model resolution. */
	modelRole: string;
	/** Persona noun (loaded from the bundle base-pack). */
	persona: string;
	/** TypeBox schema passed to runForgeSubagent (optional). */
	schema?: object;
	/** Coarse phase group used for IL10 phase-event naming. */
	phaseGroup: string;
	/** Inject the per-step `<!-- AGENT PARAMS -->` block onto the base prompt. */
	buildPrompt: (basePrompt: string, ctx: StepRuntimeCtx) => string;
}

export type StepRun = DeterministicRun | SubagentRun;

export interface RetryPolicy {
	/** 0 = hard-halt on first requiredOutput failure; 1 = one rerun then halt. */
	maxReruns: number;
}

export interface Step {
	id: StepId;
	/** Ordering edges — the only serialization constraint (topo layering). */
	dependsOn: StepId[];
	/** Deterministic gate checked BEFORE run/dispatch. */
	precondition?: StepCheck;
	run: StepRun;
	/** Deterministic postcondition checked AFTER each run. */
	requiredOutput?: StepCheck;
	retryPolicy: RetryPolicy;
}

// ── Step outcome + runner deps ────────────────────────────────────────────────

export interface StepOutcome {
	ok: boolean;
	reason?: string;
	/** True when the step actually dispatched a subagent (for IL10 emission). */
	dispatched: boolean;
	/** Number of run attempts (initial + reruns). */
	attempts: number;
	/** The subagent result for a dispatched step (undefined for deterministic). */
	result?: SubagentResult;
	/**
	 * Wall-clock bracket for THIS step (epoch ms). Captured per step so IL10
	 * emission attributes each subagent's own duration and builds a per-step
	 * unique event timestamp — NOT the shared wave bracket (which over-attributes
	 * duration and collides eventIds across a fan-out wave).
	 */
	startMs: number;
	endMs: number;
}

/** Dispatch a subagent step and return its result. Injected so tests can spy. */
export type SubagentDispatcher = (run: SubagentRun, ctx: StepRuntimeCtx) => Promise<SubagentResult>;

export interface RunStepDeps {
	ctx: StepRuntimeCtx;
	dispatchSubagent: SubagentDispatcher;
}

// ── runStep ───────────────────────────────────────────────────────────────────

/**
 * Drive one step: check precondition (halt pre-dispatch on failure) → run
 * (deterministic thunk OR subagent) → check requiredOutput → on failure rerun
 * up to `retryPolicy.maxReruns`, else halt.
 *
 * A precondition failure returns `{ ok:false, dispatched:false }` with ZERO
 * dispatches — the gate is always checked before any subagent is spawned.
 */
export async function runStep(step: Step, deps: RunStepDeps): Promise<StepOutcome> {
	const { ctx, dispatchSubagent } = deps;
	const startMs = Date.now();

	if (step.precondition) {
		const pc = await step.precondition(ctx);
		if (!pc.ok) {
			return {
				ok: false,
				reason: pc.reason ?? `precondition failed for step "${step.id}"`,
				dispatched: false,
				attempts: 0,
				startMs,
				endMs: Date.now(),
			};
		}
	}

	const isSubagent = step.run.kind === "subagent";
	const maxAttempts = 1 + Math.max(0, step.retryPolicy?.maxReruns ?? 0);
	let attempts = 0;
	let lastResult: SubagentResult | undefined;
	let lastReason: string | undefined;

	while (attempts < maxAttempts) {
		attempts++;

		if (step.run.kind === "deterministic") {
			await step.run.thunk(ctx);
		} else {
			lastResult = await dispatchSubagent(step.run, ctx);
		}

		if (!step.requiredOutput) {
			return { ok: true, dispatched: isSubagent, attempts, result: lastResult, startMs, endMs: Date.now() };
		}

		const ro = await step.requiredOutput(ctx, lastResult);
		if (ro.ok) {
			return { ok: true, dispatched: isSubagent, attempts, result: lastResult, startMs, endMs: Date.now() };
		}
		lastReason = ro.reason;
		// otherwise loop and rerun while attempts remain
	}

	return {
		ok: false,
		reason: lastReason ?? `requiredOutput failed for step "${step.id}"`,
		dispatched: isSubagent,
		attempts,
		result: lastResult,
		startMs,
		endMs: Date.now(),
	};
}

// ── runWave ─────────────────────────────────────────────────────────────────

/**
 * Dispatch every step in a wave concurrently via `Promise.all`. Steps sharing a
 * wave are independent (no unresolved dependency), so they overlap. Returns the
 * outcomes in the wave's step order. Concurrency is bounded by wave width
 * (≤ 10 for the kb-doc wave), so no explicit limiter is needed this slice.
 */
export async function runWave(
	steps: Step[],
	run: (step: Step) => Promise<StepOutcome>,
): Promise<StepOutcome[]> {
	return Promise.all(steps.map((step) => run(step)));
}

// ── topoSortWaves ─────────────────────────────────────────────────────────────

/**
 * Group steps into topo-sorted waves (Kahn layering): every step whose
 * dependencies are all satisfied by earlier waves lands in the next wave.
 * Declaration order is preserved within a wave. Throws on a dependency cycle.
 * Edges to unknown step ids are ignored (treated as already-satisfied).
 */
export function topoSortWaves(steps: Step[]): Step[][] {
	const known = new Set(steps.map((s) => s.id));
	const deps = new Map<StepId, StepId[]>();
	for (const s of steps) {
		deps.set(s.id, (s.dependsOn ?? []).filter((d) => known.has(d)));
	}

	const waves: Step[][] = [];
	const placed = new Set<StepId>();

	while (placed.size < steps.length) {
		const layer = steps.filter(
			(s) => !placed.has(s.id) && (deps.get(s.id) ?? []).every((d) => placed.has(d)),
		);
		if (layer.length === 0) {
			const stuck = steps.filter((s) => !placed.has(s.id)).map((s) => s.id);
			throw new Error(`init-steps: cyclic or unsatisfiable dependency among [${stuck.join(", ")}]`);
		}
		waves.push(layer);
		for (const s of layer) placed.add(s.id);
	}

	return waves;
}
