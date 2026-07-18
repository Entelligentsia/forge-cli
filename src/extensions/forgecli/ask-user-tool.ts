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

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { AskBroker } from "./ask-broker.js";
import { renderAskPrompt } from "./ask-user-render.js";
import { FORGE_ASK_USER_DESCRIPTION } from "./tool-contracts.js";

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
	required: Type.Optional(
		Type.Boolean({
			description:
				"HARD gate: require a genuine human answer. When true and no interactive UI or " +
				"orchestrator broker is available (non-interactive / headless), the tool ERRORS " +
				"instead of returning the default — it never silently ratifies. Read result.details " +
				"(source/answered) to confirm provenance before recording consent.",
		}),
	),
});

// ── Provenance (#114) ─────────────────────────────────────────────────────────

/**
 * Where the returned answer actually came from. Only `source: "user"` (with
 * `answered: true`) represents a genuine human decision; every other source is
 * a fallback that no human confirmed. Carried in the tool result's `details`
 * so a caller can refuse to treat a default-echo as consent.
 */
export type AskUserSource = "user" | "non-interactive" | "default" | "unsupported";

export interface AskUserProvenance {
	source: AskUserSource;
	/** True iff a human genuinely answered (source === "user" and not cancelled). */
	answered: boolean;
	/** The resolved value (the answer, or the fallback that was substituted). */
	value: string;
}

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

/**
 * A concise, transcript-visible provenance line appended to the tool result
 * content (#114 Slice 5). This is the ONE channel both the calling subagent LLM
 * and a transcript-scanning safety classifier actually read — `details` is not
 * surfaced to either. It makes a default-echo self-evidently NOT consent, and
 * gives a genuine answer explicit "a human answered" evidence in the transcript.
 */
function provenanceNote(p: AskUserProvenance): string {
	if (p.source === "user") {
		return p.answered
			? "[forge:ask_user provenance] source=user answered=true — a human answered this prompt."
			: "[forge:ask_user provenance] source=user answered=false — a human was shown this prompt but " +
					"dismissed it without answering. Treat as declined; do NOT record as consent.";
	}
	return (
		`[forge:ask_user provenance] source=${p.source} answered=false — NO human answered; this value is an ` +
		"automatic default. Do NOT record it as user consent, approval, or ratification."
	);
}

function okResult(text: string, provenance: AskUserProvenance) {
	return {
		content: [
			{ type: "text" as const, text: text || "" },
			{ type: "text" as const, text: provenanceNote(provenance) },
		],
		details: provenance as unknown,
	};
}

function errResult(text: string, provenance?: AskUserProvenance) {
	const content = [{ type: "text" as const, text }];
	if (provenance) content.push({ type: "text" as const, text: provenanceNote(provenance) });
	return {
		content,
		details: (provenance ?? {}) as unknown,
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
export const askUserToolDefinition: ToolDefinition = {
	name: "forge_ask_user",
	label: "Forge Ask User",
	description: FORGE_ASK_USER_DESCRIPTION,
	promptSnippet:
		"Use forge_ask_user when a Forge workflow needs synchronous user input — confirm (Y/N), choice from a list, or free-form text.",
	parameters: AskUserParams,
	async execute(
		_toolCallId: string,
		params: {
			type: "confirm" | "choice" | "text";
			question: string;
			options?: string[];
			default?: string;
			required?: boolean;
		},
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	) {
		// Non-interactive bypass: env flag forces the default everywhere
		// (CI, `forge --non-interactive`), even when a broker is bound.
		if (isNonInteractive()) {
			const fallback = computeFallback(params);
			// Emit a one-line audit entry to stderr (not a file) so CI logs capture it.
			process.stderr.write(
				`[forge:ask_user] non-interactive fallback — type=${params.type} question="${params.question}" default="${fallback}"\n`,
			);
			// HARD gate (#114): a non-interactive default is not a human answer.
			// Refuse rather than let a caller record fabricated ratification.
			if (params.required) {
				return errResult(
					`forge:ask_user required=true but running non-interactive (FORGE_YES / FORGE_NON_INTERACTIVE) — ` +
						`no human answer available; refusing to substitute the default. question="${params.question}"`,
					{ source: "non-interactive", answered: false, value: fallback },
				);
			}
			return okResult(fallback, { source: "non-interactive", answered: false, value: fallback });
		}

		// Path 1 — this session owns the TUI (orchestrator / interactive mode,
		// ctx.hasUI === true): render directly on ctx.ui. Genuine human answer.
		if (ctx.hasUI) {
			const r = await renderAskPrompt(ctx.ui, params, signal);
			return r.ok
				? okResult(r.value, { source: "user", answered: true, value: r.value })
				: errResult(r.message, { source: "user", answered: false, value: "" });
		}

		// Path 2 — subagent session (ctx.hasUI === false, ctx.ui is a no-op)
		// running under an orchestrator that bound its UI via AskBroker.withUI:
		// marshal the request to the orchestrator's real TUI and wait. Serialised
		// against other in-flight asks so concurrent fan-out agents queue. Genuine
		// human answer, same provenance as Path 1.
		if (AskBroker.isBound()) {
			const r = await AskBroker.ask(params, signal);
			return r.ok
				? okResult(r.value, { source: "user", answered: true, value: r.value })
				: errResult(r.message, { source: "user", answered: false, value: "" });
		}

		// Path 3 — truly headless (RPC / print mode, no broker bound): there is
		// no human to ask. Fall back to the default (preserves prior behaviour),
		// unless this is a HARD gate — then refuse (#114).
		const fallback = computeFallback(params);
		process.stderr.write(
			`[forge:ask_user] headless fallback (no UI, no broker) — type=${params.type} question="${params.question}" default="${fallback}"\n`,
		);
		if (params.required) {
			return errResult(
				`forge:ask_user required=true but no interactive UI or orchestrator broker is bound — ` +
					`no human answer available; refusing to substitute the default. question="${params.question}"`,
				{ source: "default", answered: false, value: fallback },
			);
		}
		return okResult(fallback, { source: "default", answered: false, value: fallback });
	},
};

/**
 * Register the forge_ask_user tool on the pi ExtensionAPI (host session).
 */
export function registerAskUserTool(pi: ExtensionAPI): void {
	pi.registerTool(askUserToolDefinition);
}
