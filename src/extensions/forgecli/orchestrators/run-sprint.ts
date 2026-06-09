// run-sprint.ts — /forge:run-sprint native Orchestrator handler (FORGE-S21-T03, Plan 12).
//
// Sprint-level orchestrator that iterates over a sprint's task list,
// delegating per-task execution to runTaskPipeline (extracted from run-task.ts).
//
// The sprint handler does NOT contain its own phase loop; per-phase concerns
// are ALL delegated to runTaskPipeline. The sprint handler owns sprint
// coordination only: resolve sprint, confirm gates, iterate tasks, persist
// sprint state, dispatch architect ceremony, and emit sprint-scoped events.
//
// Plan 12 truth table (§3):
//   Clean-complete   → architect ceremony (mode=complete) → sprint-complete event
//   User-paused      → architect ceremony (mode=partial) if ≥1 task done → sprint-complete event (verdict=partial)
//   Halted-on-failure → NO ceremony → sprint-halted event
//
// Iron Laws enforced here:
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff)
//
// sendKickoff is NEVER called from this file.
// Audit-grep: grep -n "sendKickoff(" run-sprint.ts must return empty.
//
// N-H-D — Ceremony vs per-task model routing:
//   The sprint ceremony phase (architect summary / sprint-complete event) uses
//   loadLayeredConfig + lookupPersonaModel directly (~lines 216, 227) without
//   calling validateModelConfig. This is intentional: the ceremony is a single
//   LLM call with a known model and the overhead of full preflight validation
//   is not warranted here.
//   Per-task dispatch is entirely delegated to runTaskPipeline, which calls
//   runOrchestratorPreflight (persona/model config validation) at entry before
//   any LLM dispatch. The two paths are deliberately separate.
//   Reference: orchestrator-preflight.ts (N-H-D, FORGE-S25-T17).

import { spawnSync } from "node:child_process";
import * as path from "node:path";
// ModelRegistry/AuthStorage no longer instantiated here — see fix-bug.ts note
// (FORGE-BUG-001). Use ctx.modelRegistry so session-registered providers are
// honored by validateModelConfig.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { assertAudience } from "../audience-gate.js";
import { loadLayeredConfig } from "../config/config-layer.js";
import type { ForgeToolDefs } from "../forge-tools.js";
import { emitSyntheticEvent, type SprintCollateCompleteEvent } from "../hook-dispatcher.js";
import { createOrchestratorNotifier } from "./common/orchestrator-notify.js";
import { gatherModelValidationInputs, resolveOrchestratorEntry } from "./common/orchestrator-entry.js";
import { archiveRun } from "../transcript-archive.js";
import { checkMaterialization } from "../lib/manifest-checker.js";
import { validateModelConfig } from "../config/model-validator.js";
import { loadWorkflow } from "../parsers/workflow-loader.js";
import { getSessionRegistry } from "../session-registry.js";
import { getOrchestratorTree } from "../orchestrator-tree.js";
import { resolveToCanonicalId, resolveToolDir } from "../store/store-resolver.js";
import {
	type SprintStreamFnFactory,
	dispatchSprintCeremony,
} from "./sprint/sprint-ceremony.js";
import {
	deleteSprintState,
	isSprintStateStale,
	readSprintRecord,
	readSprintState,
	writeSprintState,
} from "./sprint/sprint-state.js";

// Re-export for test seams + RegisterRunSprintOptions (forge-cli#17). The type
// is defined in sprint-ceremony.ts; both that module and this handler share it.
export type { SprintStreamFnFactory } from "./sprint/sprint-ceremony.js";

import {
	emitEvent,
	formatLocalTime,
	isNonInteractive,
	isoCompact,
	isStateStale,
	type RunTaskPipelineResult,
	type RunTaskState,
	readState as readTaskState,
	runTaskPipeline,
	validateId,
} from "./run-task.js";

// ── Registration ──────────────────────────────────────────────────────────

export interface RegisterRunSprintOptions {
	cwd?: string;
	/**
	 * Test-only seam (forge-cli#17). When set, each `runForgeSubagent` call
	 * spawned by the sprint handler (ceremony) and by the per-task pipeline
	 * (each phase) is dispatched with `streamFn = factory({...})`. Production
	 * callers leave this undefined.
	 */
	streamFnFactory?: SprintStreamFnFactory;
	forgeToolDefs?: ForgeToolDefs;
	/** Extension factories forwarded to each task's subagent sessions (see RunTaskPipelineOptions). */
	extensionFactories?: ExtensionFactory[];
}

const SPRINT_STATUS_KEY = "forge:run-sprint";

export function registerRunSprint(pi: ExtensionAPI, options: RegisterRunSprintOptions = {}): void {
	pi.registerCommand("forge:run-sprint", {
		description:
			"Run all tasks in a sprint sequentially. " +
			"Usage: /forge:run-sprint <SPRINT_ID>. " +
			"Orchestrator archetype: delegates per-task execution to runTaskPipeline.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			let sprintId = args.trim();

			if (!sprintId) {
				ctx.ui.notify("× forge:run-sprint — sprint ID required. Usage: /forge:run-sprint <SPRINT_ID>", "error");
				return;
			}

			// Path traversal validation (advisory #3)
			if (!validateId(sprintId)) {
				ctx.ui.notify(`× forge:run-sprint — invalid sprint ID format: ${sprintId}`, "error");
				return;
			}

			const notify = createOrchestratorNotifier(ctx, {
				label: "forge:run-sprint",
				statusKey: SPRINT_STATUS_KEY,
			});
			notify.setStatus(`run-sprint ${sprintId}: initializing…`);

			// ── Discover forge config + sweep orphaned transcripts ───────────
			const entry = resolveOrchestratorEntry({ cwd, notify });
			if (!entry) return;
			const { forgeRoot, storeCli, preflightGate } = entry;

			// ── Resolve sprint ID (prefix-normalize, suffix-match, NLP fallback) ──
			// Handles unprefixed IDs like "S22" → "FORGE-S22".
			// Issue #20: unprefixed entity IDs silently poisoned substitutions.
			const toolDir = resolveToolDir(forgeRoot);
			const resolvedSprintId = await resolveToCanonicalId(sprintId, toolDir, cwd, "sprint", {
				ctx,
				commandLabel: "forge:run-sprint",
			});
			if (!resolvedSprintId) {
				// Error already emitted by resolver
				notify.clearStatus();
				return;
			}

			// Replace raw arg with canonical ID for all subsequent operations.
			sprintId = resolvedSprintId;

			// Update status with canonical ID so the user sees the resolved form.
			notify.setStatus(`run-sprint ${sprintId}: ready`);

			// ── Sprint resolution ────────────────────────────────────────────
			const sprintRecord = readSprintRecord(sprintId, storeCli, cwd);
			if (!sprintRecord) {
				ctx.ui.notify(`× forge:run-sprint — could not read sprint ${sprintId} or sprint has no task IDs.`, "error");
				ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
				return;
			}
			const taskIds = sprintRecord.taskIds;
			ctx.ui.notify(`▶ forge:run-sprint — sprint ${sprintId}: ${taskIds.length} tasks`, "info");

			// ── Audience check (AC B-12) ──────────────────────────────────────
			// Read the run_sprint workflow for audience check.
			const workflowPath = path.join(cwd, ".forge", "workflows", "run_sprint.md");
			let workflowMd: string;
			let workflowAudience: string = "any";
			try {
				const loaded = loadWorkflow(workflowPath);
				workflowMd = loaded.rawMarkdown;
				workflowAudience = loaded.audience;
			} catch {
				// Workflow file may not exist — default to orchestrator-only since
				// /forge:run-sprint is an orchestrator archetype command.
				workflowMd = "";
				workflowAudience = "orchestrator-only";
			}
			if (!assertAudience({ workflowName: "run_sprint", audience: workflowAudience as any }, ctx)) {
				ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
				return;
			}

			// ── Materialization-marker check (AC B-5) ────────────────────────
			if (workflowMd) {
				const markerCheck = checkMaterialization(workflowPath, workflowMd);
				if (!markerCheck.ok) {
					for (const marker of markerCheck.missing) {
						ctx.ui.notify(`× workflow regression: ${marker} not found in ${workflowPath}`, "error");
					}
					ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
					return;
				}
			}

			// ── Pre-flight confirm (AC B-7) ───────────────────────────────────
			if (!isNonInteractive()) {
				const proceed = await ctx.ui.confirm(`Begin sprint ${sprintId}?`, `Tasks: ${taskIds.join(", ")}`);
				if (!proceed) {
					ctx.ui.notify("forge:run-sprint — sprint aborted.", "info");
					ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
					return;
				}
			}

			// ── Sprint-level resume detection (AC B-11) ──────────────────────
			const existingSprintState = readSprintState(cwd, sprintId);
			let startTaskIndex = 0;
			let completedTaskIds: string[] = [];
			const resumeTaskStates: Map<string, RunTaskState> = new Map();

			if (existingSprintState) {
				if (isSprintStateStale(existingSprintState)) {
					ctx.ui.notify(
						`⚠ forge:run-sprint — cached sprint state for ${sprintId} is stale (>7 days old, saved at ${formatLocalTime(existingSprintState.savedAt)}). Offering purge.`,
						"warning",
					);
					if (!isNonInteractive()) {
						const purge = await ctx.ui.confirm(
							`Purge stale sprint state for ${sprintId}?`,
							"The cached state is older than 7 days. Purge and restart from the beginning?",
						);
						if (purge) {
							deleteSprintState(cwd, sprintId);
						} else {
							ctx.ui.notify("forge:run-sprint — stale state kept; aborting.", "info");
							ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
							return;
						}
					} else {
						// Non-interactive: auto-abort on stale state (advisory #9)
						ctx.ui.notify("forge:run-sprint — stale sprint state; non-interactive mode auto-aborting.", "info");
						ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
						return;
					}
				} else {
					// Fresh state: offer resume
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume sprint ${sprintId}?`,
							`Cached state found at task ${existingSprintState.taskIndex} (${existingSprintState.completedTaskIds.length} completed). Resume from here?`,
						);
						if (resume) {
							startTaskIndex = existingSprintState.taskIndex;
							completedTaskIds = existingSprintState.completedTaskIds;
							ctx.ui.notify(
								`forge:run-sprint — resuming ${sprintId} from task ${taskIds[startTaskIndex] ?? startTaskIndex}`,
								"info",
							);
							// Collect halted and cancelled task states for mid-task resume
							// (REVIEW FIX #2, option b; ADR-S21-01: cancelled states are
							// resumable from the beginning of the cancelled phase).
							for (const taskId of taskIds.slice(startTaskIndex)) {
								const taskState = readTaskState(cwd, taskId);
								if (taskState && (taskState.halted || taskState.status === "cancelled")) {
									resumeTaskStates.set(taskId, taskState);
								}
							}
						} else {
							deleteSprintState(cwd, sprintId);
						}
					} else {
						// Non-interactive + existing state: auto-abort (advisory #9)
						ctx.ui.notify(
							`forge:run-sprint — cached sprint state for ${sprintId} found but non-interactive mode; aborting.`,
							"info",
						);
						ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
						return;
					}
				}
			}

			// ── Model routing pre-flight (Plan 16 Slice 3) ──────────────────────
			// Validate routing config once at sprint start (before any LLM calls).
			// N-B-E: surface schema errors first (Decision 9 — orchestrators fail-fast).
			// See doc/decisions/layered-config-error-policy.md.
			{
				const { merged: modelRoutingConfig, errors: schemaErrors } = loadLayeredConfig(cwd);
				if (schemaErrors.length > 0) {
					for (const e of schemaErrors) {
						notify.error(`forge-cli config schema error: ${e}`);
					}
					notify.clearStatus();
					return;
				}
				const { personaCatalogue, pipelineCatalogue, availableModels } = gatherModelValidationInputs(cwd, ctx);
				const strict = process.env.FORGE_STRICT_MODELS === "1";
				const { errors, warnings } = validateModelConfig(
					personaCatalogue,
					pipelineCatalogue,
					modelRoutingConfig,
					availableModels,
					strict,
				);
				for (const w of warnings) {
					notify.warn(`model routing: ${w.message}`);
				}
				if (errors.length > 0) {
					for (const e of errors) {
						notify.error(`model routing: ${e.message}`);
					}
					notify.clearStatus();
					return;
				}
			}

			// ── Per-task loop (AC B-8) ────────────────────────────────────────
			const registry = getSessionRegistry();
			const tree = getOrchestratorTree();
			let lastModel: string | undefined;
			let lastProvider: string | undefined;
			const sprintStartMs = Date.now();

			// Bridge: register sprint root in OrchestratorTree.
			tree.startNode(sprintId, { label: `wfl:run-sprint`, kind: "orchestrator" });

			// Mirror sprint-level orchestrator decisions onto the sprint root node
			// so the dashboard surfaces the sprint's own narrative (task progress,
			// completion verdict). Per-task/per-phase detail already lands on child
			// task nodes via run-task's notify mirror (withOrchestratorTranscript).
			// run-sprint installs no ctx.ui.notify wrapper (multiple early-return
			// exits make a restore-safe override impractical), so this is an explicit
			// helper.
			const noteSprint = (msg: string, level: "info" | "warning" | "error" = "info"): void => {
				ctx.ui.notify(msg, level);
				tree.appendTail(sprintId, msg, level === "info" ? undefined : { warning: true });
			};

			// ── sprint-start event (forge-engineering#39) ─────────────────────
			// Per _fragments/event-vocabulary.md § Sprint grain: emitted once,
			// before the task loop, on a fresh start only (resume re-entry must
			// not duplicate it). Best-effort: emit failure warns, never halts.
			if (startTaskIndex === 0) {
				const sprintStartEvent: Record<string, unknown> = {
					eventId: `${isoCompact(sprintStartMs)}_${sprintId}_sprint_start`,
					sprintId,
					role: "orchestrator",
					action: "sprint-start",
					startTimestamp: new Date(sprintStartMs).toISOString(),
					endTimestamp: new Date(sprintStartMs).toISOString(),
					durationMinutes: 0,
					model: "orchestrator",
					provider: "orchestrator",
					type: "sprint-start",
					taskCount: taskIds.length,
				};
				const startEmit = emitEvent(storeCli, cwd, sprintId, sprintStartEvent);
				if (!startEmit.ok) {
					ctx.ui.notify(
						`⚠ forge:run-sprint — sprint-start event emit failed: ${startEmit.stderr.trim()}`,
						"warning",
					);
				}
			}

			for (let i = startTaskIndex; i < taskIds.length; i++) {
				const taskId = taskIds[i];
				if (!taskId) continue;

				// ── Skip already-completed tasks ──────────────────────────────
				// If the task is already committed/approved in the store, skip the
				// phase pipeline and accumulate it as completed. This handles
				// re-runs where tasks finished in a prior attempt.
				{
					const taskReadResult = spawnSync("node", [`${forgeRoot}/tools/store-cli.cjs`, "read", "task", taskId], {
						cwd,
						encoding: "utf8",
					});
					if (taskReadResult.status === 0) {
						try {
							const taskRecord = JSON.parse(taskReadResult.stdout as string);
							if (taskRecord.status === "committed" || taskRecord.status === "completed") {
								ctx.ui.notify(
									`▶ ${sprintId}: task ${i + 1}/${taskIds.length} — ${taskId} already ${taskRecord.status}, skipping.`,
									"info",
								);
								completedTaskIds.push(taskId);
								lastModel = taskRecord.model ?? lastModel;
								lastProvider = taskRecord.provider ?? lastProvider;
								writeSprintState(cwd, {
									sprintId,
									taskIndex: i + 1,
									completedTaskIds,
									halted: false,
									savedAt: new Date().toISOString(),
								});
								continue;
							}
						} catch {
							// Malformed task record — fall through to runTaskPipeline
						}
					}
				}

				ctx.ui.setStatus?.(
					SPRINT_STATUS_KEY,
					`run-sprint ${sprintId}: task ${i + 1}/${taskIds.length} (${taskId})`,
				);
				noteSprint(`▶ ${sprintId}: task ${i + 1}/${taskIds.length} — ${taskId}`, "info");

				// Determine resumeFromState for mid-task resume (REVIEW FIX #2).
				// If a halted or cancelled task state exists for this task,
				// pass it to runTaskPipeline so it resumes from the saved phase.
				let resumeFromState: RunTaskState | undefined = resumeTaskStates.get(taskId);
				if (resumeFromState) {
					// Validate the state is not corrupt
					if (
						typeof resumeFromState.phaseIndex !== "number" ||
						typeof resumeFromState.iterationCounts !== "object"
					) {
						ctx.ui.notify(`⚠ forge:run-sprint — corrupt task state for ${taskId}; starting fresh.`, "warning");
						resumeFromState = undefined;
					}
				}

				if (resumeFromState) {
					const resumephaseRole = resumeFromState.phaseIndex;
					const resumeStatus = resumeFromState.status ?? (resumeFromState.halted ? "halted" : "interrupted");
					ctx.ui.notify(
						`▶ forge:run-sprint — resuming ${taskId} from phase ${resumephaseRole} (${resumeStatus})`,
						"info",
					);
				}

				// Stale task state fallback: if task state >7d, delete and start fresh
				if (resumeFromState && isStateStale(resumeFromState)) {
					ctx.ui.notify(`⚠ forge:run-sprint — stale task state for ${taskId} (>7d); starting fresh.`, "warning");
					resumeFromState = undefined;
				}

				// ── Session lifecycle for thread-switcher (REVIEW FIX #2) ──────
				registry.startSession(taskId);

				// Bridge: register task in OrchestratorTree under sprint root.
				tree.startNode(taskId, { parentId: sprintId, label: `▸ wfl:run-task`, kind: "orchestrator" });

				// ── task-dispatch event (forge-engineering#39) ─────────────────
				// Per _fragments/event-vocabulary.md § Sprint grain: emitted
				// before each task dispatch (skipped tasks above never reach
				// here). Best-effort: emit failure warns, never halts.
				{
					const dispatchMs = Date.now();
					const dispatchEvent: Record<string, unknown> = {
						eventId: `${isoCompact(dispatchMs)}_${taskId}_task_dispatch`,
						sprintId,
						taskId,
						role: "orchestrator",
						action: "task-dispatch",
						phase: "dispatch",
						iteration: 1,
						startTimestamp: new Date(dispatchMs).toISOString(),
						endTimestamp: new Date(dispatchMs).toISOString(),
						durationMinutes: 0,
						model: lastModel ?? "orchestrator",
						provider: lastProvider ?? "orchestrator",
						type: "task-dispatch",
					};
					const dispatchEmit = emitEvent(storeCli, cwd, sprintId, dispatchEvent);
					if (!dispatchEmit.ok) {
						ctx.ui.notify(
							`⚠ forge:run-sprint — task-dispatch event emit failed for ${taskId}: ${dispatchEmit.stderr.trim()}`,
							"warning",
						);
					}
				}

				const taskSignal = registry.getAbortSignal(taskId);

				const taskResult: RunTaskPipelineResult = await runTaskPipeline({
					taskId,
					cwd,
					ctx,
					forgeRoot,
					storeCli,
					preflightGate,
					registry,
					resumeFromState,
					signal: taskSignal,
					forgeToolDefs: options.forgeToolDefs,
					extensionFactories: options.extensionFactories,
					streamFnFactory: options.streamFnFactory
						? (c) =>
								options.streamFnFactory?.({
									kind: "task-phase",
									persona: c.persona,
									phase: c.phase,
									taskId: c.taskId,
								})
						: undefined,
				});

				// Capture model/provider from last task result (REVIEW FIX #1)
				if (taskResult.model) lastModel = taskResult.model;
				if (taskResult.provider) lastProvider = taskResult.provider;

				// Mirror the task run into the central transcript archive
				// (best-effort — archiveRun never throws). The sprintId rides
				// on the task manifest as a back-reference; a sprint surfaces
				// as N task runs, no synthetic sprint container.
				if (taskResult.orchestratorTranscriptPath) {
					archiveRun({
						cwd,
						orchestratorJsonlPath: taskResult.orchestratorTranscriptPath,
						sprintId,
					});
				}

				// ── Handle task result ──────────────────────────────────────
				if (taskResult.status === "completed") {
					completedTaskIds.push(taskId);
					registry.completeSession(taskId, "completed");
					tree.completeNode(taskId, "completed");
				} else if (taskResult.status === "cancelled") {
					// Task was cancelled by user — mark session, persist sprint
					// state, emit sprint-halted with cancellation detail, exit.
					registry.completeSession(taskId, "cancelled");
					tree.completeNode(taskId, "cancelled");
					tree.completeNode(sprintId, "cancelled");
					const cancelledEvent: Record<string, unknown> = {
						eventId: `${isoCompact(sprintStartMs)}_${sprintId}_sprint_halted`,
						sprintId,
						role: "orchestrator",
						action: "sprint-halted",
						startTimestamp: new Date(sprintStartMs).toISOString(),
						endTimestamp: new Date(Date.now()).toISOString(),
						durationMinutes: Math.round(((Date.now() - sprintStartMs) / 60000) * 100) / 100,
						model: lastModel ?? "orchestrator",
						provider: lastProvider ?? "orchestrator",
						type: "sprint-halted",
						haltedAtTaskIndex: i,
						haltedAtTaskId: taskId,
						lastError: "cancelled",
					};
					emitEvent(storeCli, cwd, sprintId, cancelledEvent);

					writeSprintState(cwd, {
						sprintId,
						taskIndex: i,
						completedTaskIds,
						halted: true,
						lastError: "cancelled",
						savedAt: new Date().toISOString(),
					});
					noteSprint(`⊘ forge:run-sprint — ${sprintId} halted: task ${taskId} cancelled.`, "info");
					ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
					return;
				} else {
					// Task halted/escalated/failed: mark session failed, persist sprint state, emit sprint-halted, exit.
					registry.completeSession(taskId, "failed");
					tree.completeNode(taskId, "failed");
					tree.completeNode(sprintId, "failed");
					const haltedEvent: Record<string, unknown> = {
						eventId: `${isoCompact(sprintStartMs)}_${sprintId}_sprint_halted`,
						sprintId,
						role: "orchestrator",
						action: "sprint-halted",
						startTimestamp: new Date(sprintStartMs).toISOString(),
						endTimestamp: new Date(Date.now()).toISOString(),
						durationMinutes: Math.round(((Date.now() - sprintStartMs) / 60000) * 100) / 100,
						model: lastModel ?? "orchestrator",
						provider: lastProvider ?? "orchestrator",
						type: "sprint-halted",
						haltedAtTaskIndex: i,
						haltedAtTaskId: taskId,
						lastError: taskResult.lastError ?? "unknown",
					};
					emitEvent(storeCli, cwd, sprintId, haltedEvent);

					writeSprintState(cwd, {
						sprintId,
						taskIndex: i,
						completedTaskIds,
						halted: true,
						lastError: taskResult.lastError,
						savedAt: new Date().toISOString(),
					});
					ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
					return;
				}

				// Autonomous run-to-completion: no per-task "Continue to next task?"
				// gate. /forge:run-sprint runs ALL of its tasks and then the single
				// clean-complete ceremony below. The former per-task confirm +
				// partial-ceremony-on-decline was removed — a sprint command should
				// run its sprint, and the mid-sprint modal turned any UI hiccup into a
				// premature partial ceremony (ceremony firing after task 1 with later
				// tasks still draft). Deliberate cancellation (abort signal /
				// task-halt) still stops the sprint via the cancelled/halted branches
				// above; resume picks up the persisted taskIndex.

				// Persist sprint state after each task transition (AC B-10)
				writeSprintState(cwd, {
					sprintId,
					taskIndex: i + 1,
					completedTaskIds,
					halted: false,
					savedAt: new Date().toISOString(),
				});
			}

			// ── All tasks complete — clean-complete branch (Plan 12 §3) ──────
			const sprintEndMs = Date.now();

			// Delete sprint state on successful completion
			deleteSprintState(cwd, sprintId);

			const ceremony = await dispatchSprintCeremony({
				sprintId,
				mode: "complete",
				completedTaskIds,
				cwd,
				forgeRoot,
				ctx,
				registry,
				streamFnFactory: options.streamFnFactory,
				forgeToolDefs: options.forgeToolDefs,
			});

			const sprintEvent: Record<string, unknown> = {
				eventId: `${isoCompact(sprintStartMs)}_${sprintId}_sprint_complete`,
				sprintId,
				role: "architect",
				action: "sprint-complete",
				startTimestamp: new Date(sprintStartMs).toISOString(),
				endTimestamp: new Date(sprintEndMs).toISOString(),
				durationMinutes: Math.round(((sprintEndMs - sprintStartMs) / 60000) * 100) / 100,
				model: ceremony.model ?? lastModel ?? "orchestrator",
				provider: ceremony.provider ?? lastProvider ?? "orchestrator",
				type: "sprint-complete",
				taskCount: taskIds.length,
				completedTaskIds,
				verdict: ceremony.verdict === "revision-required" ? "partial" : ceremony.verdict,
				waveCount: 1,
				maxConcurrency: 1,
			};

			const emitResult = emitEvent(storeCli, cwd, sprintId, sprintEvent);
			if (!emitResult.ok) {
				ctx.ui.notify(
					`⚠ forge:run-sprint — sprint-complete event emit failed: ${emitResult.stderr.trim()}`,
					"warning",
				);
			}

			// ── Emit synthetic sprint-collate-complete event (FORGE-S21-T05) ──
			// Fires the in-process hook for post-sprint-hook.ts to consume.
			// Best-effort: failure-to-emit notifies but does NOT halt — sprint is
			// already complete at this point.
			try {
				const collateEvent: SprintCollateCompleteEvent = {
					type: "sprint-collate-complete",
					sprintId,
					cwd,
				};
				await emitSyntheticEvent(collateEvent, ctx);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(
					`⚠ forge:run-sprint — sprint-collate-complete synthetic event emit failed: ${e.message ?? "unknown"}`,
					"warning",
				);
			}

			ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);

			// Sprint root: mark completed in the tree. "revision-required" → failed
			// because the architect rejected the sprint; partial → completed (the
			// sprint itself finished, the progress indicator shows N/M tasks done).
			const sprintTreeStatus = ceremony.verdict === "revision-required" ? "failed" : "completed";
			tree.completeNode(sprintId, sprintTreeStatus);

			if (ceremony.verdict === "complete") {
				noteSprint(
					`〇 forge:run-sprint — sprint ${sprintId} complete (${completedTaskIds.length}/${taskIds.length} tasks).`,
					"info",
				);
			} else if (ceremony.verdict === "revision-required") {
				// Architect did not approve; surface to user.
				noteSprint(
					`▲ forge:run-sprint — sprint ${sprintId} ceremony returned "Revision Required". ` +
						`See engineering/sprints/${sprintId}/SPRINT_COMPLETION_REVIEW.md.`,
					"warning",
				);
			} else {
				noteSprint(
					`▲ forge:run-sprint — sprint ${sprintId} marked partially-completed by architect.`,
					"warning",
				);
			}
		},
	});
}
