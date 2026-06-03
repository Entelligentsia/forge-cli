// Context Governor — FORGE-S30-T03 (substrate) / FORGE-S30-T04 (Mechanism A curation).
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
// Design notes:
//   - The policy table is a TypeScript literal loaded at module init — no disk I/O,
//     no .forge/store/ reads or writes (Pack 07 compliance).
//   - contextWindow is resolved from ctx.model?.contextWindow first, then
//     modelRegistry.find()?.contextWindow, then DEFAULT_CONTEXT_WINDOW (200_000).
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
// Governor factory (contextWindow-aware, Mechanism A curation)
// ---------------------------------------------------------------------------

/**
 * Create a governor backed by the given policy table and model registry.
 * Implements Mechanism A curation rules (T04):
 *   Rule 1 — Dedup/reference-ize
 *   Rule 2 — Schema-trim (forge_store results)
 *   Rule 3 — Span-clamp (bash/grep/find/read results)
 *
 * contextWindow resolution order (provider-neutral):
 *   1. ctx.model?.contextWindow  — active model, resolved synchronously
 *   2. ctx.modelRegistry.find(provider, modelId)?.contextWindow — registry backup
 *   3. DEFAULT_CONTEXT_WINDOW (200_000) — conservative fallback
 */
export function createGovernor(
	table: PhasePolicyTable,
	_modelRegistry: ModelRegistry,
): ContextGovernor {
	// Per-governor-instance dedup registry. Maps "${toolName}:${target}" → turn number.
	const dedupRegistry = new Map<string, number>();
	let currentTurn = 0;

	return {
		applyToolResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined {
			try {
				currentTurn++;

				// Resolve contextWindow (seam for T05/T06 curation logic).
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

				const phaseKey = resolvePhaseKey(ctx);
				const policy = table[phaseKey] ??
					table["default"] ?? {
						residentFields: [],
						toolBudgets: {},
						steerThreshold: 0.9,
					};

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
			// T03/T04: no-op body for tool_call. T05/T06 will extend this.
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
