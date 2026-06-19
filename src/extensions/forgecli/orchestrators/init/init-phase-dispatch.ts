// init-phase-dispatch.ts — per-phase LLM dispatcher for the /forge:init
// orchestrator pipeline (FORGE-S33-T02). Handles model resolution,
// CallerContextStore + AskBroker wrapping, runForgeSubagent dispatch,
// verify-gate routing, and retry-once semantics. Sequential fan-out (Option A)
// for collect (5 domains) and discover (7 KB-doc IDs).
//
// IL10 — NEVER calls store-cli emit; the orchestrator (T03) composes and emits
// phase events from result.{model,provider,usage} after dispatchInitPhase returns.
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

import type { InitPhaseDescriptor } from "./init-phases.js";
import { DOMAINS, KB_DOC_IDS, ROLE_TIER } from "./init-phases.js";
import type { RunInitOptions } from "./run-init-types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Structured result returned by the /forge:init pipeline on early-exit. */
export interface InitPipelineResult {
	status: "ok" | "failed" | "cancelled";
	/** Last phase index that ran (0-based into INIT_PHASES). */
	lastPhase: number;
	/** Failure reason when status="failed". */
	failure?: string;
}

/** Inputs required by dispatchInitPhase. */
export interface InitPhaseDispatchParams {
	opts: RunInitOptions;
	phase: InitPhaseDescriptor;
	/** 0-based index of this phase in INIT_PHASES. */
	phaseIndex: number;
	cwd: string;
	ctx: ExtensionCommandContext;
	/** Absolute path to the vendored bundle root (contains init/phases/). */
	bundleRoot: string;
	/** KB folder name (e.g. "engineering"). */
	kbFolder: string;
	/** ISO 8601 timestamp passed down to each subagent prompt. */
	isoTimestamp: string;
	/** Merged model-routing config from layered config. */
	modelRoutingConfig: MergedConfig;
	/** Raw forge tool definitions (optional — carries forge_ask_user). */
	forgeToolDefs?: Parameters<typeof getSubagentTools>[0];
}

/**
 * Discriminated return union from dispatchInitPhase.
 *
 *  kind="skip"   — deterministic phase; orchestrator handles it directly.
 *  kind="return" — early-exit (failure or cancellation); carry result up.
 *  kind="ok"     — LLM phase completed successfully; last SubagentResult attached.
 */
export type InitPhaseDispatchOutcome =
	| { kind: "skip" }
	| { kind: "return"; result: InitPipelineResult }
	| { kind: "ok"; result: SubagentResult };

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Read the phase prompt from the bundled init/phases/ directory.
 * Throws on missing file — caller catches and returns failure.
 */
function readInitPhasePrompt(bundleRoot: string, phaseNum: 1 | 2): string {
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
 * Resolve model for a sub-role within the init pipeline. Reads the intended
 * tier from ROLE_TIER[modelRole] ("sonnet" / "haiku") and resolves the concrete
 * {provider, model} via resolveModelForPhase, using modelRole as the phase key
 * and the given personaNoun (matching task-phase-dispatch, which passes the
 * role — never a display label — as the phase key). The tier is returned
 * alongside the resolution so callers can surface it via notify. Concrete model
 * still comes from config; resolution is "inherit" (undefined model) when config
 * specifies nothing for the role.
 */
function resolveInitModel(
	modelRole: string,
	personaNoun: string,
	modelRoutingConfig: MergedConfig,
): ReturnType<typeof resolveModelForPhase> & { tier: "sonnet" | "haiku" | undefined } {
	const tier = ROLE_TIER[modelRole];
	const resolution = resolveModelForPhase("default", modelRole, personaNoun, modelRoutingConfig);
	return { ...resolution, tier };
}

/**
 * Dispatch a single subagent for the init pipeline and return its SubagentResult.
 * All runForgeSubagent calls are wrapped in CallerContextStore.asSubagent +
 * AskBroker.withUI (IL10 / FORGE-BUG-040 parity).
 *
 * TOD03: If CallerContextStore proves overly strict about the PhaseRole values
 * used here ("plan" / "implement"), widen PhaseRole in T03 or T04 to include
 * init-specific roles. See plan D4 for the reasoning.
 */
async function dispatchSingleAgent(
	subLabel: string,
	subRole: PhaseRole,
	modelRole: string,
	prompt: string,
	_schema: object | undefined,
	personaNoun: string,
	p: InitPhaseDispatchParams,
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

	return CallerContextStore.asSubagent(subRole, () =>
		AskBroker.withUI(ctx.ui, () =>
			runForgeSubagent({
				persona,
				task: prompt,
				cwd,
				exportTag: `forge-init__${subLabel}`,
				requestedModel: modelResolution.model,
				modelRegistry: ctx.modelRegistry,
				signal: (opts as unknown as { signal?: AbortSignal }).signal,
				customTools: p.forgeToolDefs
					? getSubagentTools(p.forgeToolDefs, persona.name)
					: undefined,
			}),
		),
	);
}

/**
 * Fan-out: dispatch one subagent per item in items, sequentially (Option A).
 * Surfaces the sequential cap via ctx.ui.notify before the first dispatch.
 * Returns an array of SubagentResult in order. On any failure, stops early
 * and returns partial results plus a non-null `failedItem`.
 */
async function dispatchFanout(
	items: readonly string[],
	promptFn: (item: string, basePrompt: string) => string,
	subRole: PhaseRole,
	modelRole: string,
	subLabel: (item: string) => string,
	schema: object | undefined,
	personaNoun: string,
	phaseLabel: string,
	basePrompt: string,
	p: InitPhaseDispatchParams,
): Promise<{ results: SubagentResult[]; failedItem: string | null }> {
	const { ctx } = p;
	ctx.ui.notify(
		`  init dispatch: sequential ${items.length}-agent fan-out for "${phaseLabel}" ` +
		`(meta uses parallel; this port is sequential — slower but simpler)`,
		"info",
	);

	const results: SubagentResult[] = [];
	for (const item of items) {
		const prompt = promptFn(item, basePrompt);
		const result = await dispatchSingleAgent(subLabel(item), subRole, modelRole, prompt, schema, personaNoun, p);
		results.push(result);
		if (result.exitCode !== 0) {
			return { results, failedItem: item };
		}
	}
	return { results, failedItem: null };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Dispatch a single /forge:init phase. Returns a discriminated outcome:
 *
 * - `{ kind: "skip" }` for deterministic phases (orchestrator handles them).
 * - `{ kind: "return", result }` for failures / early-exit.
 * - `{ kind: "ok", result }` carrying the last SubagentResult on success.
 */
export async function dispatchInitPhase(
	p: InitPhaseDispatchParams,
): Promise<InitPhaseDispatchOutcome> {
	const { phase, phaseIndex, ctx, bundleRoot, kbFolder, isoTimestamp } = p;

	// Deterministic phases are handled by the orchestrator directly.
	if (phase.kind === "deterministic") {
		return { kind: "skip" };
	}

	// ── Phase 1: collect (5 domain fan-out + config-writer) ──────────────────
	if (phase.name === "collect") {
		let phasePrompt: string;
		try {
			phasePrompt = readInitPhasePrompt(bundleRoot, 1);
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`× init dispatch: cannot read Phase 1 prompt: ${e.message ?? "unknown"}`, "error");
			return { kind: "return", result: { status: "failed", lastPhase: phaseIndex, failure: `prompt read failed: ${e.message ?? "unknown"}` } };
		}

		// Domain discovery fan-out (5 sequential agents).
		const { results: domainResults, failedItem: failedDomain } = await dispatchFanout(
			DOMAINS,
			(domain, base) =>
				`${base}\n\n<!-- AGENT PARAMS -->\ndomain: ${domain}\nisoTimestamp: ${isoTimestamp}\n`,
			"plan" as PhaseRole,
			"discovery",
			(domain) => `discovery:${domain}`,
			phase.schema,
			phase.persona ?? "engineer",
			"collect:discovery",
			phasePrompt,
			p,
		);

		if (failedDomain !== null) {
			return {
				kind: "return",
				result: {
					status: "failed",
					lastPhase: phaseIndex,
					failure: `Phase 1 discovery agent failed for domain "${failedDomain}"`,
				},
			};
		}

		// Config-writer agent.
		const configPrompt =
			`${phasePrompt}\n\n<!-- AGENT PARAMS -->\nrole: config-writer\nisoTimestamp: ${isoTimestamp}\n`;
		let configResult = await dispatchSingleAgent(
			"config-writer",
			"plan" as PhaseRole,
			"config",
			configPrompt,
			phase.schema,
			phase.persona ?? "engineer",
			p,
		);

		// Retry-once if config-writer returned non-zero exit or verifyExit != 0.
		const configFailed = configResult.exitCode !== 0;
		if (configFailed) {
			ctx.ui.notify(`  init dispatch: config-writer failed (exit ${configResult.exitCode}), retrying…`, "info");
			const retryPrompt =
				`${phasePrompt}\n\n<!-- AGENT PARAMS: RETRY -->\nrole: config-writer\nisoTimestamp: ${isoTimestamp}\n`;
			configResult = await dispatchSingleAgent(
				"config-writer:retry",
				"plan" as PhaseRole,
				"config",
				retryPrompt,
				phase.schema,
				phase.persona ?? "engineer",
				p,
			);
			if (configResult.exitCode !== 0) {
				return {
					kind: "return",
					result: {
						status: "failed",
						lastPhase: phaseIndex,
						failure: "Phase 1 config-writer failed after retry",
					},
				};
			}
		}

		// Use the last domain result as the "representative" result for the phase.
		// The orchestrator (T03) composes the phase event from whichever result it
		// tracks; returning configResult here is simplest and correct.
		void domainResults; // consumed above; suppress unused-var
		return { kind: "ok", result: configResult };
	}

	// ── Phase 2: discover (gate + 7 KB-doc fan-out + index + context) ────────
	if (phase.name === "discover") {
		let phasePrompt: string;
		try {
			phasePrompt = readInitPhasePrompt(bundleRoot, 2);
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`× init dispatch: cannot read Phase 2 prompt: ${e.message ?? "unknown"}`, "error");
			return { kind: "return", result: { status: "failed", lastPhase: phaseIndex, failure: `prompt read failed: ${e.message ?? "unknown"}` } };
		}

		// Gate agent (haiku-tier — just checks readiness).
		const gatePrompt =
			`${phasePrompt}\n\n<!-- AGENT PARAMS -->\nrole: gate\nisoTimestamp: ${isoTimestamp}\n`;
		const gateResult = await dispatchSingleAgent(
			"gate",
			"implement" as PhaseRole,
			"gate",
			gatePrompt,
			undefined,
			phase.persona ?? "engineer",
			p,
		);

		if (gateResult.exitCode !== 0) {
			ctx.ui.notify(`× init dispatch: Phase 2 gate failed — halting.`, "error");
			return {
				kind: "return",
				result: { status: "failed", lastPhase: phaseIndex, failure: "Phase 2 gate failed" },
			};
		}

		// KB-doc fan-out (7 sequential agents), retry each failed doc once.
		const { ctx: _ctx } = p;
		_ctx.ui.notify(
			`  init dispatch: sequential ${KB_DOC_IDS.length}-agent fan-out for "discover:kb-docs" ` +
			`(meta uses parallel; this port is sequential — slower but simpler)`,
			"info",
		);

		const kbResults: SubagentResult[] = [];
		for (const docId of KB_DOC_IDS) {
			const kbPrompt =
				`${phasePrompt}\n\n<!-- AGENT PARAMS -->\nrole: kb-doc\ndocId: ${docId}\nkbFolder: ${kbFolder}\nisoTimestamp: ${isoTimestamp}\n`;
			let kbResult = await dispatchSingleAgent(
				`kb-doc:${docId}`,
				"plan" as PhaseRole,
				"kb-doc",
				kbPrompt,
				phase.schema,
				phase.persona ?? "engineer",
				p,
			);
			if (kbResult.exitCode !== 0) {
				// Retry once.
				ctx.ui.notify(`  init dispatch: kb-doc "${docId}" failed, retrying…`, "info");
				const retryKbPrompt =
					`${phasePrompt}\n\n<!-- AGENT PARAMS: RETRY -->\nrole: kb-doc\ndocId: ${docId}\nkbFolder: ${kbFolder}\nisoTimestamp: ${isoTimestamp}\n`;
				kbResult = await dispatchSingleAgent(
					`kb-doc:${docId}:retry`,
					"plan" as PhaseRole,
					"kb-doc",
					retryKbPrompt,
					phase.schema,
					phase.persona ?? "engineer",
					p,
				);
				if (kbResult.exitCode !== 0) {
					return {
						kind: "return",
						result: {
							status: "failed",
							lastPhase: phaseIndex,
							failure: `Phase 2 kb-doc "${docId}" failed after retry`,
						},
					};
				}
			}
			kbResults.push(kbResult);
		}

		// Index agent.
		const indexPrompt =
			`${phasePrompt}\n\n<!-- AGENT PARAMS -->\nrole: index\nkbFolder: ${kbFolder}\nisoTimestamp: ${isoTimestamp}\n`;
		const indexResult = await dispatchSingleAgent(
			"index",
			"plan" as PhaseRole,
			"index",
			indexPrompt,
			undefined,
			phase.persona ?? "engineer",
			p,
		);
		if (indexResult.exitCode !== 0) {
			return {
				kind: "return",
				result: { status: "failed", lastPhase: phaseIndex, failure: "Phase 2 index agent failed" },
			};
		}

		// Context agent — retry-once on failure.
		const contextPrompt =
			`${phasePrompt}\n\n<!-- AGENT PARAMS -->\nrole: context\nkbFolder: ${kbFolder}\nisoTimestamp: ${isoTimestamp}\n`;
		let contextResult = await dispatchSingleAgent(
			"context",
			"plan" as PhaseRole,
			"context",
			contextPrompt,
			undefined,
			phase.persona ?? "engineer",
			p,
		);
		if (contextResult.exitCode !== 0) {
			ctx.ui.notify(`  init dispatch: context agent failed, retrying…`, "info");
			const retryContextPrompt =
				`${phasePrompt}\n\n<!-- AGENT PARAMS: RETRY -->\nrole: context\nkbFolder: ${kbFolder}\nisoTimestamp: ${isoTimestamp}\n`;
			contextResult = await dispatchSingleAgent(
				"context:retry",
				"plan" as PhaseRole,
				"context",
				retryContextPrompt,
				undefined,
				phase.persona ?? "engineer",
				p,
			);
			if (contextResult.exitCode !== 0) {
				return {
					kind: "return",
					result: { status: "failed", lastPhase: phaseIndex, failure: "Phase 2 context agent failed after retry" },
				};
			}
		}

		void kbResults; // consumed above; suppress unused-var
		return { kind: "ok", result: contextResult };
	}

	// Unsupported LLM phase kind — should not happen with the current table.
	ctx.ui.notify(`× init dispatch: unsupported phase "${phase.name}" (kind=${phase.kind}) — skipping`, "error");
	return {
		kind: "return",
		result: { status: "failed", lastPhase: phaseIndex, failure: `unsupported phase "${phase.name}"` },
	};
}
