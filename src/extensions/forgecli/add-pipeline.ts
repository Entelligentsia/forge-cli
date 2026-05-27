// forge:add-pipeline — native kickoff handler (FORGE-S23-T11).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// Parses --add/--edit/--view/--remove/--list/--name flags and a plain
// pipeline name before dispatching. Resolved mode is prepended to the
// kickoff so the LLM starts in the correct mode without prompting.
//
// Workflow source: <forgeRoot>/commands/add-pipeline.md (command file).
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

export type AddPipelineMode = "add" | "edit" | "view" | "remove";

export interface ParsedAddPipelineArgs {
	mode: AddPipelineMode;
	pipelineName: string | null;
	seed: string;
	sourceLabel: string;
}

export function parseAddPipelineArgs(rawArgs: string, cwd: string): ParsedAddPipelineArgs {
	const trimmed = (rawArgs ?? "").trim();
	const result: ParsedAddPipelineArgs = {
		mode: "add",
		pipelineName: null,
		seed: "",
		sourceLabel: "",
	};

	if (!trimmed) {
		result.sourceLabel = "(no args — LLM will ask intent)";
		return result;
	}

	const tokens = trimmed.split(/\s+/);
	const remaining: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "--add") {
			result.mode = "add";
		} else if (tok === "--edit") {
			result.mode = "edit";
		} else if (tok === "--view" || tok === "--list") {
			result.mode = "view";
		} else if (tok === "--remove") {
			result.mode = "remove";
		} else if (tok === "--name" && i + 1 < tokens.length) {
			result.pipelineName = tokens[++i];
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
		// A bare word with no mode flag = pipeline name, default mode "add"
		if (!result.pipelineName && !/^--/.test(tail)) {
			result.pipelineName = tail;
		} else {
			result.seed = tail;
		}
		result.sourceLabel = "(from inline text)";
	}

	return result;
}

// ── Kickoff composition ───────────────────────────────────────────────────

const MODE_LABELS: Record<AddPipelineMode, string> = {
	add: "Add a new pipeline",
	edit: "Customize an existing pipeline",
	view: "View configured pipelines",
	remove: "Remove a pipeline",
};

export interface ComposeAddPipelineKickoffOpts {
	commandMd: string;
	parsed: ParsedAddPipelineArgs;
}

export function composeAddPipelineKickoff(opts: ComposeAddPipelineKickoffOpts): string {
	const { commandMd, parsed } = opts;

	const sections: string[] = ["# /forge:add-pipeline", ""];
	sections.push("## Dispatch", "");
	sections.push(`Start in **Mode: ${MODE_LABELS[parsed.mode]}**.`);
	if (parsed.pipelineName) {
		sections.push(`Pipeline name: \`${parsed.pipelineName}\``);
	}
	sections.push("");
	sections.push(
		"Run the pipeline manager command below. Use `forge_store` for all config reads and writes. " +
			"Read `.forge/config.json` directly when you need the pipelines section.",
	);

	sections.push("", "---", "", "## Command", "", commandMd.trim(), "", "---");

	if (parsed.seed) {
		sections.push("", `## Additional Input — ${parsed.sourceLabel}`, "", parsed.seed.trim());
	}

	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const COMMAND_NAME = "add-pipeline";

export interface RegisterAddPipelineOptions {
	forgeRoot: string | null;
	cwd?: string;
}

export function registerAddPipeline(pi: ExtensionAPI, options: RegisterAddPipelineOptions): void {
	pi.registerCommand("forge:add-pipeline", {
		description:
			"Conversational pipeline manager — add, customize, view, or remove Forge pipelines. " +
			"Usage: /forge:add-pipeline [--add|--edit|--view|--remove] [--name <name>] [<pipeline-name>]",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const { forgeRoot } = options;
			const cwd = options.cwd ?? process.cwd();

			if (!forgeRoot) {
				ctx.ui.notify("× forge:add-pipeline — no Forge project at cwd; run /forge:init to bootstrap", "warning");
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
						`× forge:add-pipeline — command file not found at commands/${COMMAND_NAME}.md; run /forge:init or /forge:rebuild first.`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:add-pipeline — failed to read command file: ${e.message ?? "unknown error"}`,
						"error",
					);
				}
				return;
			}

			let parsed: ParsedAddPipelineArgs;
			try {
				parsed = parseAddPipelineArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:add-pipeline — failed to parse args: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const kickoff = composeAddPipelineKickoff({ commandMd, parsed });
			sendKickoff(pi, kickoff);
		},
	});
}
