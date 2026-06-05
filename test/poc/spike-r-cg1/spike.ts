/**
 * Spike R-CG1 — tool_result mutation fidelity (GATE).
 *
 * FORGE-S30-T01 — Proves that returning a mutated `content` array from a
 * `tool_result` extension handler causes the NEXT provider request to carry
 * the mutated (shrunk) content, and that the content is NOT re-expanded from
 * session storage.
 *
 * This is the gate condition for all downstream FORGE-S30 context-governance
 * tasks. No production code is touched; this is a test/poc spike only.
 *
 * Design:
 *   - An ExtensionFactory registers a `tool_result` handler.
 *   - The handler detects the FAT_PAYLOAD_SENTINEL in `event.content` and
 *     replaces it with `[{ type: "text", text: "SHRUNK" }]`.
 *   - The evidence object captures the tool_result handler for unit testing
 *     and the turn-2 llmContext for integration assertions.
 *
 * Mutation path under test:
 *   pi.on("tool_result", handler) → runner.emitToolResult()
 *     → afterToolCall → finalizeExecutedToolCall
 *     → createToolResultMessage → context.messages
 *     → convertToLlm → streamFn(model, llmContext, options)
 *     llmContext.messages[i].role === "toolResult"
 *     llmContext.messages[i].content  ← ASSERT THIS IS SHRUNK
 */

import type {
	ExtensionAPI,
	TextContent,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

/** Sentinel embedded in the fat mock tool output. */
export const FAT_PAYLOAD_SENTINEL = "FAT_TOOL_OUTPUT_LINE_";

/** Expected shrunk content — single text item. */
export const SHRUNK_CONTENT: TextContent[] = [{ type: "text", text: "SHRUNK" }];

/** Captured evidence populated by the tool_result handler and streamFn. */
export interface SpikeCG1Evidence {
	/** Content of the toolResult message as seen by the turn-2 streamFn call. */
	capturedToolResultContent: (TextContent | { type: string; [k: string]: unknown })[] | null;
	/** Full context.messages array from turn-2 streamFn call (for diagnostics). */
	capturedTurn2Messages: unknown[] | null;
	/** Number of times the tool_result handler fired. */
	handlerFireCount: number;
}

let _evidence: SpikeCG1Evidence = freshEvidence();

function freshEvidence(): SpikeCG1Evidence {
	return {
		capturedToolResultContent: null,
		capturedTurn2Messages: null,
		handlerFireCount: 0,
	};
}

export function getEvidence(): SpikeCG1Evidence {
	return _evidence;
}

export function resetEvidence(): void {
	_evidence = freshEvidence();
}

// Capture the registered handler for direct unit-test invocation.
export interface SpikeCG1Captured {
	toolResultHandler?: (
		event: ToolResultEvent,
	) => Promise<ToolResultEventResult | undefined> | ToolResultEventResult | undefined;
}

const _captured: SpikeCG1Captured = {};

export function getCaptured(): SpikeCG1Captured {
	return _captured;
}

/**
 * Register the R-CG1 spike extension.
 *
 * Registers a single `tool_result` handler that:
 * 1. Fires for every tool result.
 * 2. Detects `FAT_PAYLOAD_SENTINEL` in `event.content`.
 * 3. Returns `{ content: SHRUNK_CONTENT }` to shrink the fat payload.
 *
 * @param pi  The ExtensionAPI instance (real pi runtime or stub).
 */
export function registerSpikeCG1(pi: ExtensionAPI): void {
	const handler = (
		event: ToolResultEvent,
	): ToolResultEventResult | undefined => {
		_evidence.handlerFireCount++;
		const hasFatPayload = event.content.some(
			(c): c is TextContent =>
				c.type === "text" && (c as TextContent).text.includes(FAT_PAYLOAD_SENTINEL),
		);
		if (!hasFatPayload) {
			// Not our fat payload — pass through unchanged.
			return undefined;
		}
		// Return shrunk content to replace the fat payload.
		return { content: SHRUNK_CONTENT };
	};

	pi.on("tool_result", handler);
	_captured.toolResultHandler = handler;
}
