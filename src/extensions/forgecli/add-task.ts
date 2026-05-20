// forge:add-task — native kickoff handler (FORGE-S23-T11).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// This handler reads commands/add-task.md from the bundled forge payload,
// forwards any provided argv shortcuts (--sprint, --title, --estimate,
// --pipeline) in the kickoff body so the LLM skips those interview steps,
// and dispatches via pi.sendUserMessage with { deliverAs: "steer" }.
//
// Note: The task prompt mentions "store-cli --next-id pre-flight", but
// store-cli has no next-id subcommand. The ID is computed by the LLM
// from the sprint record (per Step 3 in the command file). The handler
// only forwards shortcuts to reduce LLM round-trips.
//
// Workflow source: <forgeRoot>/commands/add-task.md (command file).
// File-existence check only (not Pack-06 4-marker check) — command files
// are simpler than full workflow files and lack the required markers.
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

export interface ParsedAddTaskArgs {
	sprintId: string | null;
	title: string | null;
	estimate: string | null;
	pipeline: string | null;
	seed: string;
	sourceLabel: string;
}

export function parseAddTaskArgs(rawArgs: string, cwd: string): ParsedAddTaskArgs {
	const trimmed = (rawArgs ?? "").trim();
	const result: ParsedAddTaskArgs = {
		sprintId: null,
		title: null,
		estimate: null,
		pipeline: null,
		seed: "",
		sourceLabel: "",
	};

	if (!trimmed) {
		result.sourceLabel = "(no args — LLM will conduct full interview)";
		return result;
	}

	// Parse known flags
	const tokens = trimmed.split(/\s+/);
	const remaining: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "--sprint" && i + 1 < tokens.length) {
			result.sprintId = tokens[++i];
		} else if (tok === "--title" && i + 1 < tokens.length) {
			result.title = tokens[++i];
		} else if (tok === "--estimate" && i + 1 < tokens.length) {
			result.estimate = tokens[++i];
		} else if (tok === "--pipeline" && i + 1 < tokens.length) {
			result.pipeline = tokens[++i];
		} else {
			remaining.push(tok);
		}
	}

	// Remaining tokens: @<file> or free-form text
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
		result.sourceLabel = "(shortcuts provided)";
	}

	return result;
}

// ── Kickoff composition ───────────────────────────────────────────────────

export interface ComposeAddTaskKickoffOpts {
	commandMd: string;
	parsed: ParsedAddTaskArgs;
}

export function composeAddTaskKickoff(opts: ComposeAddTaskKickoffOpts): string {
	const { commandMd, parsed } = opts;

	const shortcuts: string[] = [];
	if (parsed.sprintId) shortcuts.push(`--sprint ${parsed.sprintId}`);
	if (parsed.title) shortcuts.push(`--title "${parsed.title}"`);
	if (parsed.estimate) shortcuts.push(`--estimate ${parsed.estimate}`);
	if (parsed.pipeline) shortcuts.push(`--pipeline ${parsed.pipeline}`);

	const sections: string[] = ["# /forge:add-task", ""];
	sections.push("## Dispatch", "");
	sections.push("Run the add-task command below to add a new task to an existing sprint. Specifically:");
	sections.push("");
	sections.push("1. Follow the command file steps in order.");
	if (shortcuts.length > 0) {
		sections.push(
			`2. The following shortcuts were provided — skip the corresponding interview steps: \`${shortcuts.join(" ")}\``,
		);
	}
	sections.push(
		`${shortcuts.length > 0 ? "3" : "2"}. Use \`forge_store\` for all store reads and writes (never raw bash \`forge store\`).`,
	);
	sections.push(
		`${shortcuts.length > 0 ? "4" : "3"}. Compute the next task ID from the sprint record's \`taskIds\` array per Step 3 in the command file.`,
	);

	sections.push("", "---", "", "## Command", "", commandMd.trim(), "", "---");

	if (parsed.seed) {
		sections.push("", `## Additional Input — ${parsed.sourceLabel}`, "", parsed.seed.trim());
	} else if (shortcuts.length === 0) {
		sections.push("", "## Input", "", "(no args — begin mini-intake interview)");
	}

	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const COMMAND_NAME = "add-task";

export interface RegisterAddTaskOptions {
	forgeRoot: string | null;
	cwd?: string;
}

export function registerAddTask(pi: ExtensionAPI, options: RegisterAddTaskOptions): void {
	pi.registerCommand("forge:add-task", {
		description:
			"Add a new task to an existing sprint mid-flight — mini intake, sequential ID assignment, store write. " +
			"Usage: /forge:add-task [--sprint <ID>] [--title <text>] [--estimate <S|M|L|XL>] [--pipeline <name>] [@<file> | <text>]",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const { forgeRoot } = options;
			const cwd = options.cwd ?? process.cwd();

			if (!forgeRoot) {
				ctx.ui.notify(
					"× forge:add-task — no Forge project at cwd; run /forge:init to bootstrap",
					"warning",
				);
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
						`× forge:add-task — command file not found at commands/${COMMAND_NAME}.md; run /forge:init or /forge:regenerate first.`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:add-task — failed to read command file: ${e.message ?? "unknown error"}`,
						"error",
					);
				}
				return;
			}

			let parsed: ParsedAddTaskArgs;
			try {
				parsed = parseAddTaskArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:add-task — failed to parse args: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const kickoff = composeAddTaskKickoff({ commandMd, parsed });
			sendKickoff(pi, kickoff);
		},
	});
}
