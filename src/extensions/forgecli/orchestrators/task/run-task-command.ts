// run-task-command.ts — the /forge:run-task command handler (config discovery,
// task-ID resolution, resume detection, session registration, then delegate to
// runTaskPipeline). Extracted VERBATIM from run-task.ts (no logic changes).

import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { type ForgeToolDefs } from "../../forge-tools.js";
import { createOrchestratorNotifier } from "../common/orchestrator-notify.js";
import { resolveOrchestratorEntry } from "../common/orchestrator-entry.js";
import { getSessionRegistry } from "../../session-registry.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";
import { archiveRun } from "../../transcript-archive.js";
import { resolveToCanonicalId, resolveToolDir } from "../../store/store-resolver.js";

import { isNonInteractive } from "../common/orchestrator-misc.js";
import { formatLocalTime } from "../common/orchestrator-misc.js";
import { PHASES } from "./task-phases.js";
import { readTaskRecord } from "./task-record.js";
import { type RunTaskState, deleteState, isStateStale, readState } from "./task-state.js";
import { runTaskPipeline } from "./run-task-pipeline.js";

const STATUS_KEY = "forge:run-task";
const MESSAGE_KEY = "forge:run-task:message";

// ── Thin wrapper registration ────────────────────────────────────────────

export interface RegisterRunTaskOptions {
	cwd?: string;
	forgeToolDefs?: ForgeToolDefs;
	/** Extension factories forwarded to each subagent (see RunTaskPipelineOptions). */
	extensionFactories?: ExtensionFactory[];
}

export function registerRunTask(pi: ExtensionAPI, options: RegisterRunTaskOptions = {}): void {
	pi.registerCommand("forge:run-task", {
		description:
			"Run the full task pipeline (plan → review → implement → validate → approve → commit). " +
			"Usage: /forge:run-task <TASK_ID>. " +
			"Orchestrator archetype: each phase is an isolated subagent session (IL10).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			let taskId = args.trim();

			if (!taskId) {
				ctx.ui.notify("× forge:run-task — task ID required. Usage: /forge:run-task <TASK_ID>", "error");
				return;
			}

			const notify = createOrchestratorNotifier(ctx, {
				label: "forge:run-task",
				statusKey: STATUS_KEY,
				messageKey: MESSAGE_KEY,
			});
			notify.setStatus(`run-task ${taskId}: initializing…`);

			// ── Discover forge config + sweep orphaned transcripts ───────────
			const entry = resolveOrchestratorEntry({ cwd, notify });
			if (!entry) return;
			const { forgeRoot, storeCli, preflightGate } = entry;

			// ── Resolve task ID (prefix-normalize, suffix-match, NLP fallback) ──
			// Handles unprefixed IDs like "S22-T03" → "FORGE-S22-T03".
			// Issue #20: unprefixed task IDs silently poisoned substitutions.
			// NOTE: resolveToCanonicalId may surface ctx.ui.select (disambiguation)
			// or ctx.ui.confirm prompts. The session must NOT be registered yet
			// at this point — the chip strip would appear before the user has
			// chosen which task they meant, stealing arrow keys from the dialog.
			const toolDir = resolveToolDir(forgeRoot);
			const resolvedTaskId = await resolveToCanonicalId(taskId, toolDir, cwd, "task", {
				ctx,
				commandLabel: "forge:run-task",
			});
			if (!resolvedTaskId) {
				// Error already emitted by resolver
				notify.clearStatus();
				return;
			}

			// Replace raw arg with canonical ID for all subsequent operations
			// (state files, store reads, preflight gates, orchestrator emits).
			// Issue #20: unprefixed task IDs silently poisoned substitutions.
			taskId = resolvedTaskId;

			// Update status with canonical ID so the user sees the resolved form.
			notify.setStatus(`run-task ${taskId}: ready`);

			// ── Resume detection ─────────────────────────────────────────────
			const existing = readState(cwd, taskId);
			let resumeFromState: RunTaskState | undefined;

			if (existing) {
				if (isStateStale(existing)) {
					// Stale state: notify + offer purge
					ctx.ui.notify(
						`⚠ forge:run-task — cached state for ${taskId} is stale (>7 days old, saved at ${formatLocalTime(existing.savedAt)}). ` +
							"Offering purge.",
						"warning",
					);
					if (!isNonInteractive()) {
						const purge = await ctx.ui.confirm(
							`Purge stale state for ${taskId}?`,
							"The cached state is older than 7 days. Purge and restart from the beginning?",
						);
						if (purge) {
							deleteState(cwd, taskId);
						} else {
							ctx.ui.notify("forge:run-task — stale state kept; aborting.", "info");
							ctx.ui.setStatus?.(STATUS_KEY, undefined);
							ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
							return;
						}
					} else {
						// Non-interactive: auto-abort on stale state
						ctx.ui.notify("forge:run-task — stale state; non-interactive mode auto-aborting.", "info");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}
				} else {
					// Fresh state: offer resume for ALL non-stale states — halted=true
					// (explicit failure), halted=false (cancelled/interrupted), and
					// any state with existing.status set (ADR-S21-01).
					const stateStatus = existing.status ?? (existing.halted ? "halted" : "interrupted");
					const statusLabel =
						stateStatus === "cancelled" ? "cancelled" : stateStatus === "halted" ? "halted" : "interrupted";
					const phaseRole = PHASES[existing.phaseIndex]?.role ?? existing.phaseIndex;
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume ${taskId}?`,
							`Cached state — phase ${existing.phaseIndex} (${phaseRole}), ${statusLabel}, ` +
								`saved at ${formatLocalTime(existing.savedAt)}. Resume from here?`,
						);
						if (resume) {
							resumeFromState = existing;
							ctx.ui.notify(
								`forge:run-task — resuming ${taskId} from phase ${phaseRole} (${statusLabel})`,
								"info",
							);
						} else {
							deleteState(cwd, taskId);
						}
					} else {
						// Non-interactive: auto-resume from state (no confirmation).
						// Cancelled/interrupted states are valid resume points.
						resumeFromState = existing;
						ctx.ui.notify(`forge:run-task — resuming ${taskId} from phase ${phaseRole} (${statusLabel})`, "info");
					}
				}
			}

			// ── Register session & delegate to pipeline ────────────────────
			// Session registration MUST happen after all interactive disambiguation
			// (resolveToCanonicalId, resume confirm) so the chip strip doesn't appear
			// before the user has confirmed which task they meant — the strip would
			// steal arrow keys from ctx.ui.select / ctx.ui.confirm dialogs.
			const registry = getSessionRegistry();
			registry.startSession(taskId);

			// Bridge: also register in OrchestratorTree for the dashboard overlay.
			const tree = getOrchestratorTree();
			tree.startNode(taskId, { label: taskId, kind: "orchestrator" });

			const signal = registry.getAbortSignal(taskId);
			const pipelineResult = await runTaskPipeline({
				taskId,
				cwd,
				ctx,
				forgeRoot,
				storeCli,
				preflightGate,
				registry,
				resumeFromState,
				signal,
				forgeToolDefs: options.forgeToolDefs,
				extensionFactories: options.extensionFactories,
			});

			// ── Handle result ────────────────────────────────────────────────
			if (pipelineResult.status === "completed") {
				registry.completeSession(taskId, "completed");
				tree.completeNode(taskId, "completed");
				ctx.ui.notify(`〇 forge:run-task — ${taskId} pipeline complete (${PHASES.length} phases).`, "info");
			} else if (pipelineResult.status === "cancelled") {
				// confirmCancelled was already called by the pipeline, but
				// completeSession("cancelled") ensures the session ends cleanly.
				registry.completeSession(taskId, "cancelled");
				tree.completeNode(taskId, "cancelled");
			} else {
				registry.completeSession(taskId, "failed");
				tree.completeNode(taskId, "failed");
			}

			// Mirror this run into the central transcript archive (best-effort —
			// archiveRun never throws). sprintId back-reference from the task
			// record; list/timeline group on it (no synthetic sprint container).
			if (pipelineResult.orchestratorTranscriptPath) {
				const sprintIdForArchive = readTaskRecord(taskId, storeCli, cwd)?.sprintId;
				archiveRun({
					cwd,
					orchestratorJsonlPath: pipelineResult.orchestratorTranscriptPath,
					...(sprintIdForArchive ? { sprintId: sprintIdForArchive } : {}),
				});
			}

			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
		},
	});
}
