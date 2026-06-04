// Transcript-fixture integration test for Mechanism A curation — FORGE-S30-T04.
// Runs the governor against test/fixtures/mechanism-a/transcript.json and asserts:
//   1. Resident-token reduction ≥ 30% vs uncurated total
//   2. Zero loss of preserved fields (byte-identical)
//   3. Dedup pointer appears for repeated read
//   4. Span-clamp marker appears for long bash output
//
// Auth-free — no LLM calls. Static JSON fixture only.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createGovernor, loadDefaultPolicyTable } from "../../../src/extensions/forgecli/context-governor.js";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface TranscriptTurn {
	turn: number;
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: string | Record<string, unknown>;
}

interface Transcript {
	description: string;
	phaseKey: string;
	turns: TranscriptTurn[];
}

function loadFixture(): Transcript {
	const fixturePath = path.resolve(
		import.meta.dirname,
		"../../fixtures/mechanism-a/transcript.json",
	);
	const raw = readFileSync(fixturePath, "utf8");
	return JSON.parse(raw) as Transcript;
}

function turnToToolResultEvent(turn: TranscriptTurn): ToolResultEvent {
	const contentText =
		typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content);
	return {
		type: "tool_result",
		toolName: turn.toolName,
		toolCallId: turn.toolCallId,
		content: [{ type: "text", text: contentText }],
		input: turn.input,
		isError: false,
	} as unknown as ToolResultEvent;
}

function makeCtxForPhase(phaseKey: string): ExtensionContext {
	const [persona, phase] = phaseKey.split("/");
	const fakeRegistry: ModelRegistry = {
		find: () => undefined,
	} as unknown as ModelRegistry;
	return {
		model: undefined,
		modelRegistry: fakeRegistry,
		persona,
		phase,
	} as unknown as ExtensionContext;
}

function getTextContent(event: ToolResultEvent): string {
	return event.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe("Mechanism A transcript integration", () => {
	it("curates transcript fixture: ≥30% token reduction, zero preserved-field loss, dedup pointer, span-clamp marker", () => {
		const fixture = loadFixture();
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtxForPhase(fixture.phaseKey);

		// Compute uncurated total (sum of raw content sizes)
		const uncuratedTotal = fixture.turns.reduce((sum, turn) => {
			const raw =
				typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content);
			return sum + raw.length;
		}, 0);

		let curatedTotal = 0;
		let dedupPointerFound = false;
		let spanClampFound = false;
		let preservedFieldLoss = false;

		for (const turn of fixture.turns) {
			const event = turnToToolResultEvent(turn);
			const rawText = getTextContent(event);
			const result = gov.applyToolResult(event, ctx);

			let effectiveText: string;
			if (result !== undefined && result.content !== undefined && result.content.length > 0) {
				effectiveText = (result.content[0] as { type: string; text: string }).text;
			} else {
				effectiveText = rawText;
			}
			curatedTotal += effectiveText.length;

			// Check for dedup pointer (repeated read)
			if (effectiveText.match(/\[unchanged since turn \d+ — call again to re-fetch\]/)) {
				dedupPointerFound = true;
			}

			// Check for span-clamp marker
			if (effectiveText.match(/\[\d+ lines elided\]/)) {
				spanClampFound = true;
			}

			// Check preserved-field byte-identity for forge_store results
			if (turn.toolName === "forge_store" && result !== undefined && result.content !== undefined) {
				// Parse original and curated
				let originalParsed: Record<string, unknown>;
				let curatedParsed: Record<string, unknown>;
				try {
					originalParsed = JSON.parse(rawText) as Record<string, unknown>;
					curatedParsed = JSON.parse(effectiveText) as Record<string, unknown>;
				} catch {
					// If parse fails, skip field check
					continue;
				}
				// architect/plan residentFields: ["status", "title", "dependencies", "description"]
				const residentFields = ["status", "title", "dependencies", "description"];
				const identityFields = ["taskId", "sprintId"];
				for (const field of [...residentFields, ...identityFields]) {
					if (field in originalParsed) {
						if (!(field in curatedParsed)) {
							preservedFieldLoss = true;
						} else if (
							JSON.stringify(originalParsed[field]) !== JSON.stringify(curatedParsed[field])
						) {
							preservedFieldLoss = true;
						}
					}
				}
			}
		}

		// Assertion 1: ≥30% token reduction
		const reductionPct = (uncuratedTotal - curatedTotal) / uncuratedTotal;
		expect(reductionPct).toBeGreaterThanOrEqual(0.30);

		// Assertion 2: Zero preserved-field loss
		expect(preservedFieldLoss).toBe(false);

		// Assertion 3: Dedup pointer appeared for repeated read
		expect(dedupPointerFound).toBe(true);

		// Assertion 4: Span-clamp marker appeared for long bash output
		expect(spanClampFound).toBe(true);
	});
});
