// ask-user-render.ts — shared interactive-prompt renderer.
//
// Extracted from ask-user-tool.ts so that BOTH paths use one code path:
//   1. the orchestrator-direct path (forge_ask_user executes in a session that
//      owns the TUI, ctx.hasUI === true), and
//   2. the broker path (forge_ask_user executes in a subagent session with
//      ctx.hasUI === false; ask-broker.ts marshals the request to the
//      orchestrator's bound UI and calls this same renderer).
//
// Keeping this in its own module avoids a circular import between
// ask-user-tool.ts and ask-broker.ts (both import from here).
//
// Iron Law 6: no shell-string interpolation, no subprocess spawning.
// Iron Law 7: cancellation is surfaced as a structured failure, never a silent
// default.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { getInputRouter } from "./tui/input-router.js";

// ── Types ───────────────────────────────────────────────────────────────────

type AskUserType = "confirm" | "choice" | "text";

export interface AskUserRequest {
	question: string;
	type: AskUserType;
	options?: string[];
	default?: string;
}

/**
 * Result of rendering a prompt. `ok: true` carries the user's answer as a
 * string; `ok: false` carries a human-readable failure message (invalid
 * request, user cancellation, or pre-aborted signal). The caller maps this to
 * the tool-result shape (okResult / errResult).
 */
export type AskRender = { ok: true; value: string } | { ok: false; message: string };

/** The slice of ExtensionUIContext the renderer needs. Keeps test stubs small. */
export type AskUI = Pick<ExtensionUIContext, "confirm" | "select" | "input" | "notify">;

// ── Renderer ──────────────────────────────────────────────────────────────────

function cancelled(question: string): AskRender {
	return { ok: false, message: `forge:ask_user cancelled — user dismissed the prompt. question: "${question}"` };
}

/**
 * Render an interactive prompt against the supplied UI context and return the
 * user's answer. The UI MUST be a live, TUI-bound context (the orchestrator's
 * own ctx.ui, whether reached directly or via the broker) — never a subagent's
 * no-op UI.
 *
 * Marks the input-router overlay active for the duration so the arrow-key
 * activators (thread-switcher ←→, whats-new ↓) are suppressed while pi's
 * built-in dialog owns keyboard focus, then restores on every exit path.
 */
export async function renderAskPrompt(ui: AskUI, params: AskUserRequest, signal?: AbortSignal): Promise<AskRender> {
	if (signal?.aborted) {
		return { ok: false, message: `forge:ask_user aborted before prompt — question: "${params.question}"` };
	}

	const opts = signal !== undefined ? { signal } : {};

	// Render the question as the dialog TITLE for every type; emit the source
	// tag as a separate notification so users see provenance without losing the
	// question text (see ask-user-tool.ts history for why title must be the
	// question, not a constant tag).
	ui.notify(`forge:ask_user — ${params.question}`, "info");

	const router = getInputRouter();
	router.pushOverlay();
	try {
		if (params.type === "confirm") {
			const answer = await ui.confirm(params.question, "", opts);
			if (answer === undefined) return cancelled(params.question);
			return { ok: true, value: answer ? "Y" : "N" };
		}

		if (params.type === "choice") {
			if (!params.options || params.options.length === 0) {
				return { ok: false, message: "forge:ask_user error — type 'choice' requires a non-empty 'options' array." };
			}
			const answer = await ui.select(params.question, params.options, opts);
			if (answer === undefined) return cancelled(params.question);
			return { ok: true, value: answer };
		}

		// type === "text"
		const answer = await ui.input(params.question, params.default ?? "", opts);
		if (answer === undefined) return cancelled(params.question);
		return { ok: true, value: answer };
	} finally {
		router.popOverlay();
	}
}
