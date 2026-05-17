/**
 * Spike R3 — bash → custom-tool routing for `tool_result` triggers.
 *
 * FORGE-S15-T06 — Confirms architectural-review.md risk R3:
 * a `pi.on("tool_result")` handler keyed on `event.toolName === "forge_collate"`
 * fires when the agent calls the registered custom tool, and does NOT fire when
 * the agent runs an equivalent bash command.
 *
 * The spike registers a stub `forge_collate` custom tool whose return text
 * contains the literal `--purge-events`, attaches a single `tool_result`
 * handler that observes ALL tool results, and queues a follow-up user message
 * (`/forge:enhance --phase 2`) only on the gated path.
 *
 * NOTE: This is spike-only code. Production wiring of post-X triggers happens
 * in Stage 2 once the architectural test passes.
 */

import type { ExtensionAPI, TextContent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Evidence record — populated by event listeners
// ---------------------------------------------------------------------------

export interface SpikeR3Observation {
	toolName: string;
	isError: boolean;
	textPreview: string;
}

export interface SpikeR3Evidence {
	observed: SpikeR3Observation[];
	triggerFiredFor: string[];
	followUpQueued: number;
	queuedMessages: string[];
	/** Captured user prompt observed via `before_agent_start` (best-effort). */
	beforeAgentStartPrompts: string[];
}

let evidence: SpikeR3Evidence = freshEvidence();

function freshEvidence(): SpikeR3Evidence {
	return {
		observed: [],
		triggerFiredFor: [],
		followUpQueued: 0,
		queuedMessages: [],
		beforeAgentStartPrompts: [],
	};
}

export function getEvidence(): SpikeR3Evidence {
	return evidence;
}

export function resetEvidence(): void {
	evidence = freshEvidence();
}

// ---------------------------------------------------------------------------
// Registration entry point — invoked as a DefaultResourceLoader factory
// ---------------------------------------------------------------------------

export function registerSpikeR3(pi: ExtensionAPI): void {
	// 1) Stub forge_collate custom tool: returns canned text containing --purge-events.
	pi.registerTool({
		name: "forge_collate",
		label: "forge_collate (R3 stub)",
		description:
			"Stub for FORGE-S15-T06 spike R3. Regenerates KB documents from the store. Returns canned text containing --purge-events.",
		promptSnippet: "Use forge_collate to regenerate KB documents from the store.",
		promptGuidelines: "Call forge_collate when the user asks to collate or refresh the knowledge base.",
		parameters: Type.Object({
			purgeEvents: Type.Optional(Type.Boolean({ description: "Whether to purge events after collation." })),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return {
				content: [
					{
						type: "text" as const,
						text: "[stub forge_collate] regenerated KB; flags=--purge-events",
					},
				],
				details: { purgeEvents: true },
			};
		},
	});

	// 2) Single tool_result handler that observes EVERY tool result.
	//    This is the AC4 negative-test mechanism: handler runs for `bash` too.
	pi.on("tool_result", async (event, _ctx) => {
		const text = event.content.find((c): c is TextContent => c.type === "text")?.text ?? "";
		evidence.observed.push({
			toolName: event.toolName,
			isError: event.isError,
			textPreview: text.slice(0, 120),
		});

		// Gating filter: only the custom-tool path qualifies.
		if (event.toolName !== "forge_collate") return;
		if (!text.includes("--purge-events")) return;

		evidence.triggerFiredFor.push(event.toolName);
		const followUp = "/forge:enhance --phase 2";
		evidence.queuedMessages.push(followUp);
		evidence.followUpQueued++;

		// pi.sendUserMessage is the EXTENSION RUNTIME surface, valid in event ctx.
		// (SPIKE-LESSONS §6 + §9; types.ts:1180-1187.)
		await pi.sendUserMessage(followUp, { deliverAs: "followUp" });
	});

	// 3) Optional capture: observe `before_agent_start` to confirm the queued
	//    follow-up was actually delivered as a user-role prompt on the next turn.
	pi.on("before_agent_start", (event, _ctx) => {
		evidence.beforeAgentStartPrompts.push(event.prompt);
	});
}
