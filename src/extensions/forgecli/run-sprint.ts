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

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";

import { assertAudience } from "./audience-gate.js";
import { checkMaterialization } from "./plan.js";
import { loadWorkflow } from "./loaders/workflow-loader.js";
import { discoverForgeConfig } from "./forge-root.js";
import { getSessionRegistry } from "./session-registry.js";
import { loadForgePersona, runForgeSubagent } from "./forge-subagent.js";
import {
	runTaskPipeline,
	isNonInteractive,
	formatLocalTime,
	emitEvent,
	isoCompact,
	validateId,
	readState as readTaskState,
	isStateStale,
	type RunTaskState,
	type RunTaskPipelineResult,
} from "./run-task.js";

// ── Sprint-level state persistence ────────────────────────────────────────

interface RunSprintState {
	sprintId: string;
	taskIndex: number;           // index into sprint.taskIds (points to NEXT task to run)
	completedTaskIds: string[];  // only tasks that returned status "completed" (advisory #6)
	halted: boolean;
	lastError?: string;
	savedAt: string;
}

function sprintStateFilePath(cwd: string, sprintId: string): string {
	if (!validateId(sprintId)) {
		throw new Error(`Invalid sprintId for state file path: ${sprintId}`);
	}
	return path.join(cwd, ".forge", "cache", `run-sprint-state-${sprintId}.json`);
}

function readSprintState(cwd: string, sprintId: string): RunSprintState | null {
	const fp = sprintStateFilePath(cwd, sprintId);
	try {
		if (!fs.existsSync(fp)) return null;
		const raw = fs.readFileSync(fp, "utf8");
		return JSON.parse(raw) as RunSprintState;
	} catch {
		return null;
	}
}

function writeSprintState(cwd: string, state: RunSprintState): void {
	const fp = sprintStateFilePath(cwd, state.sprintId);
	const dir = path.dirname(fp);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(fp, JSON.stringify(state, null, 2), "utf8");
}

function deleteSprintState(cwd: string, sprintId: string): void {
	const fp = sprintStateFilePath(cwd, sprintId);
	try {
		if (fs.existsSync(fp)) fs.unlinkSync(fp);
	} catch {
		// non-fatal
	}
}

function isSprintStateStale(state: RunSprintState): boolean {
	const savedAt = new Date(state.savedAt).getTime();
	const ageMs = Date.now() - savedAt;
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
	return ageMs > sevenDaysMs;
}

// ── Sprint record resolution ──────────────────────────────────────────────

interface SprintRecord {
	sprintId: string;
	taskIds: string[];
	[pk: string]: unknown;
}

function readSprintRecord(sprintId: string, storeCli: string, cwd: string): SprintRecord | null {
	const result = spawnSync("node", [storeCli, "read", "sprint", sprintId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return null;
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		const record = JSON.parse(raw) as SprintRecord;
		// Validate taskIds is a non-empty array of strings
		if (!Array.isArray(record.taskIds) || record.taskIds.length === 0) return null;
		if (!record.taskIds.every((id: unknown) => typeof id === "string")) return null;
		return record;
	} catch {
		return null;
	}
}

// ── Sprint ceremony dispatch (Plan 12 §6.2) ────────────────────────────────

type SprintCeremonyResult = {
	verdict:        "complete" | "partial" | "revision-required";
	model?:         string;
	provider?:      string;
	durationMs:     number;
	errorMessage?:  string;
};

async function dispatchSprintCeremony(params: {
	sprintId:           string;
	mode:               "complete" | "partial";
	completedTaskIds:   string[];
	pausedAfterIndex?:  number;
	cwd:                string;
	forgeRoot:          string;
	ctx:                ExtensionCommandContext;
	registry:           ReturnType<typeof getSessionRegistry>;
}): Promise<SprintCeremonyResult> {
	const { sprintId, mode, completedTaskIds, pausedAfterIndex, cwd, forgeRoot, ctx, registry } = params;
	const startMs = Date.now();

	// Materialized workflow path — already shipped from base pack.
	const workflowName = "architect_review_sprint_completion";
	const personaName  = "architect";

	let persona;
	try {
		persona = loadForgePersona(personaName, cwd);
	} catch {
		return {
			verdict:      "revision-required",
			durationMs:   Date.now() - startMs,
			errorMessage: `architect persona not found`,
		};
	}

	const taskLines = [
		`# Sprint Completion Review — ${sprintId}`,
		``,
		`Mode: ${mode}`,
		`Completed tasks: ${completedTaskIds.join(", ") || "(none)"}`,
	];
	if (pausedAfterIndex !== undefined) {
		taskLines.push(`Paused after task index: ${pausedAfterIndex}`);
	}
	taskLines.push(
		``,
		`Execute the materialized workflow at \`.forge/workflows/${workflowName}.md\`.`,
		`Do not emit any phase event yourself; the orchestrator owns event emission.`,
	);
	const task = taskLines.join("\n");

	// Use a dedicated session id (NOT a taskId) so the thread-switcher renders it
	// as a sprint-scoped chip distinct from per-task sessions.
	const sessionId = `${sprintId}:ceremony`;
	registry.startSession(sessionId);

	let model: string | undefined;
	let provider: string | undefined;
	let errorMessage: string | undefined;

	try {
		const result = await runForgeSubagent({
			persona,
			task,
			cwd,
			exportTag: `${sprintId}__ceremony`,
			forgeRoot,
			// Sprint-scoped prompt-cache key — every subagent spawned across
			// the sprint (ceremonies + per-task phases) shares this namespace
			// so the system-prompt + persona prefix stays warm.
			cacheSessionId: `forge:${sprintId}`,
		});
		model    = result.model;
		provider = result.provider;
		if (result.exitCode !== 0) {
			errorMessage = result.errorMessage ?? "architect subagent exited non-zero";
		}
	} catch (e: unknown) {
		const err = e as { message?: string };
		errorMessage = err?.message ?? "runForgeSubagent threw";
	} finally {
		registry.completeSession(sessionId, errorMessage ? "failed" : "completed");
	}

	// Parse verdict from store: did the architect actually transition the sprint?
	// The store is the source of truth — verdict text in SPRINT_COMPLETION_REVIEW.md
	// is human-readable but the store status is authoritative.
	let verdict: "complete" | "partial" | "revision-required" = "revision-required";
	const readResult = spawnSync("node", [
		`${forgeRoot}/tools/store-cli.cjs`, "read", "sprint", sprintId,
	], { cwd, encoding: "utf8" });
	if (readResult.status === 0) {
		try {
			const sprint = JSON.parse(readResult.stdout as string);
			if (sprint.status === "completed")                     verdict = "complete";
			else if (sprint.status === "partially-completed")   verdict = "partial";
			// else: status unchanged → revision-required
		} catch {
			// fall through with revision-required
		}
	}

	return {
		verdict,
		model,
		provider,
		durationMs: Date.now() - startMs,
		errorMessage,
	};
}

// ── Registration ──────────────────────────────────────────────────────────

export interface RegisterRunSprintOptions {
	cwd?: string;
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
			const sprintId = args.trim();

			if (!sprintId) {
				ctx.ui.notify("× forge:run-sprint — sprint ID required. Usage: /forge:run-sprint <SPRINT_ID>", "error");
				return;
			}

			// Path traversal validation (advisory #3)
			if (!validateId(sprintId)) {
				ctx.ui.notify(`× forge:run-sprint — invalid sprint ID format: ${sprintId}`, "error");
				return;
			}

			ctx.ui.setStatus?.(SPRINT_STATUS_KEY, `run-sprint ${sprintId}: initializing…`);

			// ── Discover forge config ────────────────────────────────────────
			const forgeConfig = discoverForgeConfig(cwd);
			if (!forgeConfig) {
				ctx.ui.notify("× forge:run-sprint — no Forge project found at cwd. Run /forge:init first.", "error");
				ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
				return;
			}
			const forgeRoot = forgeConfig.forgeRoot;
			const storeCli = path.join(forgeRoot, "tools", "store-cli.cjs");
			const preflightGate = path.join(forgeRoot, "tools", "preflight-gate.cjs");

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
						ctx.ui.notify(
							`× workflow regression: ${marker} not found in ${workflowPath}`,
							"error",
						);
					}
					ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
					return;
				}
			}

			// ── Pre-flight confirm (AC B-7) ───────────────────────────────────
			if (!isNonInteractive()) {
				const proceed = await ctx.ui.confirm(
					`Begin sprint ${sprintId}?`,
					`Tasks: ${taskIds.join(", ")}`,
				);
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
			let resumeTaskStates: Map<string, RunTaskState> = new Map();

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
							// Collect halted task states for mid-task resume (REVIEW FIX #2, option b)
							for (const taskId of taskIds.slice(startTaskIndex)) {
								const taskState = readTaskState(cwd, taskId);
								if (taskState && taskState.halted) {
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

			// ── Per-task loop (AC B-8) ────────────────────────────────────────
			const registry = getSessionRegistry();
			let lastModel: string | undefined;
			let lastProvider: string | undefined;
			const sprintStartMs = Date.now();

			for (let i = startTaskIndex; i < taskIds.length; i++) {
				const taskId = taskIds[i];
				if (!taskId) continue;

				// ── Skip already-completed tasks ──────────────────────────────
				// If the task is already committed/approved in the store, skip the
				// phase pipeline and accumulate it as completed. This handles
				// re-runs where tasks finished in a prior attempt.
				{
					const taskReadResult = spawnSync("node", [
						`${forgeRoot}/tools/store-cli.cjs`, "read", "task", taskId,
					], { cwd, encoding: "utf8" });
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
				ctx.ui.notify(
					`▶ ${sprintId}: task ${i + 1}/${taskIds.length} — ${taskId}`,
					"info",
				);

				// Determine resumeFromState for mid-task resume (REVIEW FIX #2).
				// If a halted task state exists for this task, pass it to runTaskPipeline.
				let resumeFromState: RunTaskState | undefined = resumeTaskStates.get(taskId);
				if (resumeFromState) {
					// Validate the state is not corrupt
					if (typeof resumeFromState.phaseIndex !== "number" || typeof resumeFromState.iterationCounts !== "object") {
						ctx.ui.notify(
							`⚠ forge:run-sprint — corrupt task state for ${taskId}; starting fresh.`,
							"warning",
						);
						resumeFromState = undefined;
					}
				}

				// Stale task state fallback: if task state >7d, delete and start fresh
				if (resumeFromState && isStateStale(resumeFromState)) {
					ctx.ui.notify(
						`⚠ forge:run-sprint — stale task state for ${taskId} (>7d); starting fresh.`,
						"warning",
					);
					resumeFromState = undefined;
				}

				// ── Session lifecycle for thread-switcher (REVIEW FIX #2) ──────
				registry.startSession(taskId);

				const taskResult: RunTaskPipelineResult = await runTaskPipeline({
					taskId,
					cwd,
					ctx,
					forgeRoot,
					storeCli,
					preflightGate,
					registry,
					resumeFromState,
				});

				// Capture model/provider from last task result (REVIEW FIX #1)
				if (taskResult.model) lastModel = taskResult.model;
				if (taskResult.provider) lastProvider = taskResult.provider;

				// ── Handle task result ──────────────────────────────────────
				if (taskResult.status === "completed") {
					completedTaskIds.push(taskId);
					registry.completeSession(taskId, "completed");
				} else {
					// Task halted/escalated/failed: mark session failed, persist sprint state, emit sprint-halted, exit.
					registry.completeSession(taskId, "failed");
					const haltedEvent: Record<string, unknown> = {
						eventId:         `${isoCompact(sprintStartMs)}_${sprintId}_sprint_halted`,
						sprintId,
						role:            "orchestrator",
						action:          "sprint-halted",
						startTimestamp:  new Date(sprintStartMs).toISOString(),
						endTimestamp:    new Date(Date.now()).toISOString(),
						durationMinutes: Math.round(((Date.now() - sprintStartMs) / 60000) * 100) / 100,
						model:           lastModel    ?? "orchestrator",
						provider:        lastProvider ?? "orchestrator",
						type:            "sprint-halted",
						haltedAtTaskIndex: i,
						haltedAtTaskId:    taskId,
						lastError:         taskResult.lastError ?? "unknown",
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

				// ── Post-task confirm (AC B-9) ────────────────────────────
				// Skip after final task
				if (i < taskIds.length - 1 && !isNonInteractive()) {
					const proceed = await ctx.ui.confirm(
						`Continue to next task?`,
						`${taskIds[i + 1]} is next. ${taskIds.length - i - 1} task(s) remaining.`,
					);
					if (!proceed) {
						// Persist sprint state for resume.
						writeSprintState(cwd, {
							sprintId,
							taskIndex: i + 1,
							completedTaskIds,
							halted: false,
							savedAt: new Date().toISOString(),
						});

						// User-paused branch: dispatch ceremony if ≥1 task completed, emit partial event.
						const pauseEndMs = Date.now();
						let ceremonyResult: SprintCeremonyResult | undefined;

						if (completedTaskIds.length > 0) {
							// Only dispatch ceremony if at least one task completed.
							// A zero-progress pause has nothing to review.
							ceremonyResult = await dispatchSprintCeremony({
								sprintId,
								mode: "partial",
								completedTaskIds,
								pausedAfterIndex: i,
								cwd,
								forgeRoot,
								ctx,
								registry,
							});
						}

						const pausedEvent: Record<string, unknown> = {
							eventId:         `${isoCompact(sprintStartMs)}_${sprintId}_sprint_complete`,
							sprintId,
							role:            "architect",
							action:          "sprint-complete",
							startTimestamp:  new Date(sprintStartMs).toISOString(),
							endTimestamp:    new Date(pauseEndMs).toISOString(),
							durationMinutes: Math.round(((pauseEndMs - sprintStartMs) / 60000) * 100) / 100,
							model:           ceremonyResult?.model    ?? lastModel    ?? "orchestrator",
							provider:        ceremonyResult?.provider ?? lastProvider ?? "orchestrator",
							type:            "sprint-complete",
							taskCount:       taskIds.length,
							completedTaskIds,
							verdict:         "partial",
							pausedAfterTaskIndex: i,
							waveCount:       1,
							maxConcurrency:  1,
						};
						emitEvent(storeCli, cwd, sprintId, pausedEvent);

						ctx.ui.notify("forge:run-sprint — sprint paused after task completion.", "info");
						ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);
						return;
					}
				}

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
			});

			const sprintEvent: Record<string, unknown> = {
				eventId:         `${isoCompact(sprintStartMs)}_${sprintId}_sprint_complete`,
				sprintId,
				role:            "architect",
				action:          "sprint-complete",
				startTimestamp:  new Date(sprintStartMs).toISOString(),
				endTimestamp:    new Date(sprintEndMs).toISOString(),
				durationMinutes: Math.round(((sprintEndMs - sprintStartMs) / 60000) * 100) / 100,
				model:           ceremony.model    ?? lastModel    ?? "orchestrator",
				provider:        ceremony.provider ?? lastProvider ?? "orchestrator",
				type:            "sprint-complete",
				taskCount:       taskIds.length,
				completedTaskIds,
				verdict:         ceremony.verdict === "revision-required" ? "partial" : ceremony.verdict,
				waveCount:       1,
				maxConcurrency:  1,
			};

			const emitResult = emitEvent(storeCli, cwd, sprintId, sprintEvent);
			if (!emitResult.ok) {
				ctx.ui.notify(
					`⚠ forge:run-sprint — sprint-complete event emit failed: ${emitResult.stderr.trim()}`,
					"warning",
				);
			}

			ctx.ui.setStatus?.(SPRINT_STATUS_KEY, undefined);

			if (ceremony.verdict === "complete") {
				ctx.ui.notify(
					`〇 forge:run-sprint — sprint ${sprintId} complete (${completedTaskIds.length}/${taskIds.length} tasks).`,
					"info",
				);
			} else if (ceremony.verdict === "revision-required") {
				// Architect did not approve; surface to user.
				ctx.ui.notify(
					`▲ forge:run-sprint — sprint ${sprintId} ceremony returned "Revision Required". ` +
					`See engineering/sprints/${sprintId}/SPRINT_COMPLETION_REVIEW.md.`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					`▲ forge:run-sprint — sprint ${sprintId} marked partially-completed by architect.`,
					"warning",
				);
			}
		},
	});
}