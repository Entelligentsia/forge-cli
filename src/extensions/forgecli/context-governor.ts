// Context Governor — FORGE-S30-T03 (substrate) / FORGE-S30-T04 (Mechanism A curation)
//                   / FORGE-S30-T05 (Mechanism B — context budget meter + checkpoint steer)
//                   / FORGE-S30-T06 (Mechanism C — checkpoint-and-shed against {PHASE}-SUMMARY.json)
//                   / FORGE-S30-T09 (Mechanism E — proactive compactFn trigger at budget threshold).
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

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
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
 *
 * NOTE: pi never populates persona/phase on ExtensionContext in production —
 * this probe only matches in test harnesses. Production paths MUST inject the
 * phaseKey at construction time (createGovernor's `phaseKey` param via
 * buildGovernorFactory); this fallback resolving to "default" was the dormant-
 * governor defect found benchmarking CART-S02-T03.
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
		// Real run-task PHASE_PIPELINE keys (`${personaNoun}/${role}`):
		"engineer/plan": "PLAN-SUMMARY.json",
		"supervisor/review-plan": "REVIEW_PLAN-SUMMARY.json",
		"engineer/implement": "IMPLEMENTATION-SUMMARY.json",
		"supervisor/review-code": "CODE_REVIEW-SUMMARY.json",
		"qa-engineer/validate": "VALIDATION-SUMMARY.json",
		"architect/approve": "APPROVE-SUMMARY.json",
		// Legacy design-time keys (kept for test fixtures; not produced by the pipeline):
		"architect/plan": "PLAN-SUMMARY.json",
		"engineer/review": "REVIEW-SUMMARY.json",
		"engineer/code-review": "CODE_REVIEW-SUMMARY.json",
	};
	return map[phaseKey] ?? "{PHASE}-SUMMARY.json";
}

/**
 * Map a real pipeline phaseKey to the store record `summaries` key written by
 * `store-cli set-summary` (kind names — e.g. "implementation", not "implement").
 * Used by buildGovernorFactory's summary sentinel (Mechanism C).
 */
const PHASE_SUMMARY_KEYS: Record<string, string> = {
	"engineer/plan": "plan",
	"supervisor/review-plan": "review_plan",
	"engineer/implement": "implementation",
	"supervisor/review-code": "code_review",
	"qa-engineer/validate": "validation",
	"architect/approve": "approve",
};

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
 * @param compactFn  opt callback injected at construction (Mechanism E / T09).
 *                  Called proactively once when fraction >= policy.steerThreshold,
 *                  via a single-fire `compactFired` flag distinct from `steerFired`.
 *                  Callers pass `compactFn = () => session.compact()`. Errors inside
 *                  compactFn are caught and written to stderr (IL7). Omitting this
 *                  param is backwards-compatible — no compact trigger fires.
 * @param phaseKey  opt construction-time phase key override ("persona/role").
 *                  Production paths MUST pass this (via buildGovernorFactory) —
 *                  pi never populates persona/phase on ExtensionContext, so the
 *                  ctx probe always resolves "default" at runtime. Omitting it
 *                  preserves the legacy ctx-probe behaviour (test harnesses).
 */
export function createGovernor(
	table: PhasePolicyTable,
	_modelRegistry: ModelRegistry,
	steerFn?: (message: string) => void,
	summarySentinel?: (phaseKey: string, entityId: string) => boolean,
	compactFn?: () => void,
	phaseKey?: string,
): ContextGovernor {
	// Per-governor-instance dedup registry. Maps "${toolName}:${target}" → turn number.
	const dedupRegistry = new Map<string, number>();
	let currentTurn = 0;
	// Mechanism B: single-fire steer invariant
	let steerFired = false;
	// Mechanism E (T09): single-fire compact trigger — distinct from steerFired so
	// proactive compact and steer can be enabled independently.
	let compactFired = false;

	return {
		applyToolResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined {
			try {
				currentTurn++;

				// Resolve phase key and policy (shared by Mechanism B meter and Mechanism A curation).
				// Construction-time override wins — pi never sets persona/phase on ctx.
				const resolvedPhaseKey = phaseKey ?? resolvePhaseKey(ctx);
				const policy = table[resolvedPhaseKey] ??
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
							steerFn(buildSteerMessage(resolvedPhaseKey));
						}
						// Mechanism E (T09): proactive compact trigger — single-fire, independent of steer.
						if (fraction >= policy.steerThreshold && !compactFired && compactFn) {
							compactFired = true;
							try {
								compactFn();
							} catch (compactErr: unknown) {
								const msg = compactErr instanceof Error ? compactErr.message : String(compactErr);
								process.stderr.write(`[context-governor] compactFn error (non-fatal): ${msg}\n`);
							}
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
						const entityId = resolveEntityId(event);
						if (entityId && summarySentinel(resolvedPhaseKey, entityId)) {
							return {
								content: [
									{
										type: "text",
										text: `[summarized — see ${phaseSummaryName(resolvedPhaseKey)} for ${entityId}]`,
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
 * Ships an entry for every governed run-task PHASE_PIPELINE key
 * (`${personaNoun}/${role}` — engineer/plan, supervisor/review-plan,
 * engineer/implement, supervisor/review-code, qa-engineer/validate,
 * architect/approve) plus "default" for any unlisted persona/phase.
 * writeback/commit intentionally stay on "default" — small phases whose
 * git/store output must not be clamped.
 *
 * `read` budgets are deliberately more generous than `bash` — clamping file
 * reads too tightly degrades implement/review quality (the agent cannot see
 * whole files), while bash output (store-cli reads, test logs, greps) is the
 * dominant context bloat observed in the CART-S02-T03 baseline.
 *
 * Legacy design-time keys ("architect/plan", "engineer/review") are retained
 * for existing test fixtures; the pipeline never produces them.
 *
 * Values are conservative design-time decisions; a future task can promote
 * specific fields to project config once per-project tuning evidence exists.
 */
export function loadDefaultPolicyTable(): PhasePolicyTable {
	return {
		// ── Real run-task PHASE_PIPELINE keys ──────────────────────────────
		"engineer/plan": {
			residentFields: ["status", "title", "dependencies", "description"],
			toolBudgets: { forge_store: 2000, bash: 1000, read: 3000 },
			steerThreshold: 0.8,
		},
		"supervisor/review-plan": {
			residentFields: ["status", "summaries", "acceptanceCriteria"],
			toolBudgets: { forge_store: 1500, bash: 800, read: 3000 },
			steerThreshold: 0.75,
		},
		"engineer/implement": {
			residentFields: ["status", "title", "description", "summaries"],
			toolBudgets: { forge_store: 2000, bash: 1500, read: 4000 },
			steerThreshold: 0.8,
		},
		"supervisor/review-code": {
			residentFields: ["status", "summaries", "acceptanceCriteria"],
			toolBudgets: { forge_store: 1500, bash: 800, read: 3000 },
			steerThreshold: 0.75,
		},
		"qa-engineer/validate": {
			residentFields: ["status", "summaries", "acceptanceCriteria"],
			toolBudgets: { forge_store: 1500, bash: 2000, read: 3000 },
			steerThreshold: 0.75,
		},
		"architect/approve": {
			residentFields: ["status", "summaries", "acceptanceCriteria"],
			toolBudgets: { forge_store: 1500, bash: 1000, read: 3000 },
			steerThreshold: 0.75,
		},
		// ── Legacy design-time keys (test fixtures only) ───────────────────
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

// ---------------------------------------------------------------------------
// Per-subagent governor factory (production wiring — completes FORGE-S30-T07)
// ---------------------------------------------------------------------------

/** Options for buildGovernorFactory. */
export interface GovernorFactoryOptions {
	/**
	 * Pipeline phase key, `${personaNoun}/${role}` (e.g. "supervisor/review-code").
	 * Known to run-task.ts at dispatch time; injected here because pi never
	 * populates persona/phase on ExtensionContext.
	 */
	phaseKey: string;
	/** Project cwd — root containing `.forge/store/` (sentinel reads only). */
	cwd: string;
}

/**
 * Read-only Mechanism C sentinel: true when the store record for entityId
 * already carries a summary for the given phase. Reads
 * `.forge/store/{tasks,bugs}/<entityId>.json` directly (never writes — Pack 07).
 * Any failure returns false → retain, never evict (IL7).
 */
function storeSummarySentinel(cwd: string, phaseKey: string, entityId: string): boolean {
	const summaryKey = PHASE_SUMMARY_KEYS[phaseKey];
	if (!summaryKey) return false;
	for (const kind of ["tasks", "bugs"]) {
		try {
			const recordPath = path.join(cwd, ".forge", "store", kind, `${entityId}.json`);
			const raw = fs.readFileSync(recordPath, "utf8");
			const record = JSON.parse(raw) as { summaries?: Record<string, unknown> };
			const summary = record.summaries?.[summaryKey];
			if (summary !== undefined && summary !== null) return true;
		} catch {
			// missing file / parse failure → try next kind, default retain (IL7)
		}
	}
	return false;
}

/**
 * Build an ExtensionFactory that registers a fully-wired context governor in a
 * subagent session. Constructed per-phase by run-task.ts (which knows the
 * persona/role) and passed via RunSubagentOptions.extensionFactories —
 * the same injection channel as buildForgeCompactionFactory (Mechanism E).
 *
 * This is the production wiring the original FORGE-S30-T07 integration missed:
 * registerHookDispatcher(pi, …, governor) in index.ts only governs the PARENT
 * session, while every phase runs in an isolated createAgentSession subagent
 * that the parent's hooks never see. The CART-S02-T03 benchmark confirmed the
 * result: zero curation markers across a full FORGE_CTX_GOVERNOR=1 phase.
 *
 * Wiring supplied here:
 *   phaseKey        — construction-time (Mechanism D policies finally reachable)
 *   steerFn         — pi.sendUserMessage(msg, { deliverAs: "steer" }) (Mechanism B)
 *   summarySentinel — storeSummarySentinel against .forge/store/ (Mechanism C)
 *   compactFn       — ctx.compact() proactive trigger (Mechanism E)
 *
 * steer uses the session-scoped ExtensionAPI directly; compact rides the
 * ExtensionContext captured at the start of each handler invocation — it only
 * fires synchronously inside applyToolResult, so the captured ctx is always
 * the live one. All callbacks are guarded: failures fall through silently
 * (IL7); the factory never writes to .forge/store/ (Pack 07).
 */
export function buildGovernorFactory(opts: GovernorFactoryOptions): ExtensionFactory {
	const { phaseKey, cwd } = opts;
	return (pi: ExtensionAPI): void => {
		let currentCtx: ExtensionContext | undefined;

		const steerFn = (message: string): void => {
			try {
				pi.sendUserMessage(message, { deliverAs: "steer" });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[context-governor] steerFn error (non-fatal): ${msg}\n`);
			}
		};
		// createGovernor already wraps compactFn invocations in try/catch (IL7).
		const compactFn = (): void => {
			currentCtx?.compact();
		};
		const summarySentinel = (pk: string, entityId: string): boolean =>
			storeSummarySentinel(cwd, pk, entityId);

		// Registration-time stub; per-turn contextWindow resolution uses
		// ctx.getContextUsage()/ctx.modelRegistry inside the handler chain.
		const stubRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const governor = createGovernor(
			loadDefaultPolicyTable(),
			stubRegistry,
			steerFn,
			summarySentinel,
			compactFn,
			phaseKey,
		);

		// Return types mirror hook-dispatcher.ts's registrations: pi's typed
		// on() overloads expect its internal result types; the governor's
		// structurally-equivalent locals satisfy them at runtime.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext): any => {
			currentCtx = ctx;
			return governor.applyToolCall(event, ctx);
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext): any => {
			currentCtx = ctx;
			return governor.applyToolResult(event, ctx);
		});
	};
}
