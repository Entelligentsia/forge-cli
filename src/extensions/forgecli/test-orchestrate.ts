// test-orchestrate.ts — /test-orchestrate slash command for subagent harness e2e.
//
// Spawns a forge subagent via runForgeSubagent() and delegates the user-provided
// prompt to it. Multi-turn allowed (subagent loops until no more tool calls).
// Streams live updates back to UI via setStatus + ctx.ui.notify.
//
// Usage:
//   /test-orchestrate <prompt>
//   /test-orchestrate @path/to/prompt-file.md
//
// Persona: inline minimal generic-assistant persona. Replace with
// loadForgePersona("engineer", cwd) once persona frontmatter is backfilled.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	type ForgePersona,
	getFinalOutput,
	loadForgePersona,
	runForgeSubagent,
} from "./forge-subagent.js";

const STATUS_KEY = "test-orchestrate";

const GENERIC_PERSONA: ForgePersona = {
	name: "test-scribe",
	description: "Generic assistant for /test-orchestrate harness",
	systemPrompt: [
		"You are a test subagent invoked through the Forge subagent harness.",
		"Use the available tools (read, write, edit, bash) as needed to fulfill the user's request.",
		"Be terse. Show evidence (file paths, command output) over narration.",
		"If the task asks for a file, write it. If it asks for analysis, summarize in <200 words.",
	].join(" "),
	filePath: "<inline>",
};

interface ParsedArgs {
	mode: "text" | "file" | "persona-file";
	text: string;
	persona: ForgePersona;
	cwd: string;
}

function parseArgs(args: string, cwd: string): ParsedArgs {
	const trimmed = args.trim();
	if (!trimmed) {
		return { mode: "text", text: "", persona: GENERIC_PERSONA, cwd };
	}

	// @path/to/file → read file as task body
	if (trimmed.startsWith("@")) {
		const rel = trimmed.slice(1);
		const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
		const text = fs.readFileSync(abs, "utf-8");
		return { mode: "file", text, persona: GENERIC_PERSONA, cwd };
	}

	// --persona <name> <task>
	const personaMatch = trimmed.match(/^--persona\s+(\S+)\s+(.+)$/s);
	if (personaMatch) {
		const personaName = personaMatch[1];
		const text = personaMatch[2];
		const persona = loadForgePersona(personaName, cwd);
		return { mode: "persona-file", text, persona, cwd };
	}

	return { mode: "text", text: trimmed, persona: GENERIC_PERSONA, cwd };
}

export function registerTestOrchestrate(pi: ExtensionAPI): void {
	pi.registerCommand("test-orchestrate", {
		description:
			"Spawn a forge subagent via the SDK harness and delegate a prompt. " +
			"Usage: /test-orchestrate <prompt>  |  @<file>  |  --persona <name> <prompt>",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× /test-orchestrate — ${e.message ?? "arg parse failed"}`, "error");
				return;
			}

			if (!parsed.text.trim()) {
				ctx.ui.notify(
					"× /test-orchestrate — prompt required (usage: /test-orchestrate <prompt> | @<file> | --persona <name> <prompt>)",
					"error",
				);
				return;
			}

			const ac = new AbortController();
			ctx.ui.setStatus?.(STATUS_KEY, `subagent: ${parsed.persona.name} starting…`);

			// Rolling tail of recent events for the live monitor widget.
			const TAIL_MAX = 12;
			const TEXT_WINDOW = 80; // chars of streaming text shown
			const tail: string[] = [];
			let turn = 0;
			let lastToolName = "";
			let textBuffer = ""; // accumulator for current message_update text_delta

			const refreshWidget = () => {
				const header = `▶ subagent ${parsed.persona.name} · turn ${turn}`;
				const lines = [header, ...tail.slice(-TAIL_MAX)];
				if (textBuffer) {
					const tailText = textBuffer.slice(-TEXT_WINDOW).replace(/\n/g, " ⏎ ");
					lines.push(`▌ ${tailText}`);
				}
				ctx.ui.setWidget?.(STATUS_KEY, lines);
			};

			const push = (line: string) => {
				tail.push(line);
				if (tail.length > TAIL_MAX * 2) tail.splice(0, tail.length - TAIL_MAX);
				refreshWidget();
			};

			try {
				const result = await runForgeSubagent({
					persona: parsed.persona,
					task: parsed.text,
					cwd,
					signal: ac.signal,
					onEvent: (event) => {
						switch (event.type) {
							case "agent_start":
								push("◉ agent_start");
								break;
							case "message_start":
								textBuffer = "";
								push("▸ message_start");
								break;
							case "message_update": {
								const ame = event.assistantMessageEvent;
								if (ame?.type === "text_delta" && typeof ame.delta === "string") {
									textBuffer += ame.delta;
									refreshWidget();
								} else if (ame?.type === "thinking_delta") {
									push("💭 thinking…");
								}
								break;
							}
							case "tool_execution_start":
								lastToolName = event.toolName;
								push(`🔧 tool_call · ${lastToolName}`);
								ctx.ui.setStatus?.(
									STATUS_KEY,
									`subagent: ${parsed.persona.name} · turn ${turn} · tool: ${lastToolName}`,
								);
								break;
							case "tool_execution_update":
								refreshWidget();
								break;
							case "tool_execution_end": {
								const verdict = event.isError ? "✗" : "✓";
								push(`${verdict} tool_end · ${lastToolName}`);
								break;
							}
							case "message_end":
								push("◼ message_end");
								break;
							case "turn_end": {
								turn++;
								const u = (event.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined)?.usage;
								const usageStr = u
									? ` · ↑${u.input ?? 0} ↓${u.output ?? 0}` +
										(u.cost?.total ? ` $${u.cost.total.toFixed(4)}` : "")
									: "";
								push(`── turn ${turn}${usageStr} ──`);
								textBuffer = "";
								break;
							}
							case "agent_end":
								push("◉ agent_end");
								break;
						}
					},
				});

				ctx.ui.setStatus?.(STATUS_KEY, undefined);
				ctx.ui.setWidget?.(STATUS_KEY, undefined);

				if (result.exitCode !== 0) {
					ctx.ui.notify(
						`× /test-orchestrate — subagent exited ${result.exitCode}` +
							(result.errorMessage ? `: ${result.errorMessage}` : "") +
							(result.stopReason ? ` [${result.stopReason}]` : ""),
						"error",
					);
					return;
				}

				const finalOutput = getFinalOutput(result.messages);
				const usage = result.usage;
				const summary = [
					`〇 /test-orchestrate — ${parsed.persona.name} done.`,
					`Turns: ${usage.turns}  ↑${usage.input}  ↓${usage.output}  R${usage.cacheRead}  W${usage.cacheWrite}  $${usage.cost.toFixed(4)}`,
					`Model: ${result.model ?? "unknown"}`,
					"",
					"── Output ──",
					finalOutput || "(no assistant text returned)",
				].join("\n");

				ctx.ui.notify(summary, "info");
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.setStatus?.(STATUS_KEY, undefined);
				ctx.ui.setWidget?.(STATUS_KEY, undefined);
				ctx.ui.notify(`× /test-orchestrate — harness error: ${e.message ?? "unknown"}`, "error");
			}
		},
	});
}
