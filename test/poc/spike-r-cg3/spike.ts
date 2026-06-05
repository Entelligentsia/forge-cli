/**
 * Spike R-CG3 — session_before_compact override + proactive session.compact().
 *
 * FORGE-S30-T08 — Proves that:
 *   1. pi.on("session_before_compact", ...) returning { compaction } causes pi
 *      to use the provided summary verbatim, skipping its own generateSummary /
 *      SUMMARIZATION_PROMPT.
 *   2. session.compact() can be called proactively from a runForgeSubagent-style
 *      in-process session.
 *   3. The auto-compaction path always passes customInstructions: undefined in
 *      the event payload; returning { customInstructions } is ignored — only
 *      { compaction } bypasses the internal LLM call.
 *
 * No production code is touched; this is a test/poc spike only.
 *
 * Key API facts (from dist/core/agent-session.js):
 *   Manual path (session.compact(), lines 1285-1343):
 *     payload: { type, preparation, branchEntries, customInstructions, signal }
 *     { compaction } → extensionCompaction set, fromExtension=true → compact() NOT called
 *     { cancel } → throws "Compaction cancelled"
 *     undefined  → falls through to compact()
 *
 *   Auto path (_runAutoCompaction, lines 1516-1587):
 *     payload: { type, preparation, branchEntries, customInstructions: undefined, signal }
 *     { compaction } → extensionCompaction set, fromExtension=true
 *     { cancel }     → emits compaction_end(aborted=true), returns false
 *     { customInstructions: "x" } → IGNORED (only result.compaction and result.cancel checked)
 *
 * SessionBeforeCompactResult shape (types.d.ts):
 *   interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult; }
 *   Note: NO customInstructions field on the result type.
 *
 * CompactionResult shape (compaction.d.ts):
 *   interface CompactionResult { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: T; }
 *
 * Event routing:
 *   session_before_compact → ExtensionRunner.emit() (extension event)
 *   session_compact        → ExtensionRunner.emit() (extension event)
 *   compaction_end         → session.subscribe() / AgentSessionEvent (session event bus)
 */

import type {
	AgentSession,
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Synthetic summary string supplied by the spike extension as the compaction. */
export const FORGE_COMPACT_SUMMARY =
	"[R-CG3 spike] Extension-supplied compaction summary — verbatim override confirmed.";

// ---------------------------------------------------------------------------
// Evidence interface
// ---------------------------------------------------------------------------

/** Evidence captured by the session_before_compact handler and session events. */
export interface SpikeCG3Evidence {
	/** Number of times the session_before_compact handler fired. */
	handlerFireCount: number;
	/** Whether the compaction came from extension (captured from session_compact event). */
	fromExtension: boolean | null;
	/** Summary from the session_compact event (to verify verbatim usage). */
	emittedSummary: string | null;
	/** Raw event payloads captured by the handler (for AC3 nuance assertion). */
	capturedEventPayloads: Array<{
		customInstructions: string | undefined;
		hasPreparation: boolean;
	}>;
	/** Whether compaction_end was emitted after compact(). */
	compactionEndFired: boolean;
}

export function freshEvidence(): SpikeCG3Evidence {
	return {
		handlerFireCount: 0,
		fromExtension: null,
		emittedSummary: null,
		capturedEventPayloads: [],
		compactionEndFired: false,
	};
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

/**
 * Register the R-CG3 spike handlers on a real or stub ExtensionAPI.
 *
 * Registers:
 * 1. session_before_compact: captures event payload, returns { compaction } with
 *    FORGE_COMPACT_SUMMARY so pi skips generateSummary.
 * 2. session_compact: captures fromExtension and emittedSummary from the saved
 *    compactionEntry.
 *
 * The firstKeptEntryId and tokensBefore are passed through from preparation
 * (the preparation object comes directly from prepareCompaction).
 */
export function registerSpikeCG3(pi: ExtensionAPI, evidence: SpikeCG3Evidence): void {
	// Handler 1: intercept compaction, supply extension summary.
	pi.on("session_before_compact", (event: SessionBeforeCompactEvent): SessionBeforeCompactResult => {
		evidence.handlerFireCount++;

		// Capture payload shape for AC3 assertion.
		evidence.capturedEventPayloads.push({
			customInstructions: event.customInstructions,
			hasPreparation: !!event.preparation,
		});

		// Return a fabricated CompactionResult — pi must use this verbatim.
		const compaction: CompactionResult = {
			summary: FORGE_COMPACT_SUMMARY,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		};

		return { compaction };
	});

	// Handler 2: capture the session_compact event (extension runner path).
	pi.on("session_compact", (event: SessionCompactEvent): void => {
		evidence.fromExtension = event.fromExtension;
		// compactionEntry is the saved CompactionEntry in session storage.
		// It has a summary field matching our FORGE_COMPACT_SUMMARY.
		const entry = event.compactionEntry as { summary?: string };
		if (entry?.summary) {
			evidence.emittedSummary = entry.summary;
		}
	});
}

/**
 * Build an ExtensionFactory wrapping registerSpikeCG3.
 *
 * Pass this to createAgentSession's extensionFactories array to wire the
 * spike extension into a real session (integration test path).
 */
export function spikeCG3ExtensionFactory(evidence: SpikeCG3Evidence): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		registerSpikeCG3(pi, evidence);
	};
}

// ---------------------------------------------------------------------------
// Session event subscription helper
// ---------------------------------------------------------------------------

/**
 * Subscribe to session-level events (compaction_end) via session.subscribe().
 *
 * Returns the unsubscribe function.
 */
export function subscribeSessionEvents(
	session: AgentSession,
	evidence: SpikeCG3Evidence,
): () => void {
	return session.subscribe((event) => {
		if (event.type === "compaction_end") {
			evidence.compactionEndFired = true;
		}
	});
}

// ---------------------------------------------------------------------------
// Stub ExtensionAPI
// ---------------------------------------------------------------------------

/** Minimal stub for unit-testing handler registration without a real pi runtime. */
export interface StubAPIRecord {
	handlers: Array<{ event: string; handler: unknown }>;
}

export function makeStubPi(record: StubAPIRecord): ExtensionAPI {
	return {
		on(event: string, handler: unknown) {
			record.handlers.push({ event, handler });
		},
	} as unknown as ExtensionAPI;
}
