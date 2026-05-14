// forge:ask_user custom tool — FORGE-S18-T04
//
// Registers forge_ask_user via pi.registerTool. The tool accepts a question and
// an input type (confirm | choice | text), presents the appropriate TUI prompt
// via ctx.ui.confirm / ctx.ui.select / ctx.ui.input, and returns the user's
// answer as a string.
//
// Non-interactive bypass:
//   When FORGE_YES=1 or FORGE_NON_INTERACTIVE=1 (set by `forge --non-interactive`),
//   or when ctx.hasUI is false (headless / RPC mode), the tool returns the supplied
//   default without rendering any TUI. Fallback defaults when no explicit default:
//     confirm  → "Y"
//     choice   → options[0] (or "" if empty)
//     text     → ""
//
// Cancellation:
//   ctx.ui.* returns undefined when the user cancels. The tool surfaces this as
//   isError: true with a structured message — never silently defaults.
//
// Iron Law 6 compliance: no shell-string interpolation. No subprocess spawning.

import type { ExtensionAPI, ExtensionContext } from "@entelligentsia/pi-coding-agent";
import { Type } from "typebox";

// ── Schema ────────────────────────────────────────────────────────────────────

export const AskUserParams = Type.Object({
	question: Type.String({
		description: "The question or prompt to display to the user.",
	}),
	type: Type.Union([Type.Literal("confirm"), Type.Literal("choice"), Type.Literal("text")], {
		description:
			"Input modality: confirm (Y/N boolean), choice (select from list), or text (free-form single-line input).",
	}),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "Required when type === 'choice'. The list of options to present to the user.",
		}),
	),
	default: Type.Optional(
		Type.String({
			description:
				"Default value returned in non-interactive mode or when no default is needed. " +
				"If absent, the fallback is: confirm → 'Y', choice → options[0], text → ''.",
		}),
	),
});

// ── Non-interactive helper ────────────────────────────────────────────────────

/**
 * Returns true when running in non-interactive / CI mode.
 *
 * Inlined here (not imported from forge-init.ts) to keep the module boundary
 * clean and avoid any risk of circular imports.
 *
 * Activated by:
 *   - `FORGE_YES=1`             — ergonomic shell shorthand (FORGE-S18-T01)
 *   - `FORGE_NON_INTERACTIVE=1` — set by `forge --non-interactive` flag
 */
function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

// ── Result helpers ────────────────────────────────────────────────────────────

function okResult(text: string) {
	return {
		content: [{ type: "text" as const, text: text || "" }],
		details: {} as unknown,
	};
}

function errResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {} as unknown,
		isError: true as const,
	};
}

// ── Fallback computation ──────────────────────────────────────────────────────

/**
 * Compute the non-interactive fallback value.
 *
 * Priority: explicit `default` field → type-specific hardcoded fallback.
 */
function computeFallback(params: {
	type: "confirm" | "choice" | "text";
	options?: string[];
	default?: string;
}): string {
	if (params.default !== undefined) return params.default;
	if (params.type === "confirm") return "Y";
	if (params.type === "choice") return params.options?.[0] ?? "";
	return ""; // text
}

// ── Public registration ───────────────────────────────────────────────────────

/**
 * Register the forge_ask_user tool with the pi ExtensionAPI.
 *
 * The tool is named `forge_ask_user` (snake_case per pi convention); the
 * human/LLM-facing name `forge:ask_user` appears in description and promptSnippet.
 *
 * @param pi  The pi ExtensionAPI instance.
 */
export function registerAskUserTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "forge_ask_user",
		label: "Forge Ask User",
		description:
			"forge:ask_user — Present an interactive prompt to the user and return their answer. " +
			"Accepts three input types: 'confirm' (Y/N), 'choice' (select from a list), or 'text' " +
			"(free-form single-line input). Blocks the model loop until the user responds. " +
			"In non-interactive mode (FORGE_YES=1 or --non-interactive), returns the default immediately.",
		promptSnippet:
			"Use forge_ask_user when a Forge workflow needs synchronous user input — confirm (Y/N), choice from a list, or free-form text.",
		parameters: AskUserParams,
		async execute(
			_toolCallId: string,
			params: { type: "confirm" | "choice" | "text"; question: string; options?: string[]; default?: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			// Non-interactive bypass: applies when env flag is set OR when running
			// headless (ctx.hasUI=false, e.g. RPC mode / print mode).
			if (isNonInteractive() || !ctx.hasUI) {
				const fallback = computeFallback(params);
				// Emit a one-line audit entry to stderr (not a file) so CI logs capture it.
				process.stderr.write(
					`[forge:ask_user] non-interactive fallback — type=${params.type} question="${params.question}" default="${fallback}"\n`,
				);
				return okResult(fallback);
			}

			const opts = signal !== undefined ? { signal } : {};

			// Render the question as the dialog TITLE for every type. pi's UI
			// signatures (per `ExtensionUIContext`):
			//   select(title, options, opts)    — title shown above options
			//   confirm(title, message, opts)   — title + message body
			//   input(title, placeholder, opts) — title + ghost placeholder
			// Passing a constant tag ("forge:ask_user") as title hid the question
			// for input (where it landed in the placeholder slot — ghost text that
			// vanished on first keystroke) and for select (which has no question
			// slot at all). Always use `params.question` as title; the source-tag
			// notification is emitted separately so users see provenance without
			// losing the question text.
			ctx.ui.notify(`forge:ask_user — ${params.question}`, "info");

			if (params.type === "confirm") {
				// ctx.ui.confirm returns true/false or undefined (cancel).
				const answer = await ctx.ui.confirm(params.question, "", opts);
				if (answer === undefined) {
					return errResult(`forge:ask_user cancelled — user dismissed the prompt. question: "${params.question}"`);
				}
				return okResult(answer ? "Y" : "N");
			}

			if (params.type === "choice") {
				if (!params.options || params.options.length === 0) {
					return errResult("forge:ask_user error — type 'choice' requires a non-empty 'options' array.");
				}
				// ctx.ui.select returns the selected string or undefined (cancel).
				const answer = await ctx.ui.select(params.question, params.options, opts);
				if (answer === undefined) {
					return errResult(`forge:ask_user cancelled — user dismissed the prompt. question: "${params.question}"`);
				}
				return okResult(answer);
			}

			// type === "text"
			// ctx.ui.input returns the entered string or undefined (cancel/ESC).
			// Pass `default` (if any) as the placeholder ghost text so the user
			// sees a hint of the model's suggested answer.
			const answer = await ctx.ui.input(params.question, params.default ?? "", opts);
			if (answer === undefined) {
				return errResult(`forge:ask_user cancelled — user dismissed the prompt. question: "${params.question}"`);
			}
			return okResult(answer);
		},
	});
}
