// audience-gate.ts — Shared helper called by every kickoff handler
// before sendKickoff (Pack-06 invariant; FORGE-S21-T01 AC#2, AC#3).
//
// Cross-pack invariant: EVERY kickoff handler calls this helper.
// Smoke gate grep (E2E-15 audience-gate-coverage) asserts the invariant holds.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL7 — every refusal path emits ctx.ui.notify and returns; no silent
//         continuation past a gate failure.
//   No ctx.ui.confirm/select/input — kickoff handlers must not use those.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AudienceValue } from "./loaders/workflow-loader.js";
import { CallerContextStore } from "./subagent/caller-context.js";
import type { CallerContext } from "./subagent/caller-context.js";

export type { CallerContext } from "./subagent/caller-context.js";
export { CallerContextStore } from "./subagent/caller-context.js";

export interface AudienceCheckInput {
	workflowName: string;
	audience: AudienceValue;
	/** Defaults to `CallerContextStore.get()` when absent. */
	callerContext?: CallerContext;
}

/**
 * Assert that the given workflow's audience is compatible with the
 * current (or provided) caller context.
 *
 * Returns `true` if dispatch may proceed.
 * Returns `false` and emits `ctx.ui.notify("error")` if the workflow
 * is incompatible with the caller context.
 *
 * Callers MUST check the return value and return WITHOUT calling
 * `sendKickoff` when `false` is returned.
 *
 * Refusal message for orchestrator-only violations (AC#3 verbatim):
 *   "× workflow <name> is orchestrator-only; cannot run from subagent context"
 *
 * Note: `subagent` audience is advisory only — users may invoke any
 * `subagent`-audience workflow manually from the orchestrator (CLI) context.
 * Only `orchestrator-only` produces refusals.
 */
export function assertAudience(input: AudienceCheckInput, ctx: ExtensionCommandContext): boolean {
	const { workflowName, audience } = input;
	const callerContext = input.callerContext ?? CallerContextStore.get();

	// "any" (or missing audience) — always allowed.
	if (audience === "any") return true;

	// "orchestrator-only" — allowed only from orchestrator context.
	if (audience === "orchestrator-only" && callerContext === "subagent") {
		ctx.ui.notify(
			`× workflow ${workflowName} is orchestrator-only; cannot run from subagent context — forge-cli internal error if you did not run it as a subagent`,
			"error",
		);
		return false;
	}

	// "subagent" — advisory hint, allowed from any caller.
	// Users must be able to run every step manually (orchestrators are auto-mode);
	// this audience is preserved in workflow front-matter for documentation but
	// no longer enforced against orchestrator callers.
	return true;
}
