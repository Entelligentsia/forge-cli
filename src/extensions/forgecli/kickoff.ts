// kickoff.ts — shared helper for kickoff-shim slash-command handlers.
//
// Single source of truth for the `deliverAs: "steer"` invariant required by
// Pack-06 + BUG-017/BUG-023. Raw `pi.sendUserMessage(text)` from inside a
// command handler throws "Agent is already processing"; every kickoff shim
// MUST go through this helper.
//
// FORGE-S20-T04 introduces this helper; FORGE-S20-T05 and FORGE-S20-T06
// reuse it for `/forge:plan` and `/forge:implement` ports. S19's
// `sprint-intake.ts` and `sprint-plan.ts` predate this helper and currently
// call `pi.sendUserMessage` without `deliverAs` — retrofitting them is
// follow-up work, tracked outside T04.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Send a kickoff message into the agent loop with `deliverAs: "steer"`.
 *
 * Callers MUST NEVER raw-call `pi.sendUserMessage` from inside a command
 * handler. The `deliverAs: "steer"` option is required because the handler
 * is itself a turn — without it pi rejects the message as "Agent is already
 * processing" (BUG-017 / BUG-023).
 *
 * Kickoff text MUST be LLM workflow prose, never a slash-command string:
 * pi's `sendUserMessage` routes through `prompt(text, {
 * expandPromptTemplates: false })`, which skips extension-command dispatch
 * entirely — a steered "/forge:..." string lands as literal prose the model
 * cannot execute (pi also forbids queueing extension commands:
 * steer()/followUp() throw "cannot be queued"). To trigger another command's
 * behaviour, call its exported run* function in-process instead (e.g.
 * `runEnhance`).
 */
export function sendKickoff(pi: ExtensionAPI, text: string): void {
	if (/^\/\S/.test(text)) {
		throw new Error(
			`sendKickoff received a slash-command string (${JSON.stringify(text.split("\n", 1)[0])}). ` +
				"pi.sendUserMessage bypasses extension-command dispatch, so the command handler " +
				"would never run — the text would land as literal prose. Call the command's " +
				"exported run* function in-process instead, and reserve sendKickoff for workflow prose.",
		);
	}
	pi.sendUserMessage(text, { deliverAs: "steer" });
}
