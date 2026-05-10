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
//
// Phase G (FORGE-S17-T02): registerAllForgeCommands enumerates every
// *.md under dist/forge-payload/.base-pack/commands/ and registers each
// as a pi command. Real handlers for init/health/refresh-kb-links are
// wired separately; all others emit advisory stubs.

import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runHealthCheck } from "./health-check.js";
import { runRefreshKbLinks } from "./refresh-kb-links.js";

// Resolve the package root for bundle path resolution
const _PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

	// /forge:update is registered in index.ts via registerForgeUpdateCommand
	// (FORGE-S16-T15) so it works inside or outside a Forge project.

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

// ── Phase G: registerAllForgeCommands (FORGE-S17-T02) ─────────────────────
// Enumerate every *.md under dist/forge-payload/.base-pack/commands/ at
// runtime, parse YAML frontmatter (name + description), and register each
// via pi.registerCommand(). Real handlers for init/health/refresh-kb-links
// are deferred to their dedicated modules (called before this function).
// All remaining commands get advisory stub handlers.
//
// This function is called AFTER registerForgeInit(pi) and registerForgeCommands()
// so that real handlers (registered first) are not overwritten.

/** Parse YAML frontmatter from a markdown file. Returns name and description or null. */
function parseFrontmatter(content: string): { name: string; description: string } | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("---", 3);
	if (end === -1) return null;
	const block = content.slice(3, end);
	let name = "";
	let description = "";
	for (const line of block.split("\n")) {
		const m = line.match(/^(\w+):\s*(.+)$/);
		if (!m) continue;
		if (m[1] === "name") name = m[2].trim();
		if (m[1] === "description") description = m[2].trim();
	}
	if (!name) return null;
	return { name, description };
}

/**
 * Commands that have real handlers registered by other modules OR explicitly by registerAllForgeCommands.
 * Formerly REAL_HANDLERS — renamed to EXPLICITLY_REGISTERED_NAMES per FORGE-S19-T02 AC#1.
 * Internal-only; not part of the public API.
 */
const EXPLICITLY_REGISTERED_NAMES = new Set([
	"forge:init",
	"forge:health",
	"forge:ask",
	"forge:config",
	"forge:status",
	"forge:update",
	"forge:refresh-kb-links",
	"forge:enhance",
	"forge:plan", // FORGE-S20-T05: real handler registered in plan.ts
	"forge:implement", // FORGE-S20-T06: real handler registered in implement.ts
	"forge:sprint-intake", // FORGE-S19-T01: real handler registered in sprint-intake.ts
	"forge:sprint-plan", // FORGE-S19-T02: real handler registered in sprint-plan.ts
	"forge:read", // Real handler registered in index.ts
]);

// Alias for backwards-compat with tests that reference REAL_HANDLERS directly.
// Will be removed after all test references are updated.
const REAL_HANDLERS = EXPLICITLY_REGISTERED_NAMES;

export interface RegisterAllOptions {
	/** Absolute path to dist/forge-payload/ (containing .base-pack/commands/). */
	bundlePayloadRoot: string;
	/** Current working directory (for health check). */
	cwd?: string;
	/** Absolute path to dist/forge-payload/ for health check bundle root. */
	bundleRoot?: string;
}

/**
 * Register all forge commands from the bundled .base-pack/commands/ directory.
 * Commands already registered (real handlers) are skipped.
 * Returns the number of commands registered.
 */
export function registerAllForgeCommands(pi: ExtensionAPI, options: RegisterAllOptions): number {
	const commandsDir = path.join(options.bundlePayloadRoot, ".base-pack", "commands");

	let commandFiles: string[];
	try {
		commandFiles = fsSync.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
	} catch {
		// .base-pack not yet built — skip gracefully
		return 0;
	}

	let registered = 0;

	for (const file of commandFiles) {
		const filePath = path.join(commandsDir, file);
		let content: string;
		try {
			content = fsSync.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const meta = parseFrontmatter(content);
		if (!meta) continue;

		const commandName = `forge:${meta.name}`;

		// Skip commands that already have real handlers
		if (REAL_HANDLERS.has(commandName)) continue;

		// Register stub
		const capturedName = commandName;
		pi.registerCommand(capturedName, {
			description: meta.description || `Forge: ${meta.name}`,
			async handler(_args, ctx) {
				ctx.ui.notify(`〇 ${capturedName} — full implementation in S18+.`, "info");
			},
		});

		registered++;
	}

	// Register /forge:refresh-kb-links with real handler (Phase G)
	const capturedCwd = options.cwd ?? process.cwd();
	pi.registerCommand("forge:refresh-kb-links", {
		description: "Refresh Forge KB and workflow links in agent instruction files",
		async handler(_args, ctx) {
			ctx.ui.setStatus?.("forge:refresh-kb-links", "Refreshing KB links…");
			try {
				const result = await runRefreshKbLinks(capturedCwd);
				for (const msg of result.messages) {
					ctx.ui.notify(msg, "info");
				}
				if (result.filesUpdated === 0 && result.filesSkipped > 0) {
					ctx.ui.notify("forge:refresh-kb-links — all agent instruction files already up to date.", "info");
				}
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`forge:refresh-kb-links error: ${e.message ?? "unknown"}`, "error");
			} finally {
				ctx.ui.setStatus?.("forge:refresh-kb-links", undefined);
			}
		},
	});

	// /forge:enhance: real native kickoff handler is registered in index.ts via
	// registerEnhance(pi) — FORGE-S20-T04. The previous sentinel-writing stub
	// has been retired. EXPLICITLY_REGISTERED_NAMES still lists "forge:enhance"
	// so the auto-stub loop above skips it.
	//
	// /forge:plan: real native kickoff handler is registered in index.ts via
	// registerPlan(pi) — FORGE-S20-T05. EXPLICITLY_REGISTERED_NAMES lists
	// "forge:plan" so the auto-stub loop above skips it. Prompt-injection
	// fallback was DELETED per T05 AC#4 (no FORGE_LEGACY_KICKOFF flag).
	//
	// /forge:implement: real native kickoff handler is registered in index.ts
	// via registerImplement(pi) — FORGE-S20-T06. EXPLICITLY_REGISTERED_NAMES
	// lists "forge:implement" so the auto-stub loop above skips it.
	// Prompt-injection fallback was DELETED per T06 AC#4 (no
	// FORGE_LEGACY_KICKOFF flag).

	return registered;
}

// ── Test helpers ─────────────────────────────────────────────────────────────
// Internal — exported only for unit tests. Not part of the public API.
export const __test__ = {
	resetTomoshibiState,
	getTomoshibiPending: () => tomoshibiPending,
	parseFrontmatter,
	REAL_HANDLERS,
	EXPLICITLY_REGISTERED_NAMES,
};
