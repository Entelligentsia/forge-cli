// sprint-ceremony.ts — sprint completion architect ceremony dispatch
// (Plan 12 §6.2). Extracted from run-sprint.ts (no logic changes) so the
// per-file architectural line cap is satisfied. run-sprint.ts imports
// dispatchSprintCeremony from here and re-exports SprintStreamFnFactory.

import { spawnSync } from "node:child_process";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadLayeredConfig } from "../../config/config-layer.js";
import { lookupPersonaModel } from "../../config/model-resolver.js";
import { AskBroker } from "../../ask-broker.js";
import { loadForgePersona, runForgeSubagent } from "../../forge-subagent.js";
import { type ForgeToolDefs, getSubagentTools } from "../../forge-tools.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";
import { getSessionRegistry } from "../../session-registry.js";
import { attachViewportObserver } from "../../viewport/events.js";

/**
 * Test-only seam (forge-cli#17). Resolves a StreamFn for a given dispatch
 * context — ceremony or per-phase. Production callers leave this undefined.
 */
export type SprintStreamFnFactory = (ctx: {
	kind: "task-phase" | "ceremony";
	persona: string;
	phase?: string;
	taskId?: string;
}) => StreamFn | undefined;

// ── Sprint ceremony dispatch (Plan 12 §6.2) ────────────────────────────────

export type SprintCeremonyResult = {
	verdict: "complete" | "partial" | "revision-required";
	model?: string;
	provider?: string;
	durationMs: number;
	errorMessage?: string;
};

export async function dispatchSprintCeremony(params: {
	sprintId: string;
	mode: "complete" | "partial";
	completedTaskIds: string[];
	pausedAfterIndex?: number;
	cwd: string;
	forgeRoot: string;
	ctx: ExtensionCommandContext;
	registry: ReturnType<typeof getSessionRegistry>;
	streamFnFactory?: SprintStreamFnFactory;
	forgeToolDefs?: ForgeToolDefs;
}): Promise<SprintCeremonyResult> {
	const {
		sprintId,
		mode,
		completedTaskIds,
		pausedAfterIndex,
		cwd,
		forgeRoot,
		ctx,
		registry,
		streamFnFactory,
		forgeToolDefs,
	} = params;
	const startMs = Date.now();

	// Materialized workflow path — already shipped from base pack.
	const workflowName = "architect_review_sprint_completion";
	const personaName = "architect";

	let persona;
	try {
		persona = loadForgePersona(personaName, cwd);
	} catch {
		return {
			verdict: "revision-required",
			durationMs: Date.now() - startMs,
			errorMessage: `architect persona not found`,
		};
	}

	const taskLines = [
		`# Sprint Completion Review — ${sprintId}`,
		``,
		`Mode: ${mode}`,
		`Completed tasks: ${completedTaskIds.join(", ") || "(none)"}`,
	];
	if (pausedAfterIndex !== undefined) {
		taskLines.push(`Paused after task index: ${pausedAfterIndex}`);
	}
	taskLines.push(
		``,
		`Execute the materialized workflow at \`.forge/workflows/${workflowName}.md\`.`,
		`Do not emit any phase event yourself; the orchestrator owns event emission.`,
	);
	const task = taskLines.join("\n");

	// Use a dedicated session id (NOT a taskId) so the thread-switcher renders it
	// as a sprint-scoped chip distinct from per-task sessions.
	const sessionId = `${sprintId}:ceremony`;
	registry.startSession(sessionId);
	registry.startPhase(sessionId, "ceremony", 0);

	// Bridge: register ceremony phase in OrchestratorTree so the dashboard
	// shows the ceremony as a leaf under the sprint root.
	const tree = getOrchestratorTree();
	tree.startNode(sessionId, { parentId: sprintId, label: "ceremony", kind: "leaf" });

	let model: string | undefined;
	let provider: string | undefined;
	let errorMessage: string | undefined;

	const observer = attachViewportObserver({
		registry,
		sessionId,
		phaseRole: "ceremony",
		displayRole: "ceremony",
		beginHeader: `─── sprint ${sprintId} ceremony begin · ${personaName} ───`,
	});

	// Resolve model routing for the ceremony's architect persona (Plan 16 Slice 2).
	// N-B-E: surface schema errors to caller (Decision 9 — orchestrators fail-fast).
	// See doc/decisions/layered-config-error-policy.md.
	const { merged: ceremonyModelConfig, errors: ceremonyCfgErrors } = loadLayeredConfig(cwd);
	if (ceremonyCfgErrors.length > 0) {
		for (const e of ceremonyCfgErrors) {
			ctx.ui.notify(`× forge:run-sprint ceremony — forge-cli config schema error: ${e}`, "error");
		}
		return {
			verdict: "revision-required",
			durationMs: Date.now() - startMs,
			errorMessage: `forge-cli config schema errors: ${ceremonyCfgErrors.join("; ")}`,
		};
	}
	const ceremonyModelLookup = lookupPersonaModel(personaName, "default", ceremonyModelConfig);

	try {
		// Bind the orchestrator's TUI so a forge_ask_user call from the (headless)
		// ceremony subagent is marshalled back here and rendered. Required:
		// getSubagentTools injects forge_ask_user, so an unbound dispatch would make
		// a subagent ask throw. Refcounted + serialised in AskBroker.
		const result = await AskBroker.withUI(ctx.ui, () =>
			runForgeSubagent({
				persona,
				task,
				cwd,
				exportTag: `${sprintId}__ceremony`,
				tailLog: observer.state.tailLog,
				forgeRoot,
				streamFn: streamFnFactory?.({ kind: "ceremony", persona: personaName }),
				// Sprint-scoped prompt-cache key — every subagent spawned across
				// the sprint (ceremonies + per-task phases) shares this namespace
				// so the system-prompt + persona prefix stays warm.
				cacheSessionId: `forge:${sprintId}`,
				onEvent: observer.onEvent,
				requestedModel: ceremonyModelLookup.model,
				modelRegistry: ctx.modelRegistry,
				customTools: forgeToolDefs ? getSubagentTools(forgeToolDefs, persona.name) : undefined,
			}),
		);
		model = result.model;
		provider = result.provider;
		if (result.exitCode !== 0) {
			errorMessage = result.errorMessage ?? "architect subagent exited non-zero";
		}
	} catch (e: unknown) {
		const err = e as { message?: string };
		errorMessage = err?.message ?? "runForgeSubagent threw";
	} finally {
		registry.completeSession(sessionId, errorMessage ? "failed" : "completed");
		tree.completeNode(sessionId, errorMessage ? "failed" : "completed");
	}

	// Parse verdict from store: did the architect actually transition the sprint?
	// The store is the source of truth — verdict text in SPRINT_COMPLETION_REVIEW.md
	// is human-readable but the store status is authoritative.
	let verdict: "complete" | "partial" | "revision-required" = "revision-required";
	const readResult = spawnSync("node", [`${forgeRoot}/tools/store-cli.cjs`, "read", "sprint", sprintId], {
		cwd,
		encoding: "utf8",
	});
	if (readResult.status === 0) {
		try {
			const sprint = JSON.parse(readResult.stdout as string);
			if (sprint.status === "completed") verdict = "complete";
			else if (sprint.status === "partially-completed") verdict = "partial";
			// else: status unchanged → revision-required
		} catch {
			// fall through with revision-required
		}
	}

	return {
		verdict,
		model,
		provider,
		durationMs: Date.now() - startMs,
		errorMessage,
	};
}
