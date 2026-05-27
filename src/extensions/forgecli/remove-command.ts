// forge:remove — native kickoff handler (FORGE-S23-T11).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// File is named remove-command.ts (not remove.ts) to avoid naming
// conflicts with Node.js built-in patterns (consistent with read-command.ts
// and status-command.ts in this directory).
//
// --apply flag bypasses the per-bucket LLM confirmation prompts by including
// the flag value in the kickoff body so the LLM skips interactive confirmation.
//
// Workflow source: <forgeRoot>/commands/remove.md (command file).
// File-existence check only — command files lack Pack-06 workflow markers.
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

import { sendKickoff } from "./kickoff.js";

// ── Argv parsing ──────────────────────────────────────────────────────────

export interface ParsedRemoveArgs {
	apply: boolean;
	seed: string;
	sourceLabel: string;
}

export function parseRemoveArgs(rawArgs: string, cwd: string): ParsedRemoveArgs {
	const trimmed = (rawArgs ?? "").trim();
	const result: ParsedRemoveArgs = {
		apply: false,
		seed: "",
		sourceLabel: "",
	};

	if (!trimmed) {
		result.sourceLabel = "(no args — interactive removal)";
		return result;
	}

	const tokens = trimmed.split(/\s+/);
	const remaining: string[] = [];
	for (const tok of tokens) {
		if (tok === "--apply") {
			result.apply = true;
		} else {
			remaining.push(tok);
		}
	}

	const tail = remaining.join(" ").trim();
	if (tail.startsWith("@")) {
		const ref = tail.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		result.seed = fs.readFileSync(filePath, "utf8");
		result.sourceLabel = `(seed from file: ${ref})`;
	} else if (tail) {
		result.seed = tail;
		result.sourceLabel = "(seed from inline text)";
	} else {
		result.sourceLabel = result.apply ? "(--apply provided)" : "(no args — interactive removal)";
	}

	return result;
}

// ── Kickoff composition ───────────────────────────────────────────────────

export interface ComposeRemoveKickoffOpts {
	commandMd: string;
	parsed: ParsedRemoveArgs;
}

export function composeRemoveKickoff(opts: ComposeRemoveKickoffOpts): string {
	const { commandMd, parsed } = opts;

	const sections: string[] = ["# /forge:remove", ""];
	sections.push("## Dispatch", "");
	sections.push("Run the remove command below to remove Forge artifacts from this project.");
	if (parsed.apply) {
		sections.push(
			"",
			"**`--apply` flag provided.** Proceed with removal of each bucket without asking for per-bucket confirmation. " +
				"Still show a final summary of what will be removed before executing, but do not prompt for each individual bucket.",
		);
	} else {
		sections.push("", "Interactive mode: ask for confirmation before removing each bucket (default behavior).");
	}

	sections.push("", "---", "", "## Command", "", commandMd.trim(), "", "---");

	if (parsed.seed) {
		sections.push("", `## Additional Input — ${parsed.sourceLabel}`, "", parsed.seed.trim());
	}

	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const COMMAND_NAME = "remove";

export interface RegisterRemoveCommandOptions {
	forgeRoot: string | null;
	cwd?: string;
}

export function registerRemoveCommand(pi: ExtensionAPI, options: RegisterRemoveCommandOptions): void {
	pi.registerCommand("forge:remove", {
		description:
			"Remove Forge artifacts from this project — interactive by default. " +
			"Usage: /forge:remove [--apply] [@<file> | <text>]. " +
			"--apply skips per-bucket confirmation prompts.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const { forgeRoot } = options;
			const cwd = options.cwd ?? process.cwd();

			if (!forgeRoot) {
				ctx.ui.notify("× forge:remove — no Forge project at cwd; run /forge:init to bootstrap", "warning");
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
						`× forge:remove — command file not found at commands/${COMMAND_NAME}.md; run /forge:init or /forge:rebuild first.`,
						"error",
					);
				} else {
					ctx.ui.notify(`× forge:remove — failed to read command file: ${e.message ?? "unknown error"}`, "error");
				}
				return;
			}

			let parsed: ParsedRemoveArgs;
			try {
				parsed = parseRemoveArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:remove — failed to parse args: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const kickoff = composeRemoveKickoff({ commandMd, parsed });
			sendKickoff(pi, kickoff);
		},
	});
}
