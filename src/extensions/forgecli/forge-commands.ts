// Production forge slash-command wrappers — FORGE-S16-T04.
//
// Registers /forge:* slash commands on the pi ExtensionAPI:
//   - forge:health, forge:config, forge:status — delegate to the
//     forge plugin's commands/<name>.md by sending its body as a user
//     message. This mirrors how Claude Code expands a slash command.
//   - forge:ask — sets a one-turn gate; a before_agent_start handler
//     replaces the system prompt with the vendored Tomoshibi persona
//     for that turn (R5 spike pattern).
//   - forge:update — registered as a stub here; T15 replaces the
//     handler with the interactive guided-upgrade flow.
//
// Q14 contract: every command except /forge:init no-ops gracefully
// outside a Forge project with a notify pointing at /forge:init.
// /forge:init is registered in index.ts (unconditional, AC#4 from T02).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface RegisterOptions {
	/** Absolute path to the installed forge plugin root, or null when outside a Forge project. */
	forgeRoot: string | null;
	/** Directory containing vendored prompt files (resolves to <package>/prompts at runtime). */
	promptsRoot: string;
}

// Tomoshibi gate — flipped true by /forge:ask, consumed by the
// before_agent_start handler on the next turn. Module-private state is
// safe under pi turn semantics: pi serialises agent turns, so the gate
// cannot race with itself.
let tomoshibiPending = false;
let cachedTomoshibiPrompt: string | null = null;

function resetTomoshibiState(): void {
	tomoshibiPending = false;
	cachedTomoshibiPrompt = null;
}

// Helper: emit the Q14 graceful no-op for commands invoked outside a Forge project.
function outsideProjectNoOp(commandName: string, ctx: ExtensionCommandContext): void {
	ctx.ui.notify(`forge:${commandName} — no Forge project at cwd; run /forge:init to bootstrap`, "warning");
}

// Helper: read <forgeRoot>/commands/<name>.md and forward its body to the agent
// as a user message, prefixed with the slash invocation for traceability.
// `sendUserMessage` lives on `ExtensionAPI` (pi.sendUserMessage), not on
// `ExtensionCommandContext` — see pi-coding-agent types.d.ts:841.
async function delegateMarkdownCommand(
	pi: ExtensionAPI,
	forgeRoot: string,
	commandName: string,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const file = path.join(forgeRoot, "commands", `${commandName}.md`);
	let body: string;
	try {
		body = await fs.readFile(file, "utf8");
	} catch (err: unknown) {
		const e = err as { code?: string; message?: string };
		// ENOENT for /forge:status is expected on forge<=0.40.x; caller decides fallback.
		if (e.code === "ENOENT") {
			throw Object.assign(new Error(`command markdown not found: ${file}`), { code: "ENOENT" });
		}
		ctx.ui.notify(`forge:${commandName} — failed to read ${file}: ${e.message ?? "unknown error"}`, "error");
		return;
	}
	const invocation = args.trim() ? `/forge:${commandName} ${args.trim()}` : `/forge:${commandName}`;
	pi.sendUserMessage(`${invocation}\n\n${body}`);
}

export function registerForgeCommands(pi: ExtensionAPI, options: RegisterOptions): void {
	const { forgeRoot, promptsRoot } = options;

	// ── Tomoshibi injector ────────────────────────────────────────────────────
	// Registered unconditionally so /forge:ask works inside or outside a Forge
	// project. The injector is gated by tomoshibiPending — it is a no-op on
	// every other turn.
	pi.on("before_agent_start", async () => {
		if (!tomoshibiPending) return;
		tomoshibiPending = false;
		if (cachedTomoshibiPrompt === null) {
			const file = path.join(promptsRoot, "tomoshibi.md");
			try {
				cachedTomoshibiPrompt = await fs.readFile(file, "utf8");
			} catch (err: unknown) {
				const e = err as { message?: string };
				console.error(`[forgecli] failed to load tomoshibi prompt: ${e.message ?? "unknown error"}`);
				return;
			}
		}
		return { systemPrompt: cachedTomoshibiPrompt };
	});

	// ── /forge:health ─────────────────────────────────────────────────────────
	pi.registerCommand("forge:health", {
		description: "Assess the project's SDLC knowledge base — config, KB freshness, store integrity",
		async handler(args, ctx) {
			if (!forgeRoot) return outsideProjectNoOp("health", ctx);
			await delegateMarkdownCommand(pi, forgeRoot, "health", args, ctx);
		},
	});

	// ── /forge:config ─────────────────────────────────────────────────────────
	pi.registerCommand("forge:config", {
		description: "Inspect or change Forge project configuration",
		async handler(args, ctx) {
			if (!forgeRoot) return outsideProjectNoOp("config", ctx);
			await delegateMarkdownCommand(pi, forgeRoot, "config", args, ctx);
		},
	});

	// ── /forge:ask ────────────────────────────────────────────────────────────
	// Tomoshibi entry point. The before_agent_start handler picks up the gate
	// and injects the persona as the system prompt for one turn. /forge:ask
	// works outside a Forge project too — Tomoshibi's setup steps already use
	// `2>/dev/null` and degrade gracefully when manage-config.cjs is missing.
	pi.registerCommand("forge:ask", {
		description: "Ask Forge anything — project status, config, workflows, commands, version",
		async handler(args, _ctx) {
			tomoshibiPending = true;
			const question = args.trim();
			const hint = forgeRoot ? "" : "\n\n(Note: no .forge/ at cwd — answer Forge knowledge questions only.)";
			pi.sendUserMessage(question.length > 0 ? `${question}${hint}` : `Show your capabilities.${hint}`);
		},
	});

	// ── /forge:update ─────────────────────────────────────────────────────────
	// Stub — T15 replaces this with the guided-upgrade flow.
	pi.registerCommand("forge:update", {
		description: "Guided upgrade for forgecli + bundled forge payload (T15 implements full flow)",
		async handler(_args, ctx) {
			if (!forgeRoot) return outsideProjectNoOp("update", ctx);
			ctx.ui.notify(
				"forge:update — interactive guided upgrade lands in FORGE-S16-T15. " +
					"For now: `npm i -g @entelligentsia/forgecli@latest`, then re-run /forge:update once T15 ships.",
				"info",
			);
		},
	});

	// ── /forge:status ─────────────────────────────────────────────────────────
	// Delegates to the plugin's commands/status.md if shipped, otherwise emits
	// a fallback notify. forge<=0.40.x does not ship status.md yet.
	pi.registerCommand("forge:status", {
		description: "Sprint and task summary widget",
		async handler(args, ctx) {
			if (!forgeRoot) return outsideProjectNoOp("status", ctx);
			try {
				await delegateMarkdownCommand(pi, forgeRoot, "status", args, ctx);
			} catch (err: unknown) {
				const e = err as { code?: string };
				if (e.code === "ENOENT") {
					ctx.ui.notify(
						"forge:status — sprint/task widget ships with the next forge plugin release; " +
							"use /forge:health for now.",
						"info",
					);
					return;
				}
				throw err;
			}
		},
	});
}

// ── Test helpers ─────────────────────────────────────────────────────────────
// Internal — exported only for unit tests. Not part of the public API.
export const __test__ = {
	resetTomoshibiState,
	getTomoshibiPending: () => tomoshibiPending,
};
