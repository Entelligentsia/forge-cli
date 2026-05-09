// forge:sprint-intake — LLM-driven kickoff handler (FORGE-BUG-031).
//
// Replaces the deterministic TUI flow shipped in FORGE-S19-T01. The native
// handler is now a thin shim that:
//   1. Parses argv: empty | "@<path>" (file ref) | free-form text
//   2. Reads .forge/workflows/architect_sprint_intake.md
//   3. Composes a kickoff message (workflow + seed input)
//   4. Calls pi.sendUserMessage() to inject — LLM drives the interview using
//      forge_store, forge_ask_user, write, read, forge_collate tools.
//
// No multi-turn TUI, no checkpoints, no scripted-answers env var. The LLM
// owns the conversation; the handler returns once the kickoff is queued.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── Argv parsing ──────────────────────────────────────────────────────────

interface ParsedArgs {
	mode: "empty" | "file" | "text";
	seed: string;
	sourceLabel: string;
}

export function parseSprintIntakeArgs(rawArgs: string, cwd: string): ParsedArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (!trimmed) {
		return { mode: "empty", seed: "", sourceLabel: "(no input — start interview)" };
	}
	if (trimmed.startsWith("@")) {
		const ref = trimmed.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		const seed = fs.readFileSync(filePath, "utf8");
		return { mode: "file", seed, sourceLabel: `(seed from file: ${ref})` };
	}
	return { mode: "text", seed: trimmed, sourceLabel: "(seed from inline text)" };
}

// ── Kickoff composition ───────────────────────────────────────────────────

export function composeKickoff(workflowMd: string, parsed: ParsedArgs): string {
	const seedSection =
		parsed.mode === "empty"
			? "\n## Input\n\n(no seed — begin interview now and elicit goals/scope/constraints conversationally)\n"
			: `\n## Input — ${parsed.sourceLabel}\n\n${parsed.seed.trim()}\n`;
	return [
		"# /forge:sprint-intake",
		"",
		"Run the sprint-intake workflow below. Drive the interview conversationally — read referenced personas/skills/templates as needed, ask clarifying questions one at a time, and write `engineering/sprints/<SPRINT_ID>/SPRINT_REQUIREMENTS.md` plus the corresponding store records when ready. Use `forge_store write sprint '<json>'` for the canonical sprint record.",
		"",
		"---",
		"",
		"## Workflow",
		"",
		workflowMd.trim(),
		"",
		"---",
		seedSection,
	].join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "architect_sprint_intake.md");

export function registerSprintIntake(pi: ExtensionAPI): void {
	pi.registerCommand("forge:sprint-intake", {
		description:
			"Start an LLM-driven sprint-intake interview. " +
			"Usage: /forge:sprint-intake [@<file> | <free-form text>]. " +
			"Empty args start a conversational interview from scratch.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();
			const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);
			if (!fs.existsSync(workflowPath)) {
				ctx.ui.notify(
					`forge:sprint-intake — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:regenerate first.`,
					"warning",
				);
				return;
			}

			let parsed: ParsedArgs;
			try {
				parsed = parseSprintIntakeArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`forge:sprint-intake — failed to read seed: ${e.message ?? "unknown"}`, "error");
				return;
			}

			let workflowMd: string;
			try {
				workflowMd = fs.readFileSync(workflowPath, "utf8");
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`forge:sprint-intake — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const kickoff = composeKickoff(workflowMd, parsed);
			pi.sendUserMessage(kickoff);
		},
	});
}
