/**
 * Spike R-CG2 — prompt-cache safety under mid-stream curation.
 *
 * FORGE-S30-T02 — Proves that mutating `tool_result` content via the
 * `tool_result` extension handler does NOT invalidate the Anthropic
 * prompt-cache prefix from prior turns.
 *
 * This spike verifies:
 *   1. The `cache_control: { type: "ephemeral" }` breakpoint is placed ONLY
 *      on the last user message block at request-build time (lines 1154-1175
 *      in packages/ai/src/providers/anthropic.ts). Prior tool_result messages
 *      do NOT carry cache_control.
 *   2. Mutating a tool_result's content (Mechanism A pattern) does not change
 *      which blocks carry cache_control, because cache_control is placed after
 *      message serialization — on whatever the current last user message is.
 *   3. A before_provider_request handler receives the fully serialized payload
 *      including cache_control annotations, confirming the interception point.
 *
 * Safe curation bound established:
 *   All tool_result curation is unconditionally safe with respect to
 *   prompt-cache prefix reuse, provided mutation occurs in the tool_result
 *   handler before the message is committed to context.messages (R-CG1).
 *   No "post-breakpoint only" restriction applies.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Cache-control placement logic (extracted from anthropic.ts:1154-1175)
// ---------------------------------------------------------------------------
//
// The Anthropic provider places cache_control on the last block of the last
// user message. This is the exact logic from buildParams in anthropic.ts.
// We replicate it here for unit testing without importing private internals.

export interface AnthropicContentBlock {
	type: string;
	text?: string;
	cache_control?: { type: string };
	[key: string]: unknown;
}

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContentBlock[] | string;
}

export const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Apply cache_control to the last block of the last user message —
 * replicating the logic from anthropic.ts:buildParams lines 1154-1175.
 *
 * Returns a new messages array (deep-cloned); does not mutate the input.
 */
export function applyCacheControlToLastUserMessage(
	messages: AnthropicMessage[],
): AnthropicMessage[] {
	// Deep-clone to avoid mutating the input.
	const params: AnthropicMessage[] = JSON.parse(JSON.stringify(messages));

	if (params.length === 0) return params;

	const lastMessage = params[params.length - 1];
	if (lastMessage.role !== "user") return params;

	if (Array.isArray(lastMessage.content)) {
		const lastBlock = lastMessage.content[lastMessage.content.length - 1];
		if (
			lastBlock &&
			(lastBlock.type === "text" ||
				lastBlock.type === "image" ||
				lastBlock.type === "tool_result")
		) {
			(lastBlock as AnthropicContentBlock).cache_control = CACHE_CONTROL_EPHEMERAL;
		}
	} else if (typeof lastMessage.content === "string") {
		lastMessage.content = [
			{
				type: "text",
				text: lastMessage.content,
				cache_control: CACHE_CONTROL_EPHEMERAL,
			},
		];
	}

	return params;
}

/**
 * Collect all content blocks across all messages that carry cache_control.
 * Returns array of { messageIndex, blockIndex, block }.
 */
export function collectBlocksWithCacheControl(
	messages: AnthropicMessage[],
): Array<{ messageIndex: number; blockIndex: number; block: AnthropicContentBlock }> {
	const result: Array<{ messageIndex: number; blockIndex: number; block: AnthropicContentBlock }> =
		[];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (Array.isArray(msg.content)) {
			for (let j = 0; j < msg.content.length; j++) {
				if (msg.content[j].cache_control !== undefined) {
					result.push({ messageIndex: i, blockIndex: j, block: msg.content[j] });
				}
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Simulated multi-turn message builder
// ---------------------------------------------------------------------------
//
// Builds a simulated Anthropic wire-format message array for a 2-turn session:
//   Turn 1: user prompt → assistant toolCall → user toolResult
//   Turn 2: user prompt (with cache_control breakpoint added by buildParams)
//
// The "fat" vs "curated" variants differ only in the tool_result content.

export const FAT_TOOL_RESULT_TEXT =
	"FAT_TOOL_OUTPUT_LINE_0: store row data\n".repeat(50).trim();

export const CURATED_TOOL_RESULT_TEXT = "store row data (summarized, 3 rows)";

/**
 * Build a simulated 2-turn Anthropic message array (turn 2 perspective).
 * This is what buildParams/convertMessages would produce on turn 2 —
 * i.e., the full conversation history including the turn-1 toolResult.
 */
export function buildSimulatedTurn2Messages(opts: {
	toolResultContent: string;
	turn2UserPrompt: string;
}): AnthropicMessage[] {
	return [
		// Turn 1: user prompt
		{
			role: "user",
			content: [{ type: "text", text: "Run the tool and summarize." }],
		},
		// Turn 1: assistant toolCall (collapsed into assistant message)
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tool-call-1",
					name: "mock_store_tool",
					input: {},
				},
			],
		},
		// Turn 1: user toolResult (this is the message that Mechanism A may mutate)
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tool-call-1",
					content: [{ type: "text", text: opts.toolResultContent }],
				},
			],
		},
		// Turn 2: new user prompt (this will receive cache_control from buildParams)
		{
			role: "user",
			content: [{ type: "text", text: opts.turn2UserPrompt }],
		},
	];
}

// ---------------------------------------------------------------------------
// before_provider_request evidence capture
// ---------------------------------------------------------------------------
//
// The SpikeCG2Evidence captures payloads received by the before_provider_request
// extension hook during a session run. This demonstrates that:
//   a) The hook fires with the fully serialized Anthropic wire-format payload.
//   b) cache_control blocks are present in the payload (on the last user message).
//   c) Prior tool_result messages do NOT carry cache_control.

export interface CapturedPayload {
	turn: number;
	/** Snapshot of the messages array from the serialized Anthropic payload. */
	messages: AnthropicMessage[];
	/** Number of blocks across all messages that carry cache_control. */
	cacheControlBlockCount: number;
}

export interface SpikeCG2Evidence {
	capturedPayloads: CapturedPayload[];
	handlerFireCount: number;
}

let _evidence: SpikeCG2Evidence = freshEvidence();

function freshEvidence(): SpikeCG2Evidence {
	return { capturedPayloads: [], handlerFireCount: 0 };
}

export function getEvidence(): SpikeCG2Evidence {
	return _evidence;
}

export function resetEvidence(): void {
	_evidence = freshEvidence();
}

/**
 * Register the R-CG2 spike extension.
 *
 * Registers a before_provider_request handler that captures the payload
 * for post-session analysis. Returns the payload unmodified (pass-through).
 *
 * @param pi  The ExtensionAPI instance.
 */
export function registerSpikeCG2(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		_evidence.handlerFireCount++;
		const payload = event.payload as {
			messages?: AnthropicMessage[];
			[k: string]: unknown;
		};
		const messages: AnthropicMessage[] = payload?.messages ?? [];
		const cacheControlBlockCount = collectBlocksWithCacheControl(messages).length;
		_evidence.capturedPayloads.push({
			turn: _evidence.capturedPayloads.length + 1,
			messages: JSON.parse(JSON.stringify(messages)),
			cacheControlBlockCount,
		});
		// Pass through — do not modify the payload.
		return event.payload;
	});
}
