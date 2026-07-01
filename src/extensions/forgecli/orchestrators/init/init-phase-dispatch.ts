// init-phase-dispatch.ts — the single-subagent runner for the /forge:init step
// machine (FORGE-S33-T02, rewritten by FORGE-S35-T02 Slice 1).
//
// Owns model resolution, CallerContextStore + AskBroker wrapping,
// runForgeSubagent dispatch, and the live TUI wiring (SessionRegistry +
// OrchestratorTree + viewport observer) for ONE subagent step. Intra-phase
// routing (fan-out, gate, index/context ordering, retries) now lives in the
// step table (init-steps.ts + run-init-pipeline.ts); this module is a leaf.
//
// The Phase-2 `gate` subagent was DELETED in Slice 1 — its readiness check
// became a deterministic step precondition.
//
// IL10 — NEVER calls store-cli emit; the orchestrator composes and emits phase
// events from result.{model,provider,usage} after each subagent step returns.
//
// Layering: may import from orchestrators/init/ siblings, ../../<peer> modules,
// node:* builtins, @earendil-works/pi-coding-agent types.
// MUST NOT import from forge-init/ (upward) or orchestrators/task/ (lateral).

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { AskBroker } from "../../ask-broker.js";
import { CallerContextStore } from "../../audience-gate.js";
import type { PhaseRole } from "../../subagent/caller-context.js";
import type { MergedConfig } from "../../config/config-layer.js";
import { loadForgePersonaFromDir, runForgeSubagent, type SubagentResult } from "../../forge-subagent.js";
import { getSubagentTools } from "../../forge-tools.js";
import { resolveModelForPhase } from "../../config/model-resolver.js";
import { getSessionRegistry } from "../../session-registry.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";
import { attachViewportObserver } from "../../viewport/events.js";

import { INIT_SESSION_ID, ROLE_TIER } from "./init-phases.js";
import type { RunInitOptions } from "./run-init-types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Inputs required by dispatchSingleAgent. Carries only what one subagent
 * dispatch needs — no phase descriptor (the step table owns routing).
 */
export interface InitDispatchParams {
	opts: RunInitOptions;
	cwd: string;
	ctx: ExtensionCommandContext;
	/** Absolute path to the vendored bundle root (contains init/phases/ + base-pack). */
	bundleRoot: string;
	/** Merged model-routing config from layered config. */
	modelRoutingConfig: MergedConfig;
	/** Raw forge tool definitions (optional — carries forge_ask_user). */
	forgeToolDefs?: Parameters<typeof getSubagentTools>[0];
	/**
	 * Per-dispatch attempt counter keyed by sub-role label, for OrchestratorTree
	 * node identity (`<INIT_SESSION_ID>:<role>:<attempt>`). Mutated by
	 * dispatchSingleAgent so re-dispatches (retries) land on distinct nodes.
	 */
	dispatchCounts: Record<string, number>;
	/** Ordering hint (wave index) for SessionRegistry.startPhase. */
	orderHint: number;
}

// ── Phase-prompt reader ───────────────────────────────────────────────────────

/**
 * Read the phase prompt from the bundled init/phases/ directory.
 * Throws on missing file — caller catches and returns failure.
 */
export function readInitPhasePrompt(bundleRoot: string, phaseNum: 1 | 2): string {
	const phasesDir = path.join(bundleRoot, "init", "phases");
	const pattern = `phase-${phaseNum}-`;
	let files: string[];
	try {
		files = fs.readdirSync(phasesDir);
	} catch (err: unknown) {
		const e = err as { message?: string };
		throw new Error(
			`Cannot read phases dir ${phasesDir}: ${e.message ?? "unknown"}`,
		);
	}
	const filename = files.find((f) => f.startsWith(pattern) && f.endsWith(".md"));
	if (!filename) {
		throw new Error(
			`Phase ${phaseNum} prompt not found in ${phasesDir} (expected: ${pattern}*.md).`,
		);
	}
	return fs.readFileSync(path.join(phasesDir, filename), "utf8");
}

/**
 * Read the shared Phase-2 KB-doc generation procedure (Slice 2 / FORGE-S35-T03).
 * This is `init/generation/generate-kb-doc.md` — the write path, confidence
 * header, verify-back, and not-applicable stub format shared by EVERY Phase-2
 * subagent. It forms the base of every kb-doc / index / context prompt; the
 * per-step substance fragment and the AGENT PARAMS block are appended by the
 * pipeline. Throws on missing file — caller catches and returns failure (IL7).
 */
export function readInitSharedProcedure(bundleRoot: string): string {
	const file = path.join(bundleRoot, "init", "generation", "generate-kb-doc.md");
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err: unknown) {
		const e = err as { message?: string };
		throw new Error(
			`Cannot read shared procedure generate-kb-doc.md at ${file}: ${e.message ?? "unknown"}`,
		);
	}
}

/**
 * Read one per-step substance fragment from `init/phases/phase-2/<name>.md`
 * (Slice 2 / FORGE-S35-T03). `name` is a KB_DOC_ID basename (e.g. "stack",
 * "domain-model") or one of "index" / "context". Each fragment carries only its
 * own docId's topic focus, discovery input, required output, and not-applicable
 * stub — so a subagent never sees a sibling's work. Throws a descriptive error
 * on missing file (naming the fragment) — caller catches and returns failure.
 */
export function readInitPhase2Fragment(bundleRoot: string, name: string): string {
	const file = path.join(bundleRoot, "init", "phases", "phase-2", `${name}.md`);
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err: unknown) {
		const e = err as { message?: string };
		throw new Error(
			`Cannot read Phase-2 substance fragment '${name}' at ${file}: ${e.message ?? "unknown"}`,
		);
	}
}

// ── Model resolution ──────────────────────────────────────────────────────────

/**
 * Resolve model for a sub-role within the init pipeline. Reads the intended
 * tier from ROLE_TIER[modelRole] ("sonnet" / "haiku") and resolves the concrete
 * {provider, model} via resolveModelForPhase, using modelRole as the phase key
 * and the given personaNoun (matching task-phase-dispatch, which passes the
 * role — never a display label — as the phase key). The tier is returned
 * alongside the resolution so callers can surface it via notify. Concrete model
 * still comes from config; resolution is "inherit" (undefined model) when config
 * specifies nothing for the role.
 */
export function resolveInitModel(
	modelRole: string,
	personaNoun: string,
	modelRoutingConfig: MergedConfig,
): ReturnType<typeof resolveModelForPhase> & { tier: "sonnet" | "haiku" | undefined } {
	const tier = ROLE_TIER[modelRole];
	const resolution = resolveModelForPhase("default", modelRole, personaNoun, modelRoutingConfig);
	return { ...resolution, tier };
}

// ── Single-agent dispatch ─────────────────────────────────────────────────────

/**
 * Dispatch a single subagent for the init pipeline and return its SubagentResult.
 * All runForgeSubagent calls are wrapped in CallerContextStore.asSubagent +
 * AskBroker.withUI (IL10 / FORGE-BUG-040 parity). This is the sole subagent
 * runner invoked by the step machine's subagent steps.
 */
export async function dispatchSingleAgent(
	subLabel: string,
	subRole: PhaseRole,
	modelRole: string,
	prompt: string,
	_schema: object | undefined,
	personaNoun: string,
	p: InitDispatchParams,
): Promise<SubagentResult> {
	const { cwd, ctx, opts, modelRoutingConfig, bundleRoot } = p;

	// Init's orchestration personas ship in the bundle's base-pack. `.forge/personas/`
	// is not materialized until Phase 3 — and may be absent entirely on a fresh or
	// reset project (FORGE-BUG: ENOENT on .forge/personas/engineer.md) — so init MUST
	// load its dispatch persona from the bundle, never from cwd/.forge. This mirrors
	// how init already reads its phase prompts from bundleRoot/init/phases/.
	const persona = loadForgePersonaFromDir(personaNoun, path.join(bundleRoot, ".base-pack", "personas"));
	const modelResolution = resolveInitModel(modelRole, personaNoun, modelRoutingConfig);
	const modelLabel = modelResolution.model
		? `${modelResolution.model.provider}:${modelResolution.model.model}`
		: "inherit";
	ctx.ui.notify(
		`  init dispatch: ${subLabel} · role=${modelRole} · tier=${modelResolution.tier ?? "—"} · ` +
		`persona=${personaNoun} · model=${modelLabel} [${modelResolution.source}]`,
		"info",
	);

	// ── Live TUI wiring (parity with task-phase-dispatch.ts) ──────────────────
	// Register this dispatch as a phase in SessionRegistry and a leaf node in
	// OrchestratorTree, then attach a viewport observer so subagent turns/tools/
	// tail stream into the always-mounted chip strip and the /forge:dashboard
	// overlay — the same surfaces run-task/run-sprint/fix-bug light up. Without
	// this, init subagents run headless (no orchestrator subagent TUI).
	const registry = getSessionRegistry();
	const tree = getOrchestratorTree();
	const iteration = (p.dispatchCounts[subLabel] = (p.dispatchCounts[subLabel] ?? 0) + 1);
	const nodeId = `${INIT_SESSION_ID}:${subLabel}:${iteration}`;
	registry.startPhase(INIT_SESSION_ID, subLabel, p.orderHint);
	tree.startNode(nodeId, {
		parentId: INIT_SESSION_ID,
		label: subLabel,
		kind: "leaf",
		promptPreview: prompt,
	});
	const observer = attachViewportObserver({
		registry,
		sessionId: INIT_SESSION_ID,
		phaseRole: subLabel,
		nodeId,
		beginHeader: `─── init ${subLabel} begin · ${INIT_SESSION_ID} ───`,
		notify: (msg, level) => ctx.ui.notify(msg, level),
	});

	let result: SubagentResult;
	try {
		result = await CallerContextStore.asSubagent(subRole, () =>
			AskBroker.withUI(ctx.ui, () =>
				runForgeSubagent({
					persona,
					task: prompt,
					cwd,
					exportTag: `forge-init__${subLabel}`,
					// Shared, stable cache namespace for every init subagent (parity
					// with the task pipeline's `forge:${sprintId}`). On cache-capable
					// providers (Anthropic / OpenAI) this lets each agent's stable
					// system+persona prefix be reused across its many turns instead of
					// re-billed in full — the dominant cost in long discovery/KB-doc
					// loops. No effect on providers without prompt caching (ollama-cloud).
					cacheSessionId: `forge:${INIT_SESSION_ID}`,
					tailLog: observer.state.tailLog,
					onEvent: (event) => observer.onEvent(event),
					requestedModel: modelResolution.model,
					modelRegistry: ctx.modelRegistry,
					signal: (opts as unknown as { signal?: AbortSignal }).signal,
					customTools: p.forgeToolDefs
						? getSubagentTools(p.forgeToolDefs, persona.name)
						: undefined,
				}),
			),
		);
	} catch (err) {
		registry.completePhase(INIT_SESSION_ID, subLabel, "failed");
		tree.completeNode(nodeId, "failed");
		throw err;
	}

	const nodeStatus = result.exitCode === 0 ? "completed" : "failed";
	registry.completePhase(INIT_SESSION_ID, subLabel, nodeStatus);
	tree.completeNode(nodeId, nodeStatus);
	return result;
}
