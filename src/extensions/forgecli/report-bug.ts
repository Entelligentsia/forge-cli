// forge:report-bug — native kickoff handler (FORGE-S23-T11).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// Pre-flights: gh auth status (spawnSync, argv-array, IL6). On failure,
// notifies and returns — no kickoff sent.
//
// Bug repo is configurable (AC#5):
//   1. FORGE_BUG_REPO env var
//   2. config.json bugs.repo field (if present)
//   3. default: "Entelligentsia/forge"
//
// Workflow source: <forgeRoot>/commands/report-bug.md (command file).
// File-existence check only — command files lack Pack-06 workflow markers.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL4 — no JSON.stringify-into-subagent dispatch.
//   IL6 — no shell-string interpolation; spawnSync uses argv arrays.
//   IL7 — every failure path emits ctx.ui.notify and returns; no silent
//         continuation.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { sendKickoff } from "./kickoff.js";

// ── Repo resolution ───────────────────────────────────────────────────────

const DEFAULT_BUG_REPO = "Entelligentsia/forge";

export function resolveBugRepo(cwd: string): string {
	// 1. FORGE_BUG_REPO env var
	const fromEnv = process.env["FORGE_BUG_REPO"];
	if (fromEnv?.trim()) return fromEnv.trim();

	// 2. config.json bugs.repo field
	try {
		const configPath = path.join(cwd, ".forge", "config.json");
		const raw = fs.readFileSync(configPath, "utf8");
		const config = JSON.parse(raw) as Record<string, unknown>;
		const bugs = config["bugs"] as Record<string, unknown> | undefined;
		const repo = bugs?.["repo"];
		if (typeof repo === "string" && repo.trim()) return repo.trim();
	} catch {
		// config absent or unreadable — fall through to default
	}

	// 3. default
	return DEFAULT_BUG_REPO;
}

// ── Argv parsing ──────────────────────────────────────────────────────────

export interface ParsedReportBugArgs {
	mode: "empty" | "file" | "text";
	symptomText: string;
	sourceLabel: string;
}

export function parseReportBugArgs(rawArgs: string, cwd: string): ParsedReportBugArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (!trimmed) {
		return { mode: "empty", symptomText: "", sourceLabel: "(no symptom — LLM will ask)" };
	}
	if (trimmed.startsWith("@")) {
		const ref = trimmed.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		const symptomText = fs.readFileSync(filePath, "utf8");
		return { mode: "file", symptomText, sourceLabel: `(symptom from file: ${ref})` };
	}
	return { mode: "text", symptomText: trimmed, sourceLabel: "(symptom from inline text)" };
}

// ── gh auth pre-flight ────────────────────────────────────────────────────

export interface GhAuthResult {
	ok: boolean;
	output: string;
}

export function checkGhAuth(): GhAuthResult {
	// IL6: argv-array, no shell interpolation
	const result = spawnSync("gh", ["auth", "status"], {
		encoding: "utf8",
		timeout: 10_000,
	});
	const ok = result.status === 0 && !result.error;
	const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
	return { ok, output: output.slice(0, 300) }; // cap for kickoff body
}

// ── Kickoff composition ───────────────────────────────────────────────────

export interface ComposeReportBugKickoffOpts {
	commandMd: string;
	parsed: ParsedReportBugArgs;
	bugRepo: string;
	ghAuthOutput: string;
}

export function composeReportBugKickoff(opts: ComposeReportBugKickoffOpts): string {
	const { commandMd, parsed, bugRepo, ghAuthOutput } = opts;

	const sections: string[] = ["# /forge:report-bug", ""];
	sections.push("## Dispatch", "");
	sections.push("File a bug report against Forge (not your project). Follow the command steps below. Specifically:");
	sections.push("");
	sections.push(
		`1. File the issue to: \`${bugRepo}\` (override via \`FORGE_BUG_REPO\` env or \`config.json\` \`bugs.repo\` field).`,
	);
	sections.push("2. `gh` is authenticated (pre-flight passed). Use it to file the issue.");
	if (ghAuthOutput) {
		sections.push(`3. Auth context: \`${ghAuthOutput.replace(/\n/g, " ").slice(0, 200)}\``);
	}
	sections.push("4. Gather automatic context (forge version, node version, OS) per Step 2 in the command.");
	sections.push("5. Draft the issue body, show it to the user for review, then file with `gh issue create`.");

	sections.push("", "---", "", "## Command", "", commandMd.trim(), "", "---");

	if (parsed.mode === "empty") {
		sections.push("", "## Input", "", "(no symptom provided — ask the user to describe the bug)");
	} else {
		sections.push("", `## Input — ${parsed.sourceLabel}`, "", parsed.symptomText.trim());
	}

	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const COMMAND_NAME = "report-bug";

export interface RegisterReportBugOptions {
	forgeRoot: string | null;
	cwd?: string;
}

export function registerReportBug(pi: ExtensionAPI, options: RegisterReportBugOptions): void {
	pi.registerCommand("forge:report-bug", {
		description:
			"File a bug against Forge itself as a GitHub issue. " +
			"Usage: /forge:report-bug [@<file> | <symptom description>]. " +
			"Requires `gh` to be installed and authenticated. " +
			"Target repo: FORGE_BUG_REPO env | config.json bugs.repo | Entelligentsia/forge.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const { forgeRoot } = options;
			const cwd = options.cwd ?? process.cwd();

			// gh auth pre-flight (IL6: argv-array)
			const ghAuth = checkGhAuth();
			if (!ghAuth.ok) {
				ctx.ui.notify(
					"× forge:report-bug — gh is not authenticated. Install gh (https://cli.github.com) and run `gh auth login` first.",
					"error",
				);
				return;
			}

			if (!forgeRoot) {
				// report-bug works outside a Forge project (reporting bugs in Forge itself)
				// but we still need the command file from the bundled payload
			}

			// Resolve command file from forgeRoot (bundled payload) or fall back to graceful error
			let commandMd: string;
			if (forgeRoot) {
				const commandPath = path.join(forgeRoot, "commands", `${COMMAND_NAME}.md`);
				try {
					commandMd = fs.readFileSync(commandPath, "utf8");
				} catch (err: unknown) {
					const e = err as { code?: string; message?: string };
					if (e.code === "ENOENT") {
						ctx.ui.notify(
							`× forge:report-bug — command file not found at commands/${COMMAND_NAME}.md; run /forge:init or /forge:rebuild first.`,
							"error",
						);
					} else {
						ctx.ui.notify(
							`× forge:report-bug — failed to read command file: ${e.message ?? "unknown error"}`,
							"error",
						);
					}
					return;
				}
			} else {
				ctx.ui.notify(
					"× forge:report-bug — no Forge project at cwd; run /forge:init to bootstrap before reporting bugs.",
					"warning",
				);
				return;
			}

			let parsed: ParsedReportBugArgs;
			try {
				parsed = parseReportBugArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:report-bug — failed to parse args: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const bugRepo = resolveBugRepo(cwd);
			const kickoff = composeReportBugKickoff({
				commandMd,
				parsed,
				bugRepo,
				ghAuthOutput: ghAuth.output,
			});
			sendKickoff(pi, kickoff);
		},
	});
}
