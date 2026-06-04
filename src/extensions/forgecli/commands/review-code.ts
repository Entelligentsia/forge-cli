// forge:review-code — native kickoff handler (FORGE-S21-T10).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// Note: The materialized workflow (review_code.md) declares
// `audience: subagent` — advisory only. Users may invoke this command
// manually from the CLI; assertAudience never refuses subagent-audience
// workflows. Orchestrator chains still dispatch via runForgeSubagent
// directly and do NOT route through this handler.
//
// FORGE-S26-T11:
//   - Pipeline step guard added (checks task state via store-cli; --force bypasses).
//   - Revision loop context injected into kickoff: `### Review Loop Context` block
//     with `Iteration: 1 of M` (user-invoked default).
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

import { assertAudience } from "../audience-gate.js";
import { discoverForgeConfig } from "../lib/forge-root.js";
import { sendKickoff } from "../kickoff.js";
// FORGE-S25-T16: extracted to lib modules (H-1, H-2). Re-exported here for
// backward compatibility with existing test and consumer imports.
import { extractPersonaNames } from "../lib/frontmatter-parser.js";
import { parseGuardArgs, runPipelineGuard } from "../lib/pipeline-guard.js";
import { loadPersona, PersonaSkillLoaderError } from "../parsers/persona-skill-loader.js";
import { loadWorkflow, WorkflowLoaderError } from "../parsers/workflow-loader.js";

export { extractPersonaNames };

import { checkMaterialization, type MaterializationCheck } from "../lib/manifest-checker.js";

export { checkMaterialization, type MaterializationCheck };

// Argv parsing -------------------------------------------------------------

export type ArgMode = "empty" | "file" | "text";

export interface ParsedArgs {
	mode: ArgMode;
	taskRef: string;
	sourceLabel: string;
}

export function parseReviewCodeArgs(rawArgs: string, cwd: string): ParsedArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (trimmed === "") {
		return { mode: "empty", taskRef: "", sourceLabel: "(no input — supervisor infers task from store/context)" };
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
	/** Revision loop context block (FORGE-S26-T11). Injected before the workflow body. */
	reviewLoopContext?: string;
}

export function composeKickoff(opts: ComposeKickoffOpts): string {
	const { workflowMd, personaIdentity, parsed, reviewLoopContext } = opts;

	const sections: string[] = ["# /forge:review-code", ""];
	if (personaIdentity.trim().length > 0) {
		sections.push(personaIdentity.trim(), "");
	}

	// Inject review loop context before workflow body (FORGE-S26-T11 / T07).
	if (reviewLoopContext) {
		sections.push(reviewLoopContext.trim(), "");
	}

	sections.push(
		"## Dispatch",
		"",
		"Run the workflow below. Specifically:",
		"",
		"1. Read the implementation diff and PROGRESS.md for `engineering/sprints/<SPRINT_ID>/<TASK_ID>/` (the source of truth).",
		"2. Query the store for the task and its sprint/feature context via `forge_store_query` — do NOT raw-read `.forge/store/`.",
		"3. Follow the workflow Algorithm verbatim: review code for correctness, test coverage, security, and architecture compliance.",
		"4. Write `CODE_REVIEW.md` and `CODE-REVIEW-SUMMARY.json` to the task directory using the `write` tool.",
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

// Iteration context builder (FORGE-S26-T11) ------------------------------------

/**
 * Build the `### Review Loop Context` block for user-invoked (non-orchestrated)
 * review-code calls. Matches the T07 graceful-fallback spec:
 * "iteration 1 of M" where M is config.maxReviewIterations (default 3).
 */
export function buildReviewLoopContext(maxIterations: number): string {
	return [
		"### Review Loop Context",
		`- Iteration: 1 of ${maxIterations}`,
		`- Is final iteration: ${maxIterations === 1 ? "true" : "false"}`,
	].join("\n");
}

/**
 * Read maxReviewIterations from .forge/config.json. Returns default 3 on any
 * error (missing file, missing field, non-integer value).
 */
export function readMaxReviewIterations(cwd: string): number {
	const configPath = path.join(cwd, ".forge", "config.json");
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const cfg = JSON.parse(raw) as Record<string, unknown>;
		const v = cfg["maxReviewIterations"];
		if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
	} catch {
		// fail-open
	}
	return 3;
}

// Registration -------------------------------------------------------------

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "review_code.md");

export interface RegisterReviewCodeOptions {
	cwd?: string;
}

export function registerReviewCode(pi: ExtensionAPI, options: RegisterReviewCodeOptions = {}): void {
	pi.registerCommand("forge:review-code", {
		description:
			"Run the review-code workflow for a Forge task. " +
			"Usage: /forge:review-code [@<file> | <free-form text>]. " +
			"Note: this workflow is subagent-only; standalone invocations are refused. " +
			"Orchestrator chains dispatch directly via runForgeSubagent.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);

			// Pipeline step guard (FORGE-S26-T11): check task state before dispatching.
			const guardParsed = parseGuardArgs(args);
			if (!guardParsed.force) {
				const forgeConfig = discoverForgeConfig(cwd);
				if (forgeConfig) {
					const guard = runPipelineGuard("review-code", guardParsed.taskIdHint, forgeConfig.forgeRoot, cwd);
					if (guard.blocked) {
						ctx.ui.notify(guard.message, "error");
						return;
					}
				}
			}
			const effectiveArgs = guardParsed.cleanArgs;

			let workflowMd: string;
			let workflowAudience: import("../parsers/workflow-loader.js").AudienceValue;
			try {
				const loaded = loadWorkflow(workflowPath);
				workflowMd = loaded.rawMarkdown;
				workflowAudience = loaded.audience;
			} catch (err: unknown) {
				if (err instanceof WorkflowLoaderError) {
					if (err.code === "missing_file") {
						ctx.ui.notify(
							`× forge:review-code — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:rebuild first.`,
							"error",
						);
					} else {
						ctx.ui.notify(`× forge:review-code — workflow load failed (${err.code}): ${err.message}`, "error");
					}
					return;
				}
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:review-code — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			let parsed: ParsedArgs;
			try {
				parsed = parseReviewCodeArgs(effectiveArgs, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:review-code — failed to read seed: ${e.message ?? "unknown"}`, "error");
				return;
			}

			// Build revision loop context (FORGE-S26-T11 / T07)
			const maxIter = readMaxReviewIterations(cwd);
			const reviewLoopContext = buildReviewLoopContext(maxIter);

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
							`× forge:review-code — persona '${personas[0]}' load failed (${err.code}): ${err.message}`,
							"error",
						);
						return;
					}
					const e = err as { message?: string };
					ctx.ui.notify(`× forge:review-code — persona load error: ${e.message ?? "unknown"}`, "error");
					return;
				}
			}

			if (!assertAudience({ workflowName: "review_code", audience: workflowAudience }, ctx)) {
				return;
			}

			const kickoff = composeKickoff({
				workflowMd,
				personaIdentity,
				parsed,
				reviewLoopContext,
			});

			sendKickoff(pi, kickoff);
		},
	});
}
