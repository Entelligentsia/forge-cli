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

import type { ExtensionAPI } from "@entelligentsia/pi-coding-agent";

/**
 * Send a kickoff message into the agent loop with `deliverAs: "steer"`.
 *
 * Callers MUST NEVER raw-call `pi.sendUserMessage` from inside a command
 * handler. The `deliverAs: "steer"` option is required because the handler
 * is itself a turn — without it pi rejects the message as "Agent is already
 * processing" (BUG-017 / BUG-023).
 */
export function sendKickoff(pi: ExtensionAPI, text: string): void {
	pi.sendUserMessage(text, { deliverAs: "steer" });
}
