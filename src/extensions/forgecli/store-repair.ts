// forge:store-repair — native kickoff handler (FORGE-S23-T11).
//
// Replaces the auto-generated stub previously installed by
// registerAllForgeCommands (forge-commands.ts). Kickoff Shim archetype
// (Pack-04 + Pack-06): single LLM handoff in current context, no fork.
//
// --dry-run flag is forwarded in the kickoff body so the LLM calls
// validate-store --dry-run and skips write phases accordingly.
//
// Workflow source: <forgeRoot>/commands/store-repair.md (command file).
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

import { sendKickoff } from "./kickoff.js";

// ── Argv parsing ──────────────────────────────────────────────────────────

export interface ParsedStoreRepairArgs {
	dryRun: boolean;
	seed: string;
	sourceLabel: string;
}

export function parseStoreRepairArgs(rawArgs: string, cwd: string): ParsedStoreRepairArgs {
	const trimmed = (rawArgs ?? "").trim();
	const result: ParsedStoreRepairArgs = {
		dryRun: false,
		seed: "",
		sourceLabel: "",
	};

	if (!trimmed) {
		result.sourceLabel = "(no args — full repair run)";
		return result;
	}

	const tokens = trimmed.split(/\s+/);
	const remaining: string[] = [];
	for (const tok of tokens) {
		if (tok === "--dry-run") {
			result.dryRun = true;
		} else {
			remaining.push(tok);
		}
	}

	const tail = remaining.join(" ").trim();
	if (tail.startsWith("@")) {
		const ref = tail.slice(1).trim();
		const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
		result.seed = fs.readFileSync(filePath, "utf8");
		result.sourceLabel = `(seed from file: ${ref})`;
	} else if (tail) {
		result.seed = tail;
		result.sourceLabel = "(seed from inline text)";
	} else {
		result.sourceLabel = result.dryRun ? "(--dry-run mode)" : "(no args — full repair run)";
	}

	return result;
}

// ── Kickoff composition ───────────────────────────────────────────────────

export interface ComposeStoreRepairKickoffOpts {
	commandMd: string;
	parsed: ParsedStoreRepairArgs;
}

export function composeStoreRepairKickoff(opts: ComposeStoreRepairKickoffOpts): string {
	const { commandMd, parsed } = opts;

	const sections: string[] = ["# /forge:repair", ""];
	sections.push("## Dispatch", "");
	sections.push("Diagnose and repair the Forge JSON store. Run the repair workflow below. Specifically:");
	sections.push("");
	if (parsed.dryRun) {
		sections.push(
			"**`--dry-run` mode.** Preview all repairs without writing anything. " +
				"In Phase 2 (LLM repair) and Phase 3 (final validation), show what would change but skip all writes. " +
				"Skip Phase 4 verification (nothing changed).",
		);
	} else {
		sections.push("Full repair mode: diagnose, propose fixes, apply approved repairs, verify.");
	}
	sections.push("", "Use `forge_store` for all store reads and writes (never raw file writes to `.forge/store/`).");

	sections.push("", "---", "", "## Command", "", commandMd.trim(), "", "---");

	if (parsed.seed) {
		sections.push("", `## Additional Context — ${parsed.sourceLabel}`, "", parsed.seed.trim());
	}

	return sections.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────

const COMMAND_NAME = "store-repair";

export interface RegisterStoreRepairOptions {
	forgeRoot: string | null;
	cwd?: string;
}

export function registerStoreRepair(pi: ExtensionAPI, options: RegisterStoreRepairOptions): void {
	pi.registerCommand("forge:repair", {
		description:
			"Diagnose and repair corrupted Forge store records. " +
			"Usage: /forge:repair [--dry-run]. " +
			"--dry-run shows what would be repaired without making changes.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const { forgeRoot } = options;
			const cwd = options.cwd ?? process.cwd();

			if (!forgeRoot) {
				ctx.ui.notify("× forge:repair — no Forge project at cwd; run /forge:init to bootstrap", "warning");
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
						`× forge:repair — command file not found at commands/${COMMAND_NAME}.md; run /forge:init or /forge:rebuild first.`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:repair — failed to read command file: ${e.message ?? "unknown error"}`,
						"error",
					);
				}
				return;
			}

			let parsed: ParsedStoreRepairArgs;
			try {
				parsed = parseStoreRepairArgs(args, cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:repair — failed to parse args: ${e.message ?? "unknown"}`, "error");
				return;
			}

			const kickoff = composeStoreRepairKickoff({ commandMd, parsed });
			sendKickoff(pi, kickoff);
		},
	});
}
