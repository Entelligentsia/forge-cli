// Context Governor — FORGE-S30-T03 (substrate) / FORGE-S30-T04 (Mechanism A curation)
//                   / FORGE-S30-T05 (Mechanism B — context budget meter + checkpoint steer)
//                   / FORGE-S30-T06 (Mechanism C — checkpoint-and-shed against {PHASE}-SUMMARY.json).
// Defines the phase-policy table (keyed by persona/phase), the ContextGovernor
// interface wired into hook-dispatcher.ts tool_result/tool_call paths, and the
// governor factories used by T04 (live curation) and as no-op defaults.
//
// Mechanism A curation rules (T04):
//   Rule 1 — Dedup/reference-ize: repeated (tool, target) call returns a pointer.
//   Rule 2 — Schema-trim: forge_store results trimmed to phase-declared residentFields
//             + summaries.* + identity keys. Preserved fields are byte-identical.
//   Rule 3 — Span-clamp: bash/grep/find output over toolBudget chars is truncated
//             with "[N lines elided]" marker.
//
// Mechanism B (T05):
//   Budget meter: per-turn ctx.getContextUsage() → ctx.ui.setStatus("forge:ctx-budget", "ctx: Nk / Wk (P%)")
//   Steer: one-shot note at policy.steerThreshold, injected via steerFn (optional, injected at
//   governor construction by registerHookDispatcher). Single-fire invariant: steerFired flag
//   is never reset after first fire.
//
// Design notes:
//   - The policy table is a TypeScript literal loaded at module init — no disk I/O,
//     no .forge/store/ reads or writes (Pack 07 compliance).
//   - contextWindow resolution: when ctx.getContextUsage() returns a ContextUsage value,
//     usage.contextWindow is used directly (no registry lookup needed). Fallback chain
//     (ctx.model?.contextWindow → modelRegistry → DEFAULT_CONTEXT_WINDOW) only applies
//     when getContextUsage() returns undefined.
//     No provider names, model-family strings, or tier logic appear here.
//   - Governor methods MUST NOT throw; failures fall through to undefined (IL7).
//   - IL10: registerHookDispatcher's public signature and orchestrator event paths
//     are untouched. The third arg is optional; all existing callers unaffected.

import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Return type for tool_result pi handlers — matches ToolResultEventResult from
 * @earendil-works/pi-coding-agent (not exported from the package root).
 * Structural equivalence is sufficient for TypeScript assignability.
 */
export interface ToolResultEventResult {
	content?: Array<{ type: "text"; text: string } | { type: "image"; source: unknown }>;
	details?: unknown;
	isError?: boolean;
}

// ---------------------------------------------------------------------------
// Phase-policy types (Mechanism D substrate)
// ---------------------------------------------------------------------------

/**
 * Policy for a single persona/phase combination.
 *
 * residentFields — names of task/sprint record fields that are always retained
 *   in context (not trimmed by Mechanism A).
 * toolBudgets    — per-tool soft token budget caps (keyed by tool name).
 *   T04 reads these when deciding how aggressively to trim tool_result content.
 * steerThreshold — fraction of contextWindow at which Mechanism B fires a
 *   budget-steer note (0–1; e.g. 0.80 = steer when 80% of window is used).
 */
export interface PhasePolicy {
	residentFields: string[];
	toolBudgets: Record<string, number>;
	steerThreshold: number;
}

/**
 * Lookup table keyed by `"${persona}/${phase}"` (e.g. `"architect/plan"`,
 * `"engineer/review"`) plus a `"default"` entry for unknown combinations.
 */
export type PhasePolicyTable = Record<string, PhasePolicy>;

// ---------------------------------------------------------------------------
// ContextGovernor interface
// ---------------------------------------------------------------------------

/**
 * Governor interface wired into hook-dispatcher.ts.
 * T03: both methods return undefined/void (no-op). T04 supplies live curation
 * logic via createGovernor.
 *
 * MUST NOT throw — IL7. Any internal failure must return undefined silently.
 */
export interface ContextGovernor {
	/**
	 * Called after the triage-error block in the tool_result handler.
	 * Return a ToolResultEventResult to replace the event content, or undefined
	 * to pass through unchanged.
	 */
	applyToolResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined;

	/**
	 * Called at the tail of the tool_call handler (after all existing guards).
	 * Return a ToolCallEventResult to block or modify the call, or undefined/void
	 * to pass through unchanged.
	 */
	applyToolCall(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | void;
}

// ---------------------------------------------------------------------------
// No-op governor (default before T04/T05/T06)
// ---------------------------------------------------------------------------

/**
 * Returns a ContextGovernor whose methods are pure pass-throughs.
 * Used as the default in registerHookDispatcher so existing callers that do
 * not pass a governor see zero behavioural change.
 */
export function createNoOpGovernor(): ContextGovernor {
	return {
		applyToolResult(_event: ToolResultEvent, _ctx: ExtensionContext): undefined {
			return undefined;
		},
		applyToolCall(_event: ToolCallEvent, _ctx: ExtensionContext): void {
			return undefined;
		},
	};
}

// ---------------------------------------------------------------------------
// Governor factory helpers (Mechanism A)
// ---------------------------------------------------------------------------

/** Fallback context window when neither ctx.model nor modelRegistry can supply one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Resolve the policy key from the extension context.
 * Probes ctx for persona/phase fields (not formally in ExtensionContext; best-effort).
 * Falls back to "default" if not present — safe fallback per IL7 principle.
 */
function resolvePhaseKey(ctx: ExtensionContext): string {
	const persona = (ctx as { persona?: string }).persona ?? "";
	const phase = (ctx as { phase?: string }).phase ?? "";
	if (persona && phase) return `${persona}/${phase}`;
	return "default";
}

/**
 * Compute the dedup key for a tool result event.
 * Returns null if dedup does not apply to this tool.
 */
function dedupKey(event: ToolResultEvent): string | null {
	const input = (event as { input?: Record<string, unknown> }).input ?? {};
	if (event.toolName === "forge_store" || event.toolName === "forge_artifact") {
		const target =
			(input.entityId as string | undefined) ??
			(input.path as string | undefined) ??
			"";
		return `${event.toolName}:${target}`;
	}
	if (event.toolName === "read") {
		const target = (input.file_path as string | undefined) ?? "";
		return `read:${target}`;
	}
	return null;
}

/**
 * Apply Rule 2 — schema-trim to a forge_store result.
 * Trims top-level keys to residentFields ∪ {summaries, summaries.*} ∪ identity keys.
 * Returns the trimmed JSON string, or the original string on parse failure (IL7).
 */
function applySchemaTrip(textContent: string, residentFields: string[]): string {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(textContent) as Record<string, unknown>;
	} catch {
		// Malformed JSON — pass through untouched (IL7)
		return textContent;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return textContent;
	}
	// Identity fields always retained regardless of phase policy
	const identityKeys = new Set(["taskId", "sprintId", "bugId", "featureId"]);
	const residentSet = new Set(residentFields);
	const trimmed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		const retain =
			identityKeys.has(key) ||
			residentSet.has(key) ||
			key === "summaries" ||
			key.startsWith("summaries.");
		if (retain) {
			trimmed[key] = value;
		}
	}
	return JSON.stringify(trimmed);
}

/**
 * Apply Rule 3 — span-clamp to a bash/grep/find/read result.
 * Truncates to budgetTokens*4 chars and appends "[N lines elided]" marker.
 * Under-budget results pass through untouched (AC#3).
 */
function applySpanClamp(textContent: string, budgetTokens: number): string {
	const budgetChars = Math.floor(budgetTokens * 4);
	if (textContent.length <= budgetChars) {
		return textContent;
	}
	const kept = textContent.slice(0, budgetChars);
	const elided = textContent.slice(budgetChars);
	const elidedLines = elided.split("\n").length;
	return `${kept}\n[${elidedLines} lines elided]`;
}

// ---------------------------------------------------------------------------
// Mechanism C helpers (module-internal — not exported; knip-safe)
// ---------------------------------------------------------------------------

/**
 * Extract the entityId from a ToolResultEvent input payload.
 * Returns an empty string if not present or not a string (safe fallback — IL7).
 */
function resolveEntityId(event: ToolResultEvent): string {
	const input = (event as { input?: Record<string, unknown> }).input ?? {};
	const entityId = input.entityId;
	return typeof entityId === "string" ? entityId : "";
}

// ---------------------------------------------------------------------------
// Mechanism B helpers (module-internal — not exported; knip-safe)
// ---------------------------------------------------------------------------

/**
 * Map a phaseKey to the canonical {PHASE}-SUMMARY.json filename.
 * Returns a literal placeholder for unknown keys so steer messages always name a file.
 */
function phaseSummaryName(phaseKey: string): string {
	const map: Record<string, string> = {
		"architect/plan": "PLAN-SUMMARY.json",
		"engineer/implement": "IMPLEMENTATION-SUMMARY.json",
		"engineer/review": "REVIEW-SUMMARY.json",
		"engineer/code-review": "CODE_REVIEW-SUMMARY.json",
	};
	return map[phaseKey] ?? "{PHASE}-SUMMARY.json";
}

/**
 * Build the one-shot steer message injected into the agent loop when the budget
 * threshold is reached. Names the phase summary file so the persona can act
 * immediately. "Will not re-fire" note prevents the agent from waiting for a
 * second prompt.
 */
function buildSteerMessage(phaseKey: string): string {
	return (
		`[Forge context governor] Budget threshold reached (${phaseKey}).\n` +
		`Checkpoint your findings to ${phaseSummaryName(phaseKey)} before reading further.\n` +
		`This note will not re-fire.`
	);
}

// ---------------------------------------------------------------------------
// Governor factory (contextWindow-aware, Mechanism A curation + Mechanism B meter)
// ---------------------------------------------------------------------------

/**
 * Create a governor backed by the given policy table and model registry.
 *
 * Implements Mechanism A curation rules (T04):
 *   Rule 1 — Dedup/reference-ize
 *   Rule 2 — Schema-trim (forge_store results)
 *   Rule 3 — Span-clamp (bash/grep/find/read results)
 *
 * Implements Mechanism B (T05):
 *   Budget meter: per-turn ctx.getContextUsage() → ctx.ui.setStatus("forge:ctx-budget", ...)
 *   Steer: one-shot note at policy.steerThreshold, injected via steerFn
 *
 * Implements Mechanism C (T06):
 *   Checkpoint-and-shed: forge_store results for summarized entities are evicted
 *   and replaced with an eviction pointer; unsummarized material is retained.
 *   Shed criterion: summarySentinel(phaseKey, entityId) returns true.
 *
 * @param table     Phase-policy table (keyed by "persona/phase").
 * @param _modelRegistry  Model registry (fallback contextWindow resolution only).
 * @param steerFn   Optional callback injected at construction by registerHookDispatcher.
 *                  Receives the steer message string; called at most once per governor
 *                  instance (single-fire invariant). Callers that omit this see no steer.
 * @param summarySentinel  Optional read-only probe injected at construction (Mechanism C / T06).
 *                  Receives (phaseKey, entityId); returns true when a {PHASE}-SUMMARY.json
 *                  has been durably written for that entity. When true, the forge_store result
 *                  is replaced with an eviction pointer. Callers that omit this param see no
 *                  shedding (backwards-compatible; undefined default).
 *                  The sentinel MUST NOT write to .forge/store/ or the summary itself (Pack 07).
 *                  Errors inside the sentinel are silently caught and cause retain, not eviction (IL7).
 *
 * contextWindow resolution order (provider-neutral):
 *   1. usage.contextWindow from ctx.getContextUsage() — direct, when available
 *   2. ctx.model?.contextWindow — active model
 *   3. ctx.modelRegistry.find(provider, modelId)?.contextWindow — registry backup
 *   4. DEFAULT_CONTEXT_WINDOW (200_000) — conservative fallback
 */
export function createGovernor(
	table: PhasePolicyTable,
	_modelRegistry: ModelRegistry,
	steerFn?: (message: string) => void,
	summarySentinel?: (phaseKey: string, entityId: string) => boolean,
): ContextGovernor {
	// Per-governor-instance dedup registry. Maps "${toolName}:${target}" → turn number.
	const dedupRegistry = new Map<string, number>();
	let currentTurn = 0;
	// Mechanism B: single-fire steer invariant
	let steerFired = false;

	return {
		applyToolResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined {
			try {
				currentTurn++;

				// Resolve phase key and policy (shared by Mechanism B meter and Mechanism A curation)
				const phaseKey = resolvePhaseKey(ctx);
				const policy = table[phaseKey] ??
					table["default"] ?? {
						residentFields: [],
						toolBudgets: {},
						steerThreshold: 0.9,
					};

				// ------------------------------------------------------------------
				// Mechanism B — budget meter + steer (prefix, before Mechanism A)
				// Wrapped in its own try/catch so any failure (e.g. missing ctx method
				// in older mock environments) falls through silently and Mechanism A
				// curation continues unaffected (IL7).
				// ------------------------------------------------------------------
				try {
					const statusKey = "forge:ctx-budget";
					const usage = ctx.getContextUsage();
					if (usage && usage.tokens !== null) {
						const fraction = usage.tokens / usage.contextWindow;
						const N = Math.round(usage.tokens / 1000);
						const W = Math.round(usage.contextWindow / 1000);
						const P = usage.percent ?? Math.round(fraction * 100);
						ctx.ui.setStatus(statusKey, `ctx: ${N}k / ${W}k (${P}%)`);

						if (fraction >= policy.steerThreshold && !steerFired && steerFn) {
							steerFired = true;
							steerFn(buildSteerMessage(phaseKey));
						}
					} else {
						ctx.ui.setStatus(statusKey, undefined);
					}
				} catch {
					// IL7: Mechanism B failures are silent; Mechanism A continues.
				}

				// ------------------------------------------------------------------
				// Mechanism A — curation (dedup / schema-trim / span-clamp)
				// ------------------------------------------------------------------

				// Rule 1 — Dedup/reference-ize
				const key = dedupKey(event);
				if (key !== null) {
					const prevTurn = dedupRegistry.get(key);
					if (prevTurn !== undefined) {
						// Repeated (tool, target) — return pointer
						return {
							content: [
								{
									type: "text",
									text: `[unchanged since turn ${prevTurn} — re-query if needed]`,
								},
							],
						};
					}
					// Register first occurrence
					dedupRegistry.set(key, currentTurn);
				}

				// ------------------------------------------------------------------
				// Mechanism C — checkpoint-and-shed (T06)
				// Runs AFTER Rule 1 dedup registration so the first-occurrence key
				// is always recorded. Only fires for forge_store events.
				// Wrapped in its own try/catch (IL7): sentinel errors cause retain.
				// The sentinel is a read-only probe — never writes .forge/store/ (Pack 07).
				// ------------------------------------------------------------------
				if (summarySentinel !== undefined && event.toolName === "forge_store") {
					try {
						const phaseKey = resolvePhaseKey(ctx);
						const entityId = resolveEntityId(event);
						if (entityId && summarySentinel(phaseKey, entityId)) {
							return {
								content: [
									{
										type: "text",
										text: `[summarized — see ${phaseSummaryName(phaseKey)} for ${entityId}]`,
									},
								],
							};
						}
					} catch {
						// IL7: sentinel errors are silent; continue to Mechanism A.
					}
				}

				// Extract text content for Rules 2 and 3
				const textBlocks = event.content.filter(
					(c): c is { type: "text"; text: string } => c.type === "text",
				);
				if (textBlocks.length === 0) {
					return undefined;
				}
				const fullText = textBlocks.map((b) => b.text).join("");

				// Rule 2 — Schema-trim (forge_store results only)
				if (event.toolName === "forge_store") {
					const trimmed = applySchemaTrip(fullText, policy.residentFields);
					if (trimmed !== fullText) {
						return { content: [{ type: "text", text: trimmed }] };
					}
					return undefined;
				}

				// Rule 3 — Span-clamp (bash/grep/find/read results)
				const spannedTools = new Set(["bash", "grep", "find", "read"]);
				if (spannedTools.has(event.toolName)) {
					const budget =
						policy.toolBudgets[event.toolName] ?? policy.toolBudgets["bash"];
					if (budget !== undefined) {
						const clamped = applySpanClamp(fullText, budget);
						if (clamped !== fullText) {
							return { content: [{ type: "text", text: clamped }] };
						}
					}
					return undefined;
				}

				return undefined;
			} catch (err: unknown) {
				// IL7: never throw from the governor
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[context-governor] applyToolResult error: ${msg}\n`);
				return undefined;
			}
		},

		applyToolCall(event: ToolCallEvent, ctx: ExtensionContext): void {
			// T03/T04/T05/T06: no-op body for tool_call.
			// T06 Mechanism C shed gate is implemented in applyToolResult above;
			// applyToolCall remains no-op for Mechanism C.
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const _contextWindow =
				ctx.model?.contextWindow ??
				(ctx.model !== undefined
					? ctx.modelRegistry.find(
							(ctx.model as { provider?: string }).provider ?? "",
							(ctx.model as { id?: string }).id ?? "",
						)?.contextWindow
					: undefined) ??
				DEFAULT_CONTEXT_WINDOW;

			void event;
			return undefined;
		},
	};
}

// ---------------------------------------------------------------------------
// Default policy table (Mechanism D — ≥2 phases + safe default)
// ---------------------------------------------------------------------------

/**
 * Load the built-in phase-policy table.
 *
 * Ships entries for at least two phases (AC#2):
 *   "architect/plan"   — planning phase policy
 *   "engineer/review"  — review phase policy
 *   "default"          — safe fallback for any unlisted persona/phase
 *
 * Values are conservative design-time decisions; a future task can promote
 * specific fields to project config once per-project tuning evidence exists.
 */
export function loadDefaultPolicyTable(): PhasePolicyTable {
	return {
		"architect/plan": {
			residentFields: ["status", "title", "dependencies", "description"],
			toolBudgets: { forge_store: 2000, bash: 1000 },
			steerThreshold: 0.8,
		},
		"engineer/review": {
			residentFields: ["status", "summaries", "acceptanceCriteria"],
			toolBudgets: { forge_store: 1500, bash: 800 },
			steerThreshold: 0.75,
		},
		default: {
			residentFields: [],
			toolBudgets: {},
			steerThreshold: 0.9,
		},
	};
}
