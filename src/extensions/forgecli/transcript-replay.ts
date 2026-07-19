// transcript-replay.ts — hydrate a DETACHED OrchestratorTree from an
// archived run, so the existing dashboard TUI can render it as a read-only
// replay (`openDashboardTui(ctx, { tree, readOnly: true })`).
//
// Bridge between three subsystems — transcript-archive (data source),
// orchestrator-tree (model), dashboard (consumer) — hence a top-level
// module, pure/headless and unit-testable with no TUI in the loop.
//
// NEVER touches the live singleton (`getOrchestratorTree()`): a replay tree
// is always `new OrchestratorTree()`, and thread-switcher is guarded against
// memoizing injected trees into its live `treeRef`.

import { OrchestratorTree, type NodeStatus } from "./orchestrator-tree.js";
import { digestPhasePayloadVerbose, gunzipPhase, gunzipTailLog } from "./transcript-archive.js";
import type { RunManifest, RunOutcome } from "./transcript-archive-types.js";

/**
 * Tail entries appended per phase leaf. The tree's tail buffer keeps the
 * NEWEST 2048 entries (live semantics: trim oldest) — wrong direction for
 * replay, where the head of the transcript is the valuable part. We
 * head-truncate the digest BEFORE appending so the buffer never trims.
 */
export const REPLAY_TAIL_BUDGET = 1500;

/** Map a run outcome to a tree node status (root node). */
export function mapOutcomeToStatus(outcome: RunOutcome): NodeStatus {
	switch (outcome) {
		case "complete":
			return "completed";
		case "halted":
			return "escalated";
		case "cancelled":
			return "cancelled";
		case "error":
		case "incomplete":
			return "failed";
	}
}

/**
 * Map an archived phase verdict to a leaf node status. Verdicts come from
 * orchestrator phase-end events: "approved" | "revision" | "n/a" | "error" |
 * "cancelled" | "halted" (plus free-form legacy strings).
 */
export function mapVerdictToStatus(verdict: string, runOutcome: RunOutcome): NodeStatus {
	switch (verdict) {
		case "approved":
			return "completed";
		case "revision":
			// The phase ran to completion; its review demanded another pass.
			return "completed";
		case "error":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "halted":
			return "escalated";
		default:
			// "n/a" and unknowns: the phase itself finished; only a run that
			// died mid-flight should taint its phases.
			return runOutcome === "complete" ? "completed" : mapOutcomeToStatus(runOutcome);
	}
}

export interface ReplayResult {
	tree: OrchestratorTree;
	rootId: string;
}

/**
 * Build a detached OrchestratorTree mirroring one archived run: root node =
 * the run, one leaf per phase attempt, tails from the gunzipped phase
 * digests, timestamps backfilled from the archive so elapsed times render
 * frozen (formatMetrics uses `endedAt ?? Date.now()`).
 */
export function hydrateRunTree(manifest: RunManifest, runDir: string): ReplayResult {
	const tree = new OrchestratorTree();
	const rootId = manifest.runId;
	const runStartMs = Date.parse(manifest.startedAt);

	tree.startNode(rootId, {
		kind: "orchestrator",
		label: `${manifest.entityId} · ${manifest.runId} · ${manifest.outcome}`,
		...(manifest.sprintId ? { promptPreview: `sprint: ${manifest.sprintId}` } : {}),
	});

	for (const phase of manifest.phases) {
		const leafId = `${rootId}:${phase.role}:${phase.attempt}`;
		// Read the archived payload once per phase: the prompt for the
		// node's Prompt panel, and (legacy runs) the digest fallback below.
		const payload = phase.file ? gunzipPhase(runDir, phase.file) : null;
		const prompt = typeof payload?.prompt === "string" && payload.prompt.length > 0 ? payload.prompt : undefined;
		tree.startNode(leafId, {
			parentId: rootId,
			kind: "leaf",
			label: `${phase.role}#${phase.attempt}`,
			...(prompt ? { promptPreview: prompt } : {}),
		});

		if (phase.model && phase.provider) tree.setNodeModel(leafId, phase.model, phase.provider);
		if (phase.usage) {
			tree.setNodeUsage(leafId, {
				input: phase.usage.input,
				output: phase.usage.output,
				cacheRead: phase.usage.cacheRead,
				context: phase.usage.contextTokens ?? 0,
			});
			const node = tree.getNode(leafId);
			if (node && typeof phase.usage.turns === "number") node.metrics.turn = phase.usage.turns;
		}
		tree.setNodeIteration(leafId, phase.attempt);
		if (phase.verdict && phase.verdict !== "n/a") tree.setNodeOutcome(leafId, phase.verdict);

		// Tail, two sources in preference order:
		//   1. The archived live tail log (`*.tail.jsonl`) — the EXACT lines
		//      the dashboard rendered during the run. Replay = verbatim
		//      re-read; identical to what the user saw live.
		//   2. Legacy runs without a tail log: a verbose per-turn digest of
		//      the archived payload (full assistant text, tool args/result
		//      previews) — readable, but a reconstruction.
		// Both head-truncated to the replay budget.
		const tailEntries = phase.tailFile ? gunzipTailLog(runDir, phase.tailFile) : null;
		if (tailEntries && tailEntries.length > 0) {
			const head = tailEntries.slice(0, REPLAY_TAIL_BUDGET);
			for (const entry of head) {
				tree.appendTail(leafId, entry.line, entry.warning ? { warning: true } : undefined);
			}
			if (tailEntries.length > head.length) {
				tree.appendTail(leafId, `… (${tailEntries.length - head.length} more lines — see /forge:transcripts show)`);
			}
		} else {
			if (payload) {
				const digest = digestPhasePayloadVerbose(payload);
				const head = digest.slice(0, REPLAY_TAIL_BUDGET);
				for (const line of head) tree.appendTail(leafId, line);
				if (digest.length > head.length) {
					tree.appendTail(leafId, `… (${digest.length - head.length} more digest lines — see /forge:transcripts show)`);
				}
			} else {
				tree.appendTail(leafId, "(no archived transcript for this phase)");
			}
		}

		tree.completeNode(leafId, mapVerdictToStatus(phase.verdict, manifest.outcome));

		// Backfill archived wall times AFTER completeNode (which stamps
		// endedAt = Date.now()) so elapsed renders frozen, not live.
		const node = tree.getNode(leafId);
		if (node) {
			const startMs = phase.startedAt ? Date.parse(phase.startedAt) : runStartMs;
			node.startedAt = Number.isFinite(startMs) ? startMs : runStartMs;
			node.endedAt = node.startedAt + (phase.elapsedMs ?? 0);
		}
	}

	tree.completeNode(rootId, mapOutcomeToStatus(manifest.outcome));
	const root = tree.getNode(rootId);
	if (root) {
		root.startedAt = Number.isFinite(runStartMs) ? runStartMs : root.startedAt;
		root.endedAt = manifest.finishedAt
			? Date.parse(manifest.finishedAt)
			: root.startedAt + (manifest.durationMs ?? 0);
	}

	return { tree, rootId };
}
