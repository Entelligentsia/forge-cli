// forge:sprint-plan — LLM-driven kickoff handler (FORGE-BUG-032).
//
// Replaces the deterministic JSON-mode subagent call shipped in FORGE-S19-T02.
// The handler is now a thin shim that:
//   1. Parses argv: <SPRINT_ID> [@<file> | free-form text]
//   2. Reads SPRINT_REQUIREMENTS.md (or REQUIREMENTS.md alias) when present
//   3. Reads .forge/workflows/architect_sprint_plan.md
//   4. Composes a kickoff message (workflow + requirements + optional seed)
//   5. Calls pi.sendUserMessage() — LLM drives task decomposition with
//      forge_store write task per task, no rigid JSON contract.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── Argv parsing ──────────────────────────────────────────────────────────

interface ParsedArgs {
	sprintId: string;
	seedMode: "none" | "file" | "text";
	seed: string;
	sourceLabel: string;
}

export function parseSprintPlanArgs(rawArgs: string, cwd: string): ParsedArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (!trimmed) {
		throw new Error("sprint ID required — usage: /forge:sprint-plan <SPRINT_ID> [@<file> | <text>]");
	}
	const [sprintId, ...rest] = trimmed.split(/\s+/);
	const tail = rest.join(" ").trim();
	if (!tail) {
		return { sprintId, seedMode: "none", seed: "", sourceLabel: "" };
	}
	if (tail.startsWith("@")) {
		const ref = tail.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		const seed = fs.readFileSync(filePath, "utf8");
		return { sprintId, seedMode: "file", seed, sourceLabel: `(seed from file: ${ref})` };
	}
	return { sprintId, seedMode: "text", seed: tail, sourceLabel: "(seed from inline text)" };
}

// ── Requirements lookup ───────────────────────────────────────────────────

function resolveRequirements(cwd: string, sprintId: string): { path: string; content: string } | null {
	const sprintDir = path.join(cwd, "engineering", "sprints", sprintId);
	for (const name of ["SPRINT_REQUIREMENTS.md", "REQUIREMENTS.md"]) {
		const p = path.join(sprintDir, name);
		try {
			const content = fs.readFileSync(p, "utf8");
			return { path: p, content };
		} catch {
			/* try next */
		}
	}
	return null;
}

// ── Kickoff composition ───────────────────────────────────────────────────

export function composeKickoff(
	workflowMd: string,
	parsed: ParsedArgs,
	requirements: { path: string; content: string } | null,
): string {
	const sections: string[] = [
		"# /forge:sprint-plan",
		"",
		`Decompose sprint ${parsed.sprintId} into tasks. Drive the planning conversationally per the workflow below — read referenced personas/skills, validate dependencies, and write each task via \`forge_store write task '<json>'\` once you and the user agree on the shape. Update the sprint record with the final task ID list. Do not return a single bulk JSON array; commit tasks one at a time so the user can interject.`,
		"",
		"---",
		"",
		"## Workflow",
		"",
		workflowMd.trim(),
		"",
		"---",
		"",
		`## Sprint: ${parsed.sprintId}`,
	];
	if (requirements) {
		sections.push("", `Requirements file: \`${path.relative(process.cwd(), requirements.path)}\``);
		sections.push("", "```markdown", requirements.content.trim(), "```");
	} else {
		sections.push(
			"",
			`(no requirements file found at engineering/sprints/${parsed.sprintId}/SPRINT_REQUIREMENTS.md or REQUIREMENTS.md — ask the user to confirm intent or run /forge:sprint-intake first)`,
		);
	}
	if (parsed.seedMode !== "none") {
		sections.push("", `## Additional Input — ${parsed.sourceLabel}`, "", parsed.seed.trim());
	}
	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "architect_sprint_plan.md");

export function registerSprintPlan(pi: ExtensionAPI): void {
	pi.registerCommand("forge:sprint-plan", {
		description:
			"Start an LLM-driven sprint task-decomposition session. " +
			"Usage: /forge:sprint-plan <SPRINT_ID> [@<file> | <free-form text>]. " +
			"Reads SPRINT_REQUIREMENTS.md (or REQUIREMENTS.md) from the sprint directory.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();

			let parsed: ParsedArgs;
			try {
				parsed = parseSprintPlanArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:sprint-plan — ${e.message ?? "argv parse failed"}`, "error");
				return;
			}

			const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);
			if (!fs.existsSync(workflowPath)) {
				ctx.ui.notify(
					`× forge:sprint-plan — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:regenerate first.`,
					"error",
				);
				return;
			}

			let workflowMd: string;
			try {
				workflowMd = fs.readFileSync(workflowPath, "utf8");
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:sprint-plan — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const requirements = resolveRequirements(cwd, parsed.sprintId);
			if (!requirements) {
				ctx.ui.notify(
					`△ forge:sprint-plan — no SPRINT_REQUIREMENTS.md found at engineering/sprints/${parsed.sprintId}/. Continuing; LLM will ask you for context.`,
					"warning",
				);
			}

			const kickoff = composeKickoff(workflowMd, parsed, requirements);
			pi.sendUserMessage(kickoff);
		},
	});
}
