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
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

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
}

export interface RunSubagentOptions {
	persona: ForgePersona;
	task: string;
	cwd?: string;
	signal?: AbortSignal;
	onEvent?: (event: AgentSessionEvent) => void;
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
	const { persona, task, cwd, signal, onEvent } = opts;

	const result: SubagentResult = {
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: persona.model,
	};

	// ── spawn channel ─────────────────────────────────────────────────────
	const cwdAbs = cwd ?? process.cwd();
	const loader = new DefaultResourceLoader({
		cwd: cwdAbs,
		agentDir: getAgentDir(),
		systemPromptOverride: () => persona.systemPrompt,
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
	return result;
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
