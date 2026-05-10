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
import { loadPersona, PersonaSkillLoaderError } from "./loaders/persona-skill-loader.js";

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

// Frontmatter persona extraction (permissive) ------------------------------

export function extractPersonaNames(workflowMd: string): string[] {
	const lines = workflowMd.split(/\r?\n/);
	if (lines.length === 0 || lines[0] !== "---") return [];
	let inside = false;
	let depsBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i === 0 && line === "---") {
			inside = true;
			continue;
		}
		if (!inside) break;
		if (line === "---") break;
		if (/^deps\s*:\s*$/.test(line)) {
			depsBlock = true;
			continue;
		}
		const m = /^\s*personas\s*:\s*\[([^\]]*)\]\s*$/.exec(line);
		if (m && (depsBlock || /^\s/.test(line))) {
			return m[1]
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter((s) => s.length > 0);
		}
		if (depsBlock && /^[A-Za-z0-9_-]+\s*:/.test(line) && !/^\s/.test(line)) {
			depsBlock = false;
		}
	}
	return [];
}

// Materialization-marker check (Pack-06) -----------------------------------

export interface MaterializationCheck {
	ok: boolean;
	missing: string[];
}

export function checkMaterialization(workflowPath: string, workflowMd: string): MaterializationCheck {
	const missing: string[] = [];

	if (!workflowMd.includes("Store-Write Verification")) {
		missing.push("Store-Write Verification");
	}
	if (!workflowMd.includes("Iron Laws")) {
		missing.push("Iron Laws");
	}
	if (!workflowMd.includes("forge_store")) {
		missing.push("forge_store");
	}

	const personas = extractPersonaNames(workflowMd);
	if (personas.length === 0) {
		missing.push("deps.personas: declaration");
	} else {
		const bodyStart = (() => {
			if (!workflowMd.startsWith("---\n") && !workflowMd.startsWith("---\r\n")) return 0;
			const re = /\r?\n---\r?\n/;
			const m = re.exec(workflowMd);
			return m ? m.index + m[0].length : 0;
		})();
		const body = workflowMd.slice(bodyStart);

		const anyHit = personas.some((name) => {
			if (!name) return false;
			const tokenRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
			return body.includes(`${name}.md`) || tokenRegex.test(body);
		});
		if (!anyHit) {
			missing.push(`persona file path (${personas.join(", ")})`);
		}
	}

	void workflowPath;
	return { ok: missing.length === 0, missing };
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

			if (!fs.existsSync(workflowPath)) {
				ctx.ui.notify(
					`× forge:plan — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:regenerate first.`,
					"error",
				);
				return;
			}

			let workflowMd: string;
			try {
				workflowMd = fs.readFileSync(workflowPath, "utf8");
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:plan — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			let parsed: ParsedArgs;
			try {
				parsed = parsePlanArgs(args, cwd);
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

			const kickoff = composeKickoff({
				workflowMd,
				personaIdentity,
				parsed,
			});

			sendKickoff(pi, kickoff);
		},
	});
}
