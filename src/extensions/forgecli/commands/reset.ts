// forge:reset — native kickoff handler (FEAT-009 component C).
//
// NLP-backed, guardrailed pipeline-state reset: interpret a free-text request
// ("put FORGE-S32-T07 back to review-code"), compute the plan + cross-entity
// integrity implications via the read-only reset-plan.cjs planner, present them,
// REQUIRE explicit confirmation, then apply only the proposed transitions
// through store-cli. Kickoff Shim archetype (Pack-04 + Pack-06): a single LLM
// handoff in the current context — the model drives the planner → confirm →
// apply flow; no isolated fork.
//
// Why a kickoff shim and not a native TS handler: the command is fundamentally
// NLP (free-text intent parsing, conversational confirmation, sprint cascades).
// The deterministic core already exists as tools the steered agent uses —
// reset-plan.cjs (planner) and store-cli (custodian gateway). The deterministic
// single-entity counterpart is the `4ge reset <id> --to <phase>` bin command
// (bin/reset.ts); this slash command adds the NLP + integrity-gate layer.
//
// Workflow source: <forgeRoot>/commands/reset.md (command file). File-existence
// check only — command files lack the Pack-06 4-marker workflow structure
// (mirrors add-task.ts).
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL4 — no JSON.stringify-into-subagent dispatch.
//   IL6 — no shell-string interpolation; no spawn calls here.
//   IL7 — every failure path emits ctx.ui.notify and returns; no silent
//         continuation.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { sendKickoff } from "../kickoff.js";

const COMMAND_NAME = "reset";

// ── Kickoff composition ───────────────────────────────────────────────────

export interface ComposeResetKickoffOpts {
	/** Body of commands/reset.md (frontmatter included; the LLM reads steps from it). */
	commandMd: string;
	/** Resolved Forge plugin root, so the LLM uses the right tool paths without
	 *  relying on the `!`-backtick command substitution the plugin route uses. */
	forgeRoot: string;
	/** Free-text reset request from the user (substituted for $ARGUMENTS). */
	request: string;
}

export function composeResetKickoff(opts: ComposeResetKickoffOpts): string {
	const { commandMd, forgeRoot, request } = opts;
	// Make the command body self-contained for the steered prompt: substitute the
	// $ARGUMENTS placeholder with the actual request so Step 1 has its input.
	const body = commandMd.split("$ARGUMENTS").join(request || "(no request text — ask the user what to reset)");

	const sections: string[] = ["# /forge:reset", ""];
	sections.push("## Dispatch", "");
	sections.push("Fulfil the guardrailed pipeline-state reset described in the command below. Specifically:");
	sections.push("");
	sections.push(`1. \`FORGE_ROOT\` is already resolved to: \`${forgeRoot}\` — use it for every \`$FORGE_ROOT/tools/...\` invocation. Do NOT re-resolve it from a \`!\`-backtick block.`);
	sections.push("2. Follow the command file steps in order.");
	sections.push("3. `reset-plan.cjs` is a READ-ONLY planner — run it first and base everything on its JSON. Never apply a transition it did not propose.");
	sections.push("4. Present the plan and EVERY integrity warning, then REQUIRE an explicit \"yes\" before applying. Use `forge_ask_user` for the confirmation gate; if the user hesitates, stop.");
	sections.push("5. Apply transitions ONLY through store-cli (the custodian gateway) — never by writing store files directly. Backward/terminal transitions need `FORGE_ALLOW_FORCE=1 … --force`.");
	sections.push(
		"6. forge-cli note: this slash command owns the **store side only**. After the store transition lands, the run-task/fix-bug resume-state cache is NOT rewound — tell the user to run `4ge reset <id> --to <phase>` (or delete `.forge/cache/*-state-<id>*.json`) before resuming, so store and cache stay in lockstep.",
	);

	sections.push("", "---", "", "## Command", "", body.trim(), "", "---");
	sections.push("", `## Request`, "", request.trim() || "(no request text — begin by asking the user what to reset and to which phase)");

	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

export interface RegisterResetOptions {
	forgeRoot: string | null;
	cwd?: string;
}

export function registerReset(pi: ExtensionAPI, options: RegisterResetOptions): void {
	pi.registerCommand("forge:reset", {
		description:
			"Rewind a halted/blocked task, bug, or sprint to an earlier pipeline phase — a guardrailed, " +
			"integrity-checked state reset. Usage: /forge:reset <natural-language request> " +
			'(e.g. "put FORGE-S32-T07 back to review-code").',
		async handler(args: string, ctx: ExtensionCommandContext) {
			const { forgeRoot } = options;

			if (!forgeRoot) {
				ctx.ui.notify("× forge:reset — no Forge project at cwd; run /forge:init to bootstrap", "warning");
				return;
			}

			const commandPath = path.join(forgeRoot, "commands", `${COMMAND_NAME}.md`);
			let commandMd: string;
			try {
				commandMd = fs.readFileSync(commandPath, "utf8");
			} catch (err: unknown) {
				const e = err as { code?: string; message?: string };
				if (e.code === "ENOENT") {
					ctx.ui.notify(
						`× forge:reset — command file not found at commands/${COMMAND_NAME}.md; run /forge:init or /forge:rebuild first.`,
						"error",
					);
				} else {
					ctx.ui.notify(`× forge:reset — failed to read command file: ${e.message ?? "unknown error"}`, "error");
				}
				return;
			}

			const request = (args ?? "").trim();
			const kickoff = composeResetKickoff({ commandMd, forgeRoot, request });
			sendKickoff(pi, kickoff);
		},
	});
}
