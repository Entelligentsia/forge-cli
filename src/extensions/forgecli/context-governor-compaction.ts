// context-governor-compaction.ts — Mechanism E: Forge-aware compaction handler.
// FORGE-S30-T09
//
// Exports:
//   ForgeFactSummary        — extracted Forge facts struct
//   ForgeCompactionOptions  — options for the compaction factory
//   extractForgeFacts(msgs) — pure extractor (no fs I/O)
//   buildForgeCompactionFactory(opts) — ExtensionFactory builder
//
// Design:
//   - Thin module separate from context-governor.ts so it can import ExtensionAPI
//     types (which require the pi pkg) without polluting the pure-logic governor.
//   - extractForgeFacts: line-level pattern matching — no LLM call, provider-neutral,
//     lossless on structured facts.
//   - Warm-tier merge: reads {PHASE}-SUMMARY.json via injected summaryReader
//     (defaults to fs.readFileSync). Best-effort — absent/malformed files silently
//     skipped (IL7).
//   - IL7 fallback: entire session_before_compact handler wrapped in try/catch.
//     On any error, returns undefined — lets pi compact normally with generateSummary.
//   - IL10/Pack 07: only reads summary files, never writes .forge/store/ or summaries.
//   - NOT wired into index.ts/run-task.ts yet — deferred to T07 production integration.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";

/**
 * Structural equivalent of SessionBeforeCompactResult from pi's types.d.ts.
 * The type is not exported from the @earendil-works/pi-coding-agent root, so
 * we define it structurally here. Shape matches pi's internal definition:
 *   interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult; }
 */
interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

// ---------------------------------------------------------------------------
// Forge-fact types
// ---------------------------------------------------------------------------

/**
 * Structured Forge facts extracted from messagesToSummarize.
 * All fields are arrays of strings for serialization into the compaction summary.
 */
export interface ForgeFactSummary {
	/** FORGE-X-Y / FORGE-X-Y-TN patterns extracted from message text. */
	storeIds: string[];
	/** Lines containing [x] or [ ] checkbox patterns (Markdown task lists). */
	acStateLines: string[];
	/** Lines matching → <status> or update-status ... status <value>. */
	transitionLines: string[];
	/** File refs: engineering/, .forge/, *.ts/*.md/*.cjs/*.json paths. */
	fileRefs: string[];
	/** Text blocks containing [FRICTION] or type:friction. */
	frictionBlocks: string[];
}

// ---------------------------------------------------------------------------
// Forge-compaction options
// ---------------------------------------------------------------------------

/**
 * Options for buildForgeCompactionFactory.
 */
export interface ForgeCompactionOptions {
	/**
	 * Absolute path to the project CWD (for warm-tier summary file lookup).
	 * When omitted, warm-tier merge is skipped unless summaryReader is provided.
	 */
	cwd?: string;
	/**
	 * Phase key for summary filename resolution (e.g. "architect/plan").
	 * When omitted, warm-tier merge is skipped.
	 */
	phaseKey?: string;
	/**
	 * Task/entity ID for summary path resolution (e.g. "FORGE-S30-T09").
	 * When omitted, warm-tier merge is skipped.
	 */
	entityId?: string;
	/**
	 * Sprint ID for summary path resolution (e.g. "FORGE-S30").
	 * When omitted, warm-tier merge is skipped.
	 */
	sprintId?: string;
	/**
	 * Injected summary reader (test seam). Receives the resolved summary
	 * file path (empty string when path resolution is skipped) and returns
	 * the raw JSON string or null. Defaults to fs.readFileSync.
	 * Must not throw — return null on any failure.
	 */
	summaryReader?: (filePath: string) => string | null;
}

// ---------------------------------------------------------------------------
// Pattern constants (module-level compile-time constants)
// ---------------------------------------------------------------------------

/** Matches Forge store IDs in their standard forms:
 *   FORGE-S30-T09   (sprint+task)
 *   FORGE-S30       (sprint)
 *   FORGE-BUG-042   (bug, with category letters + digit suffix)
 * Pattern: FORGE- followed by alternating ALPHANUM segments separated by hyphens.
 * Two variants ordered longest-first so overlapping (sprint+task before sprint) works. */
const STORE_ID_RE = /FORGE-[A-Z]+\d*-(?:T?\d+|[A-Z]+\d*)|FORGE-[A-Z]+\d*/g;

/** Matches Markdown checkbox lines. */
const CHECKBOX_RE = /^\s*[-*]?\s*\[[ xX]\].*$/gm;

/** Matches status transition patterns:
 *   - Arrow: "→ implemented"
 *   - store-cli: "update-status task FORGE-S30-T09 status implementing"
 * Using a broad match to capture both forms reliably. */
const TRANSITION_RE = /(?:→\s*[\w][\w-]*|update-status\s+\S+\s+\S+\s+status\s+[\w][\w-]*)/g;

/** Matches file reference patterns. */
const FILE_REF_RE =
	/(?:engineering\/[^\s"'`,;)]+|\.forge\/[^\s"'`,;)]+|\b[\w./\-]+\.(?:ts|md|cjs|json)\b)/g;

// ---------------------------------------------------------------------------
// extractForgeFacts — pure extractor
// ---------------------------------------------------------------------------

/**
 * Extract structured Forge facts from an array of message-like objects.
 *
 * Pure function — no fs I/O, no LLM calls, provider-neutral.
 * Accepts any array (unknown[]) to be safe against varying pi message shapes.
 * Text content is extracted from `.content[].text` (assistant messages)
 * and from direct string entries.
 *
 * @param messagesToSummarize  Array of message-like objects from preparation.
 * @returns ForgeFactSummary with all extracted patterns.
 */
export function extractForgeFacts(messagesToSummarize: unknown[]): ForgeFactSummary {
	const storeIdSet = new Set<string>();
	const acStateLines: string[] = [];
	const transitionLineSet = new Set<string>();
	const fileRefSet = new Set<string>();
	const frictionBlocks: string[] = [];

	for (const msg of messagesToSummarize) {
		const texts = extractTextContent(msg);
		for (const text of texts) {
			// Store IDs — reset lastIndex before each matchAll
			const storeMatches = text.matchAll(new RegExp(STORE_ID_RE.source, "g"));
			for (const m of storeMatches) {
				storeIdSet.add(m[0]);
			}

			// AC-state checkbox lines
			const checkboxMatches = text.match(new RegExp(CHECKBOX_RE.source, "gm"));
			if (checkboxMatches) {
				for (const line of checkboxMatches) {
					acStateLines.push(line.trim());
				}
			}

			// Transition lines
			const transitionMatches = text.matchAll(new RegExp(TRANSITION_RE.source, "g"));
			for (const m of transitionMatches) {
				transitionLineSet.add(m[0].trim());
			}

			// File refs
			const fileRefMatches = text.matchAll(new RegExp(FILE_REF_RE.source, "g"));
			for (const m of fileRefMatches) {
				const ref = m[0].trim();
				if (ref.length > 2) {
					fileRefSet.add(ref);
				}
			}

			// FRICTION blocks — scan per line
			for (const line of text.split("\n")) {
				if (/\[FRICTION\]|type:friction/i.test(line)) {
					frictionBlocks.push(line.trim());
				}
			}
		}
	}

	return {
		storeIds: Array.from(storeIdSet),
		acStateLines,
		transitionLines: Array.from(transitionLineSet),
		fileRefs: Array.from(fileRefSet),
		frictionBlocks,
	};
}

/**
 * Extract text strings from a message-like object.
 * Handles assistant messages (content[].text) and plain strings.
 */
function extractTextContent(msg: unknown): string[] {
	if (typeof msg === "string") {
		return [msg];
	}
	if (typeof msg !== "object" || msg === null) {
		return [];
	}
	const msgObj = msg as Record<string, unknown>;
	const content = msgObj["content"];
	if (!Array.isArray(content)) {
		return [];
	}
	const texts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			texts.push(part);
		} else if (typeof part === "object" && part !== null) {
			const p = part as Record<string, unknown>;
			if (p["type"] === "text" && typeof p["text"] === "string") {
				texts.push(p["text"]);
			}
		}
	}
	return texts;
}

// ---------------------------------------------------------------------------
// Warm-tier helpers
// ---------------------------------------------------------------------------

/** Map phase key to canonical {PHASE}-SUMMARY.json filename. */
function phaseSummaryFilename(phaseKey: string): string {
	const map: Record<string, string> = {
		// Real run-task PHASE_PIPELINE keys (`${personaNoun}/${role}`):
		"engineer/plan": "PLAN-SUMMARY.json",
		"supervisor/review-plan": "REVIEW_PLAN-SUMMARY.json",
		"engineer/implement": "IMPLEMENTATION-SUMMARY.json",
		"supervisor/review-code": "CODE_REVIEW-SUMMARY.json",
		"qa-engineer/validate": "VALIDATION-SUMMARY.json",
		"architect/approve": "APPROVE-SUMMARY.json",
		// Legacy design-time keys (test fixtures only):
		"architect/plan": "PLAN-SUMMARY.json",
		"engineer/review": "REVIEW-SUMMARY.json",
		"engineer/code-review": "CODE_REVIEW-SUMMARY.json",
	};
	return map[phaseKey] ?? "{PHASE}-SUMMARY.json";
}

/** Expected shape of a {PHASE}-SUMMARY.json file. */
interface PhaseSummaryShape {
	objective?: string;
	key_changes?: string[];
}

/** Default summaryReader: synchronous fs.readFileSync. Returns null on any error. */
function defaultSummaryReader(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Read and parse the warm-tier {PHASE}-SUMMARY.json (synchronous).
 * Returns the parsed object or null on any failure (IL7).
 *
 * When summaryReader is provided but cwd/phaseKey/entityId/sprintId are not,
 * calls summaryReader("") — enables test seams that don't need path resolution.
 */
function readWarmTierSummary(opts: ForgeCompactionOptions): PhaseSummaryShape | null {
	try {
		let filePath: string;
		const reader = opts.summaryReader ?? defaultSummaryReader;

		if (opts.cwd && opts.phaseKey && opts.entityId && opts.sprintId) {
			filePath = path.join(
				opts.cwd,
				"engineering",
				"sprints",
				opts.sprintId,
				opts.entityId,
				phaseSummaryFilename(opts.phaseKey),
			);
		} else if (opts.summaryReader) {
			// Test seam: summaryReader present but no path context — call with empty string.
			filePath = "";
		} else {
			return null;
		}

		const raw = reader(filePath);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PhaseSummaryShape;
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Summary assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a compact structured summary string from extracted facts
 * and an optional warm-tier summary.
 */
function assembleSummary(
	facts: ForgeFactSummary,
	warmTier: PhaseSummaryShape | null,
): string {
	const parts: string[] = [];

	// Warm-tier objective (highest information density — prepend).
	if (warmTier?.objective) {
		parts.push(`## Phase Objective\n${warmTier.objective}`);
	}

	// Warm-tier key changes.
	if (warmTier?.key_changes && warmTier.key_changes.length > 0) {
		parts.push(`## Key Changes\n${warmTier.key_changes.map((c) => `- ${c}`).join("\n")}`);
	}

	// Extracted store IDs.
	if (facts.storeIds.length > 0) {
		parts.push(`## Active Store IDs\n${facts.storeIds.join(", ")}`);
	}

	// AC state (checkboxes — capped at 10).
	if (facts.acStateLines.length > 0) {
		const sample = facts.acStateLines.slice(0, 10);
		parts.push(`## Acceptance Criteria State\n${sample.join("\n")}`);
	}

	// Transitions (capped at 5).
	if (facts.transitionLines.length > 0) {
		const sample = facts.transitionLines.slice(0, 5);
		parts.push(`## Status Transitions\n${sample.join("\n")}`);
	}

	// File refs (capped at 10).
	if (facts.fileRefs.length > 0) {
		const sample = facts.fileRefs.slice(0, 10);
		parts.push(`## File References\n${sample.join("\n")}`);
	}

	// FRICTION blocks.
	if (facts.frictionBlocks.length > 0) {
		parts.push(`## FRICTION\n${facts.frictionBlocks.join("\n")}`);
	}

	if (parts.length === 0) {
		return "[Forge context governor — compaction summary — no structured facts extracted]";
	}

	return `[Forge context governor — compaction summary]\n\n${parts.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// buildForgeCompactionFactory — ExtensionFactory builder
// ---------------------------------------------------------------------------

/**
 * Build an ExtensionFactory that registers a session_before_compact handler
 * returning a deterministically-composed CompactionResult.
 *
 * The handler:
 * 1. Validates that event.preparation is present and well-formed.
 * 2. Extracts Forge facts from event.preparation.messagesToSummarize
 *    (no LLM call, provider-neutral).
 * 3. Reads the warm-tier {PHASE}-SUMMARY.json if opts provide path context,
 *    or invokes opts.summaryReader("") as a test seam.
 * 4. Assembles a compact structured summary string.
 * 5. Returns { compaction: { summary, firstKeptEntryId, tokensBefore } }.
 * 6. Returns undefined on any error (IL7 — lets pi compact normally).
 *
 * Pack 07: reads summary files but never writes .forge/store/.
 * IL10: no pi-mono edits, no dispatch contract changes.
 * NOT wired into index.ts/run-task.ts — deferred to T07 production integration.
 *
 * @param opts  ForgeCompactionOptions (default: empty — no warm-tier).
 * @returns ExtensionFactory for passing to DefaultResourceLoader.extensionFactories.
 */
export function buildForgeCompactionFactory(opts: ForgeCompactionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.on(
			"session_before_compact",
			(event: SessionBeforeCompactEvent): SessionBeforeCompactResult | undefined => {
				try {
					// Validate preparation is present and has the required pass-through fields.
					const prep = event?.preparation as
						| {
								firstKeptEntryId?: unknown;
								tokensBefore?: unknown;
								messagesToSummarize?: unknown;
						  }
						| null
						| undefined;

					if (!prep || typeof prep !== "object") {
						return undefined; // IL7 — malformed preparation
					}

					const { firstKeptEntryId, tokensBefore, messagesToSummarize } = prep;

					if (typeof firstKeptEntryId !== "string" || typeof tokensBefore !== "number") {
						return undefined; // IL7 — malformed preparation fields
					}

					// Extract Forge facts from message history.
					const msgs = Array.isArray(messagesToSummarize) ? messagesToSummarize : [];
					const facts = extractForgeFacts(msgs);

					// Read warm-tier summary (best-effort, IL7).
					const warmTier = readWarmTierSummary(opts);

					// Assemble summary string.
					const summary = assembleSummary(facts, warmTier);

					const compaction: CompactionResult = {
						summary,
						firstKeptEntryId,
						tokensBefore,
					};

					return { compaction };
				} catch {
					// IL7: unexpected error → return undefined, let pi compact normally.
					return undefined;
				}
			},
		);
	};
}
