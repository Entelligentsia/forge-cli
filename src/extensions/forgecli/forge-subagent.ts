// forge-subagent.ts — in-process Forge subagent harness via pi SDK.
//
// Three channels (per design discussion):
//   spawn     → createAgentSession({ resourceLoader, ... })
//   monitor   → session.subscribe(listener) — assistant messages, tool calls, usage
//   terminate → session.abort() (also via AbortSignal)
//
// "steer" channel intentionally unused: Forge orchestrators dispatch one-shot
// per phase / per task. Revision/iterate = TS state machine spawning a fresh
// session, not mid-stream steering.
//
// Personas read from .forge/personas/*.md (already materialized by /forge:init).
// Optional frontmatter (model, tools, description) — defaults applied when absent.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/
//   IL7 — every failure path returns a typed result; no silent continuation

import * as fs from "node:fs";
import * as path from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	parseFrontmatter,
	SessionManager,
	type AgentSessionEvent,
} from "@entelligentsia/pi-coding-agent";
import type { Message } from "@entelligentsia/pi-ai";
import { buildProjectOrientation } from "./project-orientation.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ForgePersona {
	name: string;
	description: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	filePath: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentResult {
	exitCode: 0 | 1;
	messages: Message[];
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	provider?: string;
}

export interface RunSubagentOptions {
	persona: ForgePersona;
	task: string;
	cwd?: string;
	signal?: AbortSignal;
	/**
	 * Forge root directory. When provided, FORGE_ROOT is set in the subagent's
	 * process environment so that $FORGE_ROOT in workflow tool paths resolves
	 * correctly. Without this, subagent bash calls to store-cli etc. will fail
	 * with "Cannot find module '/tools/store-cli.cjs'".
	 */
	forgeRoot?: string;
	onEvent?: (event: AgentSessionEvent) => void;
	/**
	 * Optional tag included in the auto-exported transcript filename for
	 * greppability — e.g. `${taskId}__${phaseRole}`. Stripped to a safe
	 * filename slug. See forge-cli#8.
	 */
	exportTag?: string;
}

// ── Persona discovery ─────────────────────────────────────────────────────

/**
 * Load a Forge persona from `.forge/personas/<name>.md`.
 *
 * Frontmatter (optional, all keys may be missing):
 *   description: short role summary
 *   model: pi model id (default: project default)
 *   tools: comma-separated tool list (default: all coding tools)
 *
 * If frontmatter absent, name derives from filename and the entire file body
 * is used as the system prompt.
 */
export function loadForgePersona(name: string, cwd: string): ForgePersona {
	const filePath = path.join(cwd, ".forge", "personas", `${name}.md`);
	const raw = fs.readFileSync(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(raw);

	const tools = frontmatter.tools
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	return {
		name: frontmatter.name ?? name,
		description: frontmatter.description ?? `Forge ${name} persona`,
		model: frontmatter.model,
		tools: tools && tools.length > 0 ? tools : undefined,
		systemPrompt: body,
		filePath,
	};
}

// ── Empty-usage helper ────────────────────────────────────────────────────

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ── Run a subagent (spawn + monitor + terminate channels) ────────────────

/**
 * Spawn a Forge subagent in-process via pi SDK and run a task to completion.
 *
 * Returns a SubagentResult after `session.prompt()` resolves. If `signal`
 * fires, the session is aborted and the call returns with exitCode=1 and
 * stopReason="aborted".
 *
 * Usage events are aggregated from `turn_end` (per-turn assistant message
 * usage). Total contextTokens are sourced from the latest turn.
 */
export async function runForgeSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
	const { persona, task, cwd, signal, onEvent, forgeRoot } = opts;

	// Set FORGE_ROOT in the process environment so the subagent's bash tool
	// can resolve $FORGE_ROOT paths. This is critical for workflow commands
	// that cite $FORGE_ROOT/tools/store-cli.cjs etc. Without it, every
	// subagent that shells out to store-cli fails.
	if (forgeRoot) {
		process.env.FORGE_ROOT = forgeRoot;
	}

	const result: SubagentResult = {
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: persona.model,
	};

	// ── spawn channel ─────────────────────────────────────────────────────
	const cwdAbs = cwd ?? process.cwd();
	// Project orientation is prepended to the persona system prompt for every
	// subagent dispatch — see project-orientation.ts and forge-cli#6.
	const orientation = buildProjectOrientation(cwdAbs);
	const loader = new DefaultResourceLoader({
		cwd: cwdAbs,
		agentDir: getAgentDir(),
		systemPromptOverride: () => `${orientation}\n${persona.systemPrompt}`,
		// Persona-only — suppress global pi extensions/skills/prompts to keep
		// subagent context lean and deterministic.
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await loader.reload();

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);

	const { session } = await createAgentSession({
		sessionManager: SessionManager.inMemory(),
		authStorage,
		modelRegistry,
		resourceLoader: loader,
		// Persona frontmatter `tools:` is a name allowlist (read/bash/edit/write/...).
		// Omit field → pi enables default built-ins (read, bash, edit, write).
		tools: persona.tools,
	});

	// ── terminate channel ────────────────────────────────────────────────
	const onAbort = () => {
		void session.abort();
	};
	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	// ── monitor channel ───────────────────────────────────────────────────
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (onEvent) onEvent(event);

		if (event.type === "turn_end" && event.message) {
			const msg = event.message as Message;
			result.messages.push(msg);

			if (msg.role === "assistant") {
				result.usage.turns++;
				const usage = msg.usage;
				if (usage) {
					result.usage.input += usage.input ?? 0;
					result.usage.output += usage.output ?? 0;
					result.usage.cacheRead += usage.cacheRead ?? 0;
					result.usage.cacheWrite += usage.cacheWrite ?? 0;
					result.usage.cost += usage.cost?.total ?? 0;
					result.usage.contextTokens = usage.totalTokens ?? result.usage.contextTokens;
				}
				if (!result.model && msg.model) result.model = msg.model;
				if (!result.provider && msg.provider) result.provider = msg.provider;
				if (msg.stopReason) result.stopReason = msg.stopReason;
				if (msg.errorMessage) result.errorMessage = msg.errorMessage;
			}
		}

		if (event.type === "turn_end" && event.toolResults) {
			for (const tr of event.toolResults) {
				result.messages.push(tr as Message);
			}
		}
	});

	try {
		await session.prompt(task);
	} catch (err: unknown) {
		const e = err as { message?: string };
		result.exitCode = 1;
		result.errorMessage = result.errorMessage ?? e.message ?? "session.prompt threw";
	} finally {
		unsubscribe();
		if (signal) signal.removeEventListener("abort", onAbort);
		session.dispose();
	}

	if (result.stopReason === "error" || result.stopReason === "aborted") {
		result.exitCode = 1;
	}

	// ── Auto-export subagent transcript (forge-cli#8) ────────────────────
	// Default-on while stabilizing. Failure is non-fatal — log to stderr
	// and continue. Filename includes optional tag for greppability.
	try {
		writeSubagentTranscript({
			cwd: cwdAbs,
			persona: persona.name,
			tag: opts.exportTag,
			result,
		});
	} catch (err: unknown) {
		const e = err as { message?: string };
		process.stderr.write(
			`[forge-subagent] transcript export failed (non-fatal): ${e.message ?? "unknown"}\n`,
		);
	}

	return result;
}

// ── Transcript auto-export (forge-cli#8) ─────────────────────────────────

interface WriteTranscriptOptions {
	cwd: string;
	persona: string;
	tag?: string;
	result: SubagentResult;
}

function sanitizeForFilename(s: string): string {
	return s
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.replace(/\.{2,}/g, "_")
		.slice(0, 80);
}

export function writeSubagentTranscript(opts: WriteTranscriptOptions): string {
	const { cwd, persona, tag, result } = opts;
	const iso = new Date().toISOString().replace(/[:.]/g, "-");
	const tagSegment = tag ? `__${sanitizeForFilename(tag)}` : "";
	const filename = `forge-subagent-${iso}__${sanitizeForFilename(persona)}${tagSegment}.json`;
	const outPath = path.join(cwd, filename);
	const payload = {
		schema: "forge-subagent-transcript/v1",
		timestamp: new Date().toISOString(),
		cwd,
		persona,
		tag: tag ?? null,
		model: result.model ?? null,
		provider: result.provider ?? null,
		exitCode: result.exitCode,
		stopReason: result.stopReason ?? null,
		errorMessage: result.errorMessage ?? null,
		usage: result.usage,
		messageCount: result.messages.length,
		messages: result.messages,
	};
	fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
	return outPath;
}

// ── Final-output helper ──────────────────────────────────────────────────

/** Extract the final assistant text from a SubagentResult. */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}
