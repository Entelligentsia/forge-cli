// caller-context.ts — Tracks whether the current handler execution
// is running in orchestrator or subagent context (FORGE-S21-T01),
// and — when in subagent context — which phase is executing
// (FORGE-BUG-040).
//
// Default: orchestrator. The fix-bug and run-task orchestrators wrap
// per-phase runForgeSubagent dispatch in CallerContextStore.asSubagent(
// phase.role, ...) so downstream tool calls (forge_preflight, forge_store
// update-status / set-bug-summary / set-summary / emit) can verify the
// caller's phase matches the phase named in the tool arguments. See
// subagent/phase-guard.ts.
//
// Critical invariant: pi-runtime has NO caller-context API (confirmed by
// FORGE-S21-T01 spike — see SPIKE-LESSONS.md). This singleton is the
// ONLY mechanism for passing caller context into assertAudience and the
// phase-ownership guard.
//
// Thread safety: Pi serialises agent turns; the RAII scopers (asSubagent /
// asOrchestrator) restore prior state on return-or-throw, so interleaving
// within a single process is safe.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL7 — no silent continuation; all errors are thrown.
//   No pi-runtime dependency: pure in-memory singleton.

/**
 * Canonical phase identifiers used by both `meta-orchestrate.md` and
 * `meta-fix-bug.md` (the latter adds `triage`). When a subagent is
 * dispatched, its phase tag MUST be one of these values — that lets the
 * phase-ownership guard compare the caller's phase against the tool's
 * named `--phase` argument.
 */
export type PhaseRole =
	| "triage"
	| "plan"
	| "plan-fix"
	| "review-plan"
	| "implement"
	| "review-code"
	| "validate"
	| "approve"
	| "writeback"
	| "commit"
	| "finalize";

/**
 * Caller context of the current handler invocation. Discriminated union:
 * orchestrator (default) or subagent + phase. Subagent context is set
 * exclusively by `asSubagent(phase, fn)` — the single setter point in
 * the per-phase orchestrator dispatch loop.
 */
export type CallerContext = { kind: "orchestrator" } | { kind: "subagent"; phase: PhaseRole };

let _current: CallerContext = { kind: "orchestrator" };

/**
 * Singleton that tracks the caller context for the current handler turn.
 *
 * Usage:
 *   - Read with `CallerContextStore.get()` — used by `assertAudience()`
 *     and `assertPhaseOwnership()`.
 *   - Set with `CallerContextStore.set(...)` — used by orchestrator
 *     handlers when RAII scoping is not viable (avoid where possible).
 *   - Use `CallerContextStore.asSubagent(phase, fn)` /
 *     `asOrchestrator(fn)` for RAII-style scoping. The async overload
 *     accepts an `async () => Promise<T>` and awaits before restoring
 *     prior context.
 */
export const CallerContextStore = {
	/** Get the current caller context. Defaults to `{ kind: "orchestrator" }`. */
	get(): CallerContext {
		return _current;
	},
	/** Set the current caller context. */
	set(ctx: CallerContext): void {
		_current = ctx;
	},
	/**
	 * Execute fn with context set to `{ kind: "subagent", phase }`; restore
	 * prior context on return or throw. Supports sync and async fn — the
	 * return type is preserved so `await` works at the call site.
	 */
	asSubagent<T>(phase: PhaseRole, fn: () => T): T {
		const prev = _current;
		_current = { kind: "subagent", phase };
		try {
			const out = fn();
			if (out instanceof Promise) {
				return out.finally(() => {
					_current = prev;
				}) as unknown as T;
			}
			_current = prev;
			return out;
		} catch (err) {
			_current = prev;
			throw err;
		}
	},
	/**
	 * Execute fn with context set to `{ kind: "orchestrator" }`; restore prior
	 * context on return or throw.
	 */
	asOrchestrator<T>(fn: () => T): T {
		const prev = _current;
		_current = { kind: "orchestrator" };
		try {
			const out = fn();
			if (out instanceof Promise) {
				return out.finally(() => {
					_current = prev;
				}) as unknown as T;
			}
			_current = prev;
			return out;
		} catch (err) {
			_current = prev;
			throw err;
		}
	},
};
