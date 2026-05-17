/**
 * Spike R5 — BeforeAgentStartEventResult field semantics.
 *
 * FORGE-S15-T08 — Discharges architectural-review.md §R5 by exercising the two
 * `BeforeAgentStartEventResult` variants independently:
 *
 *   Handler A (`systemPrompt` field) — returns a replacement system prompt with
 *   an appended marker. Assertion mechanism: `agent_start` handler captures
 *   `ctx.getSystemPrompt()` into evidence.
 *
 *   Handler B (`message` field) — injects a custom message into the transcript.
 *   Assertion mechanism: `agent_end` handler captures `event.messages` filtered
 *   to `role === "custom"` entries into evidence.
 *
 * No production code touched. Confirmed field names and semantics recorded in
 * RESULT.md; forge-cli Stage 3 KB-context-injection will standardise on
 * `systemPrompt` (see RESULT.md §Recommended choice).
 */

import type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Local structural alias for the custom-message entries captured from
// AgentEndEvent.messages. `CustomMessage` is NOT re-exported from the main
// index of @earendil-works/pi-coding-agent (exports map only exposes "." and
// "./hooks"). We define the structural subset we actually inspect so we stay
// within the public surface.
//
// Note: TextContent / ImageContent are also not re-exported from the main
// index, so we use a minimal structural content-item shape here.
// ---------------------------------------------------------------------------

export interface ContentItem {
	type: string;
	text?: string;
	[k: string]: unknown;
}

export interface CapturedCustomMessage {
	role: "custom";
	customType: string;
	content: string | ContentItem[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

// ---------------------------------------------------------------------------
// Evidence record — populated by handler invocations
// ---------------------------------------------------------------------------

export interface SpikeR5Evidence {
	/** Captured by `agent_start` ctx.getSystemPrompt() on each handler-A turn. */
	handlerASystemPrompts: string[];
	/** Captured by `agent_end` event.messages filtered to role === "custom". */
	handlerBMessages: CapturedCustomMessage[];
}

let evidence: SpikeR5Evidence = freshEvidence();

function freshEvidence(): SpikeR5Evidence {
	return {
		handlerASystemPrompts: [],
		handlerBMessages: [],
	};
}

export function getEvidence(): SpikeR5Evidence {
	return evidence;
}

export function resetEvidence(): void {
	evidence = freshEvidence();
}

// ---------------------------------------------------------------------------
// Handler type aliases — so tests can pull handlers back out of captured.
// ---------------------------------------------------------------------------

export type BeforeAgentStartHandler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined> | BeforeAgentStartEventResult | undefined;

export type AgentStartHandler = (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void> | void;

export type AgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Capture mechanism — records what the spike registers so tests can pull
// the handlers back out without booting a real pi runtime.
// ---------------------------------------------------------------------------

export interface SpikeR5Captured {
	beforeAgentStartHandlerA?: BeforeAgentStartHandler;
	agentStartHandlerA?: AgentStartHandler;
	beforeAgentStartHandlerB?: BeforeAgentStartHandler;
	agentEndHandlerB?: AgentEndHandler;
}

const captured: SpikeR5Captured = {};

export function getCaptured(): SpikeR5Captured {
	return captured;
}

// ---------------------------------------------------------------------------
// Type guard for custom-message narrowing (AgentMessage union).
// Using a typed predicate so tsc --strict narrows naturally.
// Pattern mirrors T06 TextContent narrowing (SPIKE-LESSONS §T06).
// ---------------------------------------------------------------------------

function isCustomMessage(m: unknown): m is CapturedCustomMessage {
	return (m as { role?: string }).role === "custom";
}

// ---------------------------------------------------------------------------
// Registration entry point A — systemPrompt variant.
//
// Appends TEST_SP_MARKER:R5A to the existing system prompt so the base context
// is preserved and the marker is detectable as a suffix.
// Assertion path: agent_start handler captures ctx.getSystemPrompt().
// ---------------------------------------------------------------------------

export function registerSpikeR5A(pi: ExtensionAPI, _opts?: { cwd?: string }): void {
	const beforeHandler: BeforeAgentStartHandler = (event) => {
		const result: BeforeAgentStartEventResult = {
			systemPrompt: `${event.systemPrompt}\nTEST_SP_MARKER:R5A`,
		};
		return result;
	};
	pi.on("before_agent_start", beforeHandler);
	captured.beforeAgentStartHandlerA = beforeHandler;

	const agentStartHandler: AgentStartHandler = (_event, ctx) => {
		// ctx.getSystemPrompt() returns the effective system prompt AFTER
		// before_agent_start handlers have applied their results.
		// Defined on ExtensionContext at types.d.ts:235 and on the handler ctx
		// at types.d.ts:1103.
		const sp = ctx.getSystemPrompt();
		evidence.handlerASystemPrompts.push(sp);
	};
	pi.on("agent_start", agentStartHandler);
	captured.agentStartHandlerA = agentStartHandler;
}

// ---------------------------------------------------------------------------
// Registration entry point B — message variant.
//
// Injects a CustomMessage with customType "forge.kb_context" into the transcript.
// Assertion path: agent_end handler captures event.messages filtered to
// role === "custom" entries.
// ---------------------------------------------------------------------------

export function registerSpikeR5B(pi: ExtensionAPI, _opts?: { cwd?: string }): void {
	const beforeHandler: BeforeAgentStartHandler = (_event) => {
		const result: BeforeAgentStartEventResult = {
			message: {
				customType: "forge.kb_context",
				content: [{ type: "text", text: "TEST_MSG_MARKER:R5B" }],
				display: true,
				details: { kb: "engineering" },
			},
		};
		return result;
	};
	pi.on("before_agent_start", beforeHandler);
	captured.beforeAgentStartHandlerB = beforeHandler;

	const agentEndHandler: AgentEndHandler = (event) => {
		for (const msg of event.messages) {
			if (isCustomMessage(msg)) {
				evidence.handlerBMessages.push(msg);
			}
		}
	};
	pi.on("agent_end", agentEndHandler);
	captured.agentEndHandlerB = agentEndHandler;
}
