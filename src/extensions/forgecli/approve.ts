// forge:approve — native kickoff handler (FORGE-S21-T10).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// Note: The materialized workflow (architect_approve.md) declares
// `audience: subagent` — advisory only. Users may invoke this command
// manually from the CLI; assertAudience never refuses subagent-audience
// workflows. Orchestrator chains still dispatch via runForgeSubagent
// directly and do NOT route through this handler.
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
import { loadPersona, PersonaSkillLoaderError } from "./loaders/persona-skill-loader.js";
import { loadWorkflow, WorkflowLoaderError } from "./loaders/workflow-loader.js";

// FORGE-S25-T16: extracted to lib modules (H-1, H-2). Re-exported here for
// backward compatibility with existing test and consumer imports.
import { extractPersonaNames } from "./lib/frontmatter-parser.js";
export { extractPersonaNames };
import { type MaterializationCheck, checkMaterialization } from "./lib/manifest-checker.js";
export { type MaterializationCheck, checkMaterialization };

// Argv parsing -------------------------------------------------------------

export type ArgMode = "empty" | "file" | "text";

export interface ParsedArgs {
	mode: ArgMode;
	taskRef: string;
	sourceLabel: string;
}

export function parseApproveArgs(rawArgs: string, cwd: string): ParsedArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (trimmed === "") {
		return { mode: "empty", taskRef: "", sourceLabel: "(no input — architect infers task from store/context)" };
	}
	if (trimmed.startsWith("@")) {
		const ref = trimmed.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		const seed = fs.readFileSync(filePath, "utf8");
		return { mode: "file", taskRef: seed, sourceLabel: `(seed from file: ${ref})` };
	}
	return { mode: "text", taskRef: trimmed, sourceLabel: "(seed from inline text)" };
}

// Kickoff composition ------------------------------------------------------

export interface ComposeKickoffOpts {
	workflowMd: string;
	personaIdentity: string;
	parsed: ParsedArgs;
}

export function composeKickoff(opts: ComposeKickoffOpts): string {
	const { workflowMd, personaIdentity, parsed } = opts;

	const sections: string[] = ["# /forge:approve", ""];
	if (personaIdentity.trim().length > 0) {
		sections.push(personaIdentity.trim(), "");
	}

	sections.push(
		"## Dispatch",
		"",
		"Run the workflow below. Specifically:",
		"",
		"1. Read all review artifacts for `engineering/sprints/<SPRINT_ID>/<TASK_ID>/` (PLAN_REVIEW.md, CODE_REVIEW.md).",
		"2. Query the store for the task and its sprint/feature context via `forge_store_query` — do NOT raw-read `.forge/store/`.",
		"3. Follow the workflow Algorithm verbatim: assess the full task lifecycle against architecture and acceptance criteria.",
		"4. Write `ARCHITECT_APPROVAL.md` and `APPROVAL-SUMMARY.json` to the task directory using the `write` tool.",
		"5. Update task status by calling the `forge_store` MCP tool: `{command:'update-status', args:['task','<TASK_ID>','status','<new-status>']}`. Never raw-write `.forge/store/`. Do NOT bash-shell `forge store ...`.",
		"6. Honour Pack-06 Read/Write/Ask/Store discipline: writes go via the `forge_store` MCP tool; in-conversation clarifications use `forge_ask_user`.",
	);

	sections.push("", "---", "", "## Workflow", "", workflowMd.trim(), "", "---");

	if (parsed.mode === "empty") {
		sections.push("", "## Input", "", "(no seed — infer task from sprint context and store)");
	} else {
		sections.push("", `## Input — ${parsed.sourceLabel}`, "", parsed.taskRef.trim());
	}

	return sections.join("\n");
}

// Registration -------------------------------------------------------------

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "architect_approve.md");

export interface RegisterApproveOptions {
	cwd?: string;
}

export function registerApprove(pi: ExtensionAPI, options: RegisterApproveOptions = {}): void {
	pi.registerCommand("forge:approve", {
		description:
			"Run the architect-approve workflow for a Forge task. " +
			"Usage: /forge:approve [@<file> | <free-form text>]. " +
			"Note: this workflow is subagent-only; standalone invocations are refused. " +
			"Orchestrator chains dispatch directly via runForgeSubagent.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);

			let workflowMd: string;
			let workflowAudience: import("./loaders/workflow-loader.js").AudienceValue;
			try {
				const loaded = loadWorkflow(workflowPath);
				workflowMd = loaded.rawMarkdown;
				workflowAudience = loaded.audience;
			} catch (err: unknown) {
				if (err instanceof WorkflowLoaderError) {
					if (err.code === "missing_file") {
						ctx.ui.notify(
							`× forge:approve — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:regenerate first.`,
							"error",
						);
					} else {
						ctx.ui.notify(`× forge:approve — workflow load failed (${err.code}): ${err.message}`, "error");
					}
					return;
				}
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:approve — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			let parsed: ParsedArgs;
			try {
				parsed = parseApproveArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:approve — failed to read seed: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const check = checkMaterialization(workflowPath, workflowMd);
			if (!check.ok) {
				for (const marker of check.missing) {
					ctx.ui.notify(`× workflow regression: ${marker} not found in ${workflowPath}`, "error");
				}
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
							`× forge:approve — persona '${personas[0]}' load failed (${err.code}): ${err.message}`,
							"error",
						);
						return;
					}
					const e = err as { message?: string };
					ctx.ui.notify(`× forge:approve — persona load error: ${e.message ?? "unknown"}`, "error");
					return;
				}
			}

			if (!assertAudience({ workflowName: "architect_approve", audience: workflowAudience }, ctx)) {
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
