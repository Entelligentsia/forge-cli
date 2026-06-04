// forge:plan — native kickoff handler (FORGE-S20-T05).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Like S19 sprint-intake and
// FORGE-S20-T04 enhance, this is a Kickoff Shim (Pack-04 + Pack-06):
//   1. Reads `.forge/workflows/plan_task.md` (the materialized workflow).
//   2. Verifies four Pack-06 materialization markers — refuses to dispatch on
//      regression and emits a per-marker `ctx.ui.notify` so a user sees the
//      cause.
//   3. Loads the persona declared in the workflow's `deps.personas:`
//      frontmatter via the FORGE-S20-T02 loader (no ad-hoc fs.readFile of
//      `.forge/personas/`).
//   4. Composes ONE kickoff message: persona identity, dispatch instructions
//      (read TASK_PROMPT.md, follow workflow, write PLAN.md/PLAN-SUMMARY.json,
//      forge_store-driven status updates), the workflow body verbatim, and
//      argv as @<path> file ref or free-form text.
//   5. Hands control to the LLM via `sendKickoff(pi, text)` —
//      `deliverAs: "steer"`. Never raw `pi.sendUserMessage`.
//
// Per FORGE-S20 SPRINT_REQUIREMENTS Constraints and T05 AC#4: the
// prompt-injection fallback is DELETED — no FORGE_LEGACY_KICKOFF flag, no
// markdown-stub for this command.
//
// FORGE-S26-T11: pipeline step guard added. Checks task status via store-cli
// before dispatching. --force flag bypasses the guard.
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
import { discoverForgeConfig } from "./lib/forge-root.js";
import { sendKickoff } from "./kickoff.js";
// FORGE-S25-T16: extracted to lib modules. Re-exported here for backward compat
// (plan.test.ts, bundled-base-pack-markers.test.ts, run-task.ts, run-sprint.ts,
// fix-bug.ts all import checkMaterialization / extractPersonaNames from plan.js).
import { extractPersonaNames } from "./lib/frontmatter-parser.js";
import { parseGuardArgs, runPipelineGuard } from "./lib/pipeline-guard.js";
import { loadPersona, PersonaSkillLoaderError } from "./parsers/persona-skill-loader.js";
import { loadWorkflow, WorkflowLoaderError } from "./parsers/workflow-loader.js";

export { extractPersonaNames };

import { checkMaterialization, type MaterializationCheck } from "./lib/manifest-checker.js";

export { checkMaterialization, type MaterializationCheck };

// Argv parsing -------------------------------------------------------------

export type ArgMode = "empty" | "file" | "text";

export interface ParsedArgs {
	mode: ArgMode;
	taskRef: string;
	sourceLabel: string;
}

export function parsePlanArgs(rawArgs: string, cwd: string): ParsedArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (trimmed === "") {
		return { mode: "empty", taskRef: "", sourceLabel: "(no input — engineer infers task from store/context)" };
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

	const sections: string[] = ["# /forge:plan", ""];
	if (personaIdentity.trim().length > 0) {
		sections.push(personaIdentity.trim(), "");
	}

	sections.push(
		"## Dispatch",
		"",
		"Run the workflow below. Specifically:",
		"",
		"1. Read the task prompt at `engineering/sprints/<SPRINT_ID>/<TASK_ID>/TASK_PROMPT.md` (the source of truth).",
		"2. Query the store for the task and its sprint/feature context via `forge_store_query` — do NOT raw-read `.forge/store/`.",
		"3. Follow the workflow Algorithm verbatim: load context, research, plan, knowledge writeback, finalize.",
		"4. Write `PLAN.md` and `PLAN-SUMMARY.json` to the task directory using the `write` tool.",
		"5. Update task status by calling the `forge_store` MCP tool: `{command:'update-status', args:['task','<TASK_ID>','status','<new-status>']}`. Never raw-write `.forge/store/`. Do NOT bash-shell `forge store ...`.",
		"6. Honour Pack-06 Read/Write/Ask/Store discipline: writes go via the `forge_store` MCP tool (canonical 2-positional write: `args:['<entity>','<json>']`, id INSIDE json); in-conversation clarifications use `forge_ask_user`.",
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

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "plan_task.md");

export interface RegisterPlanOptions {
	cwd?: string;
}

export function registerPlan(pi: ExtensionAPI, options: RegisterPlanOptions = {}): void {
	pi.registerCommand("forge:plan", {
		description:
			"Run the plan-task workflow for a Forge task. " +
			"Usage: /forge:plan [@<file> | <free-form text>]. " +
			"Empty args → engineer infers the task from sprint/store context.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);

			// Pipeline step guard (FORGE-S26-T11): check task state before dispatching.
			const guardParsed = parseGuardArgs(args);
			if (!guardParsed.force) {
				const forgeConfig = discoverForgeConfig(cwd);
				if (forgeConfig) {
					const guard = runPipelineGuard("plan", guardParsed.taskIdHint, forgeConfig.forgeRoot, cwd);
					if (guard.blocked) {
						ctx.ui.notify(guard.message, "error");
						return;
					}
				}
			}
			// Use cleanArgs (--force stripped) for workflow dispatch
			const effectiveArgs = guardParsed.cleanArgs;

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
							`× forge:plan — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:rebuild first.`,
							"error",
						);
					} else {
						ctx.ui.notify(`× forge:plan — workflow load failed (${err.code}): ${err.message}`, "error");
					}
					return;
				}
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:plan — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			let parsed: ParsedArgs;
			try {
				parsed = parsePlanArgs(effectiveArgs, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:plan — failed to read seed: ${e.message ?? "unknown"}`, "error");
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
							`× forge:plan — persona '${personas[0]}' load failed (${err.code}): ${err.message}`,
							"error",
						);
						return;
					}
					const e = err as { message?: string };
					ctx.ui.notify(`× forge:plan — persona load error: ${e.message ?? "unknown"}`, "error");
					return;
				}
			}

			if (!assertAudience({ workflowName: "plan_task", audience: workflowAudience }, ctx)) {
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
