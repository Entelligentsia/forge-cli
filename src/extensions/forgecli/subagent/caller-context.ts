// caller-context.ts — Tracks whether the current handler execution
// is running in orchestrator or subagent context (FORGE-S21-T01).
//
// Default: "orchestrator". Handlers in T02/T03/T07 orchestrators set
// to "subagent" during sub-workflow dispatch to enable assertAudience
// to refuse orchestrator-only workflows when invoked from a subagent chain.
//
// Critical invariant: pi-runtime has NO caller-context API (confirmed by
// FORGE-S21-T01 spike — see SPIKE-LESSONS.md). This singleton is the
// ONLY mechanism for passing caller context into assertAudience.
//
// Thread safety: Pi serialises agent turns; the RAII scopers (asSubagent /
// asOrchestrator) restore prior state on return-or-throw, so interleaving
// within a single process is safe.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL7 — no silent continuation; all errors are thrown.
//   No pi-runtime dependency: pure in-memory singleton.

/** Caller context of the current handler invocation. */
export type CallerContext = "orchestrator" | "subagent";

let _current: CallerContext = "orchestrator";

/**
 * Singleton that tracks the caller context for the current handler turn.
 *
 * Usage:
 *   - Read with `CallerContextStore.get()` — used by `assertAudience()`.
 *   - Set with `CallerContextStore.set("subagent")` — used by T02/T03/T07 orchestrator handlers.
 *   - Use `CallerContextStore.asSubagent(fn)` / `asOrchestrator(fn)` for RAII-style scoping.
 */
export const CallerContextStore = {
	/** Get the current caller context. Defaults to "orchestrator". */
	get(): CallerContext {
		return _current;
	},
	/** Set the current caller context. */
	set(ctx: CallerContext): void {
		_current = ctx;
	},
	/**
	 * Execute fn with context set to "subagent"; restore prior context on
	 * return or throw.
	 */
	asSubagent<T>(fn: () => T): T {
		const prev = _current;
		_current = "subagent";
		try {
			return fn();
		} finally {
			_current = prev;
		}
	},
	/**
	 * Execute fn with context set to "orchestrator"; restore prior context on
	 * return or throw.
	 */
	asOrchestrator<T>(fn: () => T): T {
		const prev = _current;
		_current = "orchestrator";
		try {
			return fn();
		} finally {
			_current = prev;
		}
	},
};
