// forge:retrospective — native kickoff handler (FORGE-S23-T06).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// The retrospective workflow (sprint_retrospective.md) is LLM-driven:
// the handler reads the materialized workflow, composes a kickoff message
// citing the persona path and workflow path, then dispatches via
// pi.sendUserMessage with { deliverAs: "steer" }.
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

import { assertAudience } from "./audience-gate.js";
import { sendKickoff } from "./kickoff.js";
// FORGE-S25-T16: extracted to lib module (H-1). Re-exported here for
// backward compatibility with existing test and consumer imports.
import { extractPersonaNames } from "./lib/frontmatter-parser.js";
import { loadPersona, PersonaSkillLoaderError } from "./parsers/persona-skill-loader.js";
import { loadWorkflow, WorkflowLoaderError } from "./parsers/workflow-loader.js";

export { extractPersonaNames };

// Argv parsing -------------------------------------------------------------

export type ArgMode = "empty" | "file" | "text";

export interface ParsedArgs {
	mode: ArgMode;
	sprintRef: string;
	sourceLabel: string;
}

export function parseRetroArgs(rawArgs: string, cwd: string): ParsedArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (trimmed === "") {
		return { mode: "empty", sprintRef: "", sourceLabel: "(no sprint specified — will prompt)" };
	}
	if (trimmed.startsWith("@")) {
		const ref = trimmed.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		const seed = fs.readFileSync(filePath, "utf8");
		return { mode: "file", sprintRef: seed, sourceLabel: `(seed from file: ${ref})` };
	}
	return { mode: "text", sprintRef: trimmed, sourceLabel: "(seed from inline text)" };
}

// Kickoff composition ------------------------------------------------------

export interface ComposeKickoffOpts {
	workflowMd: string;
	personaIdentity: string;
	parsed: ParsedArgs;
}

export function composeKickoff(opts: ComposeKickoffOpts): string {
	const { workflowMd, personaIdentity, parsed } = opts;

	const sections: string[] = ["# /forge:retrospective", ""];
	if (personaIdentity.trim().length > 0) {
		sections.push(personaIdentity.trim(), "");
	}

	sections.push(
		"## Dispatch",
		"",
		"Run the retrospective workflow below. Specifically:",
		"",
		"1. Identify the sprint to retrospect: if a sprint ID was provided (e.g. FORGE-SNN) use it directly; otherwise ask the user which sprint to retrospect before proceeding.",
		"2. Load the architect persona from `.forge/personas/architect.md` for full identity context.",
		"3. Follow the workflow at `.forge/workflows/sprint_retrospective.md` verbatim: load all sprint task manifests, event logs, and retrospective notes; compute cost and bottlenecks; write RETROSPECTIVE.md.",
		"4. Use `forge_store_query` for all store reads — do NOT raw-read `.forge/store/`.",
		"5. Write retrospective artifacts using the `write` tool.",
		"6. Honour Pack-06 Read/Write/Ask/Store discipline: in-conversation clarifications use `forge_ask_user`.",
	);

	sections.push("", "---", "", "## Workflow", "", workflowMd.trim(), "", "---");

	if (parsed.mode === "empty") {
		sections.push(
			"",
			"## Input",
			"",
			"(no sprint specified — ask the user which sprint to retrospect before proceeding)",
		);
	} else {
		sections.push("", `## Input — ${parsed.sourceLabel}`, "", parsed.sprintRef.trim());
	}

	return sections.join("\n");
}

// Registration -------------------------------------------------------------

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "sprint_retrospective.md");

export interface RegisterRetrospectiveOptions {
	cwd?: string;
}

export function registerRetrospective(pi: ExtensionAPI, options: RegisterRetrospectiveOptions = {}): void {
	pi.registerCommand("forge:retrospective", {
		description:
			"Run the retrospective workflow for a Forge sprint. " +
			"Usage: /forge:retrospective [FORGE-SNN | @<file> | <free-form text>]. " +
			"Empty args — the LLM will prompt you for the sprint to retrospect.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);

			let workflowMd: string;
			let workflowAudience: import("./parsers/workflow-loader.js").AudienceValue;
			try {
				const loaded = loadWorkflow(workflowPath);
				workflowMd = loaded.rawMarkdown;
				workflowAudience = loaded.audience;
			} catch (err: unknown) {
				if (err instanceof WorkflowLoaderError) {
					if (err.code === "missing_file") {
						ctx.ui.notify(
							`× forge:retrospective — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:regenerate first.`,
							"error",
						);
					} else {
						ctx.ui.notify(`× forge:retrospective — workflow load failed (${err.code}): ${err.message}`, "error");
					}
					return;
				}
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:retrospective — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			let parsed: ParsedArgs;
			try {
				parsed = parseRetroArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:retrospective — failed to read seed: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const personas = extractPersonaNames(workflowMd);
			let personaIdentity = "";
			if (personas.length > 0) {
				try {
					const persona = loadPersona(personas[0], { cwd });
					personaIdentity = persona.identity;
				} catch (err: unknown) {
					if (err instanceof PersonaSkillLoaderError) {
						ctx.ui.notify(
							`× forge:retrospective — persona '${personas[0]}' load failed (${err.code}): ${err.message}`,
							"error",
						);
						return;
					}
					const e = err as { message?: string };
					ctx.ui.notify(`× forge:retrospective — persona load error: ${e.message ?? "unknown"}`, "error");
					return;
				}
			}

			if (!assertAudience({ workflowName: "sprint_retrospective", audience: workflowAudience }, ctx)) {
				return;
			}

			const kickoff = composeKickoff({
				workflowMd,
				personaIdentity,
				parsed,
			});

			sendKickoff(pi, kickoff);
		},
	});
}
