// forge:quiz-agent — native kickoff handler (FORGE-S23-T11).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// Ultra-thin shim: reads commands/quiz-agent.md and dispatches.
// Optional topic seed or @<file> narrows the quiz scope.
//
// Workflow source: <forgeRoot>/commands/quiz-agent.md (command file).
// Note: quiz_agent.md also exists in .forge/workflows/ but lacks 3 of
// 4 Pack-06 markers. Using the command file for consistency with the
// other 5 handlers in this batch. Follow-up task can upgrade to read
// from .forge/workflows/quiz_agent.md when it has all markers.
//
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

import { sendKickoff } from "../kickoff.js";

// ── Argv parsing ──────────────────────────────────────────────────────────

export interface ParsedQuizAgentArgs {
	mode: "empty" | "file" | "text";
	topicSeed: string;
	sourceLabel: string;
}

export function parseQuizAgentArgs(rawArgs: string, cwd: string): ParsedQuizAgentArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (!trimmed) {
		return { mode: "empty", topicSeed: "", sourceLabel: "(no topic — full KB quiz)" };
	}
	if (trimmed.startsWith("@")) {
		const ref = trimmed.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		const topicSeed = fs.readFileSync(filePath, "utf8");
		return { mode: "file", topicSeed, sourceLabel: `(topic from file: ${ref})` };
	}
	return { mode: "text", topicSeed: trimmed, sourceLabel: "(topic from inline text)" };
}

// ── Kickoff composition ───────────────────────────────────────────────────

export interface ComposeQuizAgentKickoffOpts {
	commandMd: string;
	parsed: ParsedQuizAgentArgs;
}

export function composeQuizAgentKickoff(opts: ComposeQuizAgentKickoffOpts): string {
	const { commandMd, parsed } = opts;

	const sections: string[] = ["# /forge:check-agent", ""];
	sections.push("## Dispatch", "");
	sections.push(
		"Run the quiz-agent workflow below to verify this agent has read and understood the project knowledge base. " +
			"Ask factual questions about the project's architecture, entity model, and sprint conventions — do not accept vague answers. " +
			"Report pass/fail with specific evidence.",
	);

	sections.push("", "---", "", "## Command", "", commandMd.trim(), "", "---");

	if (parsed.mode === "empty") {
		sections.push("", "## Topic", "", "(no topic specified — quiz the full KB scope)");
	} else {
		sections.push("", `## Topic — ${parsed.sourceLabel}`, "", parsed.topicSeed.trim());
	}

	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const COMMAND_NAME = "quiz-agent";

export interface RegisterQuizAgentOptions {
	forgeRoot: string | null;
	cwd?: string;
}

export function registerQuizAgent(pi: ExtensionAPI, options: RegisterQuizAgentOptions): void {
	pi.registerCommand("forge:check-agent", {
		description:
			"Verify an agent has loaded and understood the project knowledge base — run a short factual quiz. " +
			"Usage: /forge:check-agent [@<file> | <topic>]. Empty args run a full KB quiz.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const { forgeRoot } = options;
			const cwd = options.cwd ?? process.cwd();

			if (!forgeRoot) {
				ctx.ui.notify("× forge:check-agent — no Forge project at cwd; run /forge:init to bootstrap", "warning");
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
						`× forge:check-agent — command file not found at commands/${COMMAND_NAME}.md; run /forge:init or /forge:rebuild first.`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:check-agent — failed to read command file: ${e.message ?? "unknown error"}`,
						"error",
					);
				}
				return;
			}

			let parsed: ParsedQuizAgentArgs;
			try {
				parsed = parseQuizAgentArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:check-agent — failed to parse args: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const kickoff = composeQuizAgentKickoff({ commandMd, parsed });
			sendKickoff(pi, kickoff);
		},
	});
}
