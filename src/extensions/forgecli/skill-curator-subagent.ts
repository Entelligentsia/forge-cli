// Per-task curator subagent — FORGE-S24-T10.
//
// At task close, the orchestrator hands a trajectory summary, the retrieved
// skills' bodies (from T08), and the task outcome to a curator subagent. The
// curator returns zero or more enhancement proposals (insert / update / delete
// of skill artifacts). This module:
//
//   1. Composes a task body that explicitly asks for proposals in a fenced
//      ```json [...] block, with the canonical proposal schema embedded.
//   2. Dispatches via `runForgeSubagent` (Iron Law 10 — fresh in-process pi
//      session, isolated context, persona-only context loader).
//   3. Parses zero or more proposals from the final assistant output, dropping
//      any item that fails TypeBox schema validation.
//   4. Dedupes by `{op, target_path, sha256(diff_body)}` (mirrors T07's drain
//      key — collisions never reach the sprint-close batch).
//   5. Writes the deduped batch to `.forge/enhancement-proposals/queue/<sprintId>/<taskId>-<ts>.json`
//      (T07 layout) only when there is at least one proposal — zero noise on
//      empty curator runs. If the canonical path already exists, the curator
//      retries with a fresh `-N` suffix on the ts (append-only invariant —
//      queue files are never overwritten).
//
// What this module DOES NOT do:
//   - Emit phase events. The orchestrator (caller — `run-task.ts`,
//     `fix-bug.ts`, gated behind FORGE-S24-T12 feature flag) is responsible
//     for the Slice 2 contract: composing & emitting the canonical phase
//     event from runtime telemetry. The curator subagent NEVER calls
//     `store-cli emit` (IL10 / telemetry-actor-split).
//   - Write to `forge/forge/meta/skills/` or `.forge/skills/`. The queue
//     file is the sole sink. (TASK_PROMPT Acceptance Criterion 5.)
//   - Decide WHEN task-close is. The caller invokes this at task close.
//
// Iron Laws (forge-cli-engineer):
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL2  — TypeScript + TypeBox; runtime input validated by Value.Parse.
//   IL6  — no shell-string interpolation (no subprocess here; runForgeSubagent
//          owns its spawn discipline).
//   IL7  — failures return a typed result; subagent error surfaces in the
//          returned record.
//   IL10 — orchestrator dispatch via runForgeSubagent; this module emits
//          ZERO phase events; the orchestrator owns runtime attribution and
//          event emission after this function returns.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	getFinalOutput,
	runForgeSubagent,
	type ForgePersona,
	type SubagentResult,
} from "./forge-subagent.js";

// ── Public schemas ────────────────────────────────────────────────────────

/**
 * One retrieved skill (T08 output) supplied to the curator as context.
 * `body` is the actual SKILL.md text the agent was shown during the task —
 * the curator reads it to decide whether the skill needs updating.
 */
export const RetrievedSkillBodySchema = Type.Object({
	skillId: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	body: Type.String(),
});
export type RetrievedSkillBody = Static<typeof RetrievedSkillBodySchema>;

export const TaskOutcomeSchema = Type.Object({
	verdict: Type.Union([
		Type.Literal("approved"),
		Type.Literal("revision"),
		Type.Literal("failed"),
		Type.Literal("aborted"),
	]),
	notes: Type.Optional(Type.String()),
});
export type TaskOutcome = Static<typeof TaskOutcomeSchema>;

export const CuratorInputSchema = Type.Object({
	sprintId: Type.String({ minLength: 1 }),
	taskId: Type.String({ minLength: 1 }),
	cwd: Type.String({ minLength: 1 }),
	ts: Type.String({ minLength: 1 }),
	trajectorySummary: Type.String(),
	retrievedSkills: Type.Array(RetrievedSkillBodySchema),
	outcome: TaskOutcomeSchema,
});
export type CuratorInput = Static<typeof CuratorInputSchema>;

/**
 * The enhancement proposal schema accepted by this module — mirrors
 * `forge/forge/schemas/proposal.schema.json` (the queue-drain contract).
 * `op` is restricted to the canonical three-op enum; other fields are
 * passed through verbatim if present.
 *
 * Strict on required keys (so malformed items are dropped), permissive on
 * optional keys (so the curator can supply rationale, sourceFrictionIds,
 * generated_at, etc., without us re-enumerating the entire schema here).
 */
const ProposalSchema = Type.Object(
	{
		op: Type.Union([
			Type.Literal("insert_skill"),
			Type.Literal("update_skill"),
			Type.Literal("delete_skill"),
		]),
		target_path: Type.String({ minLength: 1 }),
		diff_body: Type.String(),
		// Optional pass-through fields (kept minimal — extra unknown keys are
		// also allowed; we use additionalProperties: true to let the curator
		// supply rationale / sourceFrictionIds / generated_at / sprintId).
		rationale: Type.Optional(Type.String()),
		sourceFrictionIds: Type.Optional(Type.Array(Type.String())),
		generated_at: Type.Optional(Type.String()),
		sprintId: Type.Optional(Type.String()),
		proposalId: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
export type Proposal = Static<typeof ProposalSchema>;

export interface CuratorResult {
	exitCode: 0 | 1;
	written: number;
	queueFile?: string;
	errorMessage?: string;
}

// ── Task-body composition ─────────────────────────────────────────────────

/**
 * Compose the first user message for the curator subagent. The body embeds
 * the trajectory summary, retrieved-skill bodies, and task outcome, and
 * instructs the curator to return zero or more proposals in a fenced JSON
 * block. The schema is described inline so the curator does not need to
 * read an external file.
 */
export function composeCuratorTask(input: CuratorInput): string {
	const lines: string[] = [];
	lines.push(`# Skill-curator task — ${input.taskId}`);
	lines.push("");
	lines.push(
		"You are reviewing one closed Forge task to decide whether any retrieved",
		"skill should be inserted, updated, or deleted based on what the agent",
		"actually did. Output zero or more enhancement proposals — empty is fine",
		"when nothing useful was learned.",
		"",
	);
	lines.push("## Sprint / Task");
	lines.push(`- sprintId: ${input.sprintId}`);
	lines.push(`- taskId:   ${input.taskId}`);
	lines.push(`- verdict:  ${input.outcome.verdict}`);
	if (input.outcome.notes) {
		lines.push(`- notes:    ${input.outcome.notes}`);
	}
	lines.push("");
	lines.push("## Trajectory summary");
	lines.push(input.trajectorySummary || "(none)");
	lines.push("");
	lines.push("## Retrieved skills (the agent was shown these)");
	if (input.retrievedSkills.length === 0) {
		lines.push("(none)");
	} else {
		for (const s of input.retrievedSkills) {
			lines.push(`### ${s.name} (skillId: ${s.skillId})`);
			lines.push("```");
			lines.push(s.body);
			lines.push("```");
			lines.push("");
		}
	}
	lines.push("## Output format");
	lines.push(
		"Return a single fenced ```json``` block containing a JSON array.",
		"Each array element is one proposal with these required keys:",
		"  - op:          one of \"insert_skill\" | \"update_skill\" | \"delete_skill\"",
		"  - target_path: repository-relative path (e.g. forge/skills/engineer-skills.md)",
		"  - diff_body:   unified-diff body, or full file body for inserts;",
		"                 may be empty string for delete_skill",
		"Optional keys: rationale, sourceFrictionIds, generated_at, sprintId.",
		"",
		"If there is nothing to propose, emit an empty array `[]`.",
		"Do NOT write any file yourself. Do NOT call store-cli or emit events.",
		"Your output is consumed by the orchestrator, which writes the queue file.",
	);
	return lines.join("\n");
}

// ── Output parsing ────────────────────────────────────────────────────────

/**
 * Pull zero or more proposals from the curator's final assistant text.
 * Strategy: try fenced ```json blocks first (the requested format), then
 * fall back to a bare JSON array scan. Items that fail TypeBox validation
 * are dropped — the failure mode for ill-formed proposals is silent
 * exclusion, not exception, because the curator's output is best-effort.
 */
export function parseProposalsFromOutput(text: string): Proposal[] {
	if (typeof text !== "string" || text.length === 0) return [];

	const candidates: unknown[] = [];

	// 1. Fenced ```json blocks (preferred).
	const fenceRe = /```(?:json|JSON)\s*([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = fenceRe.exec(text)) !== null) {
		const inner = m[1].trim();
		const parsed = tryParseJsonArray(inner);
		if (parsed) candidates.push(...parsed);
	}

	// 2. Fallback: scan for a bare JSON array if no fenced block produced
	//    items. Cheap heuristic — find the first `[` and try to parse from
	//    there to the matching `]`.
	if (candidates.length === 0) {
		const start = text.indexOf("[");
		if (start >= 0) {
			// Greedy: try the substring from `[` to the last `]`.
			const end = text.lastIndexOf("]");
			if (end > start) {
				const inner = text.slice(start, end + 1);
				const parsed = tryParseJsonArray(inner);
				if (parsed) candidates.push(...parsed);
			}
		}
	}

	const out: Proposal[] = [];
	for (const c of candidates) {
		if (Value.Check(ProposalSchema, c)) {
			out.push(c as Proposal);
		}
	}
	return out;
}

function tryParseJsonArray(s: string): unknown[] | null {
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

// ── Dedupe ────────────────────────────────────────────────────────────────

/**
 * Mirror T07's `dedupeKey`: composite of op, target_path, sha256(diff_body).
 * First-seen-wins.
 */
function dedupeKey(p: Proposal): string {
	const h = crypto
		.createHash("sha256")
		.update(p.diff_body ?? "", "utf8")
		.digest("hex");
	return `${p.op}|${p.target_path}|${h}`;
}

function dedupeProposals(items: readonly Proposal[]): Proposal[] {
	const seen = new Set<string>();
	const out: Proposal[] = [];
	for (const p of items) {
		const k = dedupeKey(p);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(p);
	}
	return out;
}

// ── Queue write ───────────────────────────────────────────────────────────

/**
 * Compute the canonical queue file path. T07 layout:
 *   <cwd>/.forge/enhancement-proposals/queue/<sprintId>/<taskId>-<ts>.json
 *
 * If the canonical path already exists, suffix `-1`, `-2`, … until a free
 * slot is found. Caller never overwrites an existing file (append-only).
 */
function chooseQueuePath(input: CuratorInput): string {
	const dir = path.join(
		input.cwd,
		".forge",
		"enhancement-proposals",
		"queue",
		input.sprintId,
	);
	const base = `${input.taskId}-${input.ts}`;
	let candidate = path.join(dir, `${base}.json`);
	let n = 1;
	while (fs.existsSync(candidate)) {
		candidate = path.join(dir, `${base}-${n}.json`);
		n++;
	}
	return candidate;
}

function writeQueueFile(filePath: string, proposals: readonly Proposal[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(proposals, null, 2), "utf8");
}

// ── Curator persona ───────────────────────────────────────────────────────

/**
 * Inline curator persona. We do NOT add a file under
 * `forge/forge/meta/personas/` (Iron Law 1 — forge-cli only). The persona
 * system prompt is small and self-contained; it tells the LLM to act as a
 * skill curator and reiterates the output format and the no-write rule.
 *
 * The persona is exported so tests can introspect it; in production the
 * defaultCuratorPersona() factory is consumed by runSkillCurator.
 */
export function defaultCuratorPersona(): ForgePersona {
	const systemPrompt = [
		"You are the Forge **skill curator**.",
		"",
		"Your sole job is to look at one closed task — the trajectory summary,",
		"the skills the agent was shown, and the outcome — and propose zero or",
		"more enhancement proposals (insert / update / delete of skill artifacts).",
		"",
		"Hard rules:",
		"  - You NEVER write files yourself. Output proposals only.",
		"  - You NEVER call store-cli, emit events, or invoke tools that mutate",
		"    `.forge/store/`, `forge/skills/`, or `forge/meta/`.",
		"  - You return your proposals as a single fenced ```json``` block",
		"    containing a JSON array. Empty array `[]` is a valid answer.",
		"  - Each proposal MUST have: op, target_path, diff_body.",
		"    op ∈ { insert_skill, update_skill, delete_skill }.",
		"  - Be conservative: empty array beats a noisy or speculative proposal.",
	].join("\n");
	return {
		name: "skill-curator",
		description: "Forge per-task skill curator",
		// Persona-only context (no extensions/skills/prompts) — read & write are
		// not needed; we don't pass `tools` so pi's defaults apply, but the
		// system prompt forbids writes. Caller may override.
		systemPrompt,
		filePath: "<inline:skill-curator>",
	};
}

// ── Main entry ────────────────────────────────────────────────────────────

/**
 * Run the per-task curator subagent and write its proposals to the
 * enhancement-proposals queue. Always returns a typed result; never throws
 * on subagent failure (IL7).
 *
 * Caller (orchestrator) is responsible for:
 *   - assembling `retrievedSkills` from the T08 retriever's output;
 *   - assembling `trajectorySummary` from the task transcript;
 *   - emitting the canonical phase event AFTER this call returns,
 *     using its own captured runtime telemetry (Slice 2 contract).
 */
export async function runSkillCurator(input: CuratorInput): Promise<CuratorResult> {
	Value.Parse(CuratorInputSchema, input);

	const persona = defaultCuratorPersona();
	const task = composeCuratorTask(input);

	let subResult: SubagentResult;
	try {
		subResult = await runForgeSubagent({
			persona,
			task,
			cwd: input.cwd,
			exportTag: `${input.taskId}__skill-curator`,
		});
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			exitCode: 1,
			written: 0,
			errorMessage: e.message ?? "runForgeSubagent threw",
		};
	}

	if (subResult.exitCode !== 0) {
		return {
			exitCode: 1,
			written: 0,
			errorMessage: subResult.errorMessage ?? subResult.stopReason ?? "subagent failed",
		};
	}

	const finalText = getFinalOutput(subResult.messages);
	const proposals = parseProposalsFromOutput(finalText);
	const deduped = dedupeProposals(proposals);

	if (deduped.length === 0) {
		return { exitCode: 0, written: 0 };
	}

	const queueFile = chooseQueuePath(input);
	writeQueueFile(queueFile, deduped);
	return { exitCode: 0, written: deduped.length, queueFile };
}
