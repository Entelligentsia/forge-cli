// run-task.ts — /forge:run-task native Orchestrator handler (FORGE-S21-T02).
//
// Promotes /forge:run-task from stub to a full TS-driven Orchestrator-archetype
// native handler. Reads `.forge/workflows/orchestrate_task.md`, chains phases
// (plan → review-plan → implement → review-code → validate → approve →
// writeback → commit) by spawning a fresh runForgeSubagent per phase (IL10).
//
// Iron Laws enforced here:
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff calls here)
//
// sendKickoff is NEVER called from this file.
// Audit-grep: grep -n "sendKickoff(" run-task.ts must return empty.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { assertAudience, CallerContextStore } from "./audience-gate.js";
import { checkMaterialization } from "./plan.js";
import { loadForgePersona, runForgeSubagent } from "./forge-subagent.js";
import { discoverForgeConfig } from "./forge-root.js";
import { loadWorkflow, type AudienceValue } from "./loaders/workflow-loader.js";

// ── Non-interactive helpers ───────────────────────────────────────────────

function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

// ── Phase descriptor table ─────────────────────────────────────────────────
//
// Decoded from .forge/workflows/orchestrate_task.md default pipeline.
// `isReview` phases have verdict-loop logic; non-review phases always advance.

export interface PhaseDescriptor {
	/** Workflow role name (also used as key for summaries and iteration tracking). */
	role: string;
	/** Filename under .forge/workflows/ (without extension). */
	workflowFile: string;
	/** Persona noun passed to loadForgePersona. */
	personaNoun: string;
	/** When true: read summaries.<role>.verdict after dispatch. */
	isReview: boolean;
	/** Max revision iterations before escalation. */
	maxIterations: number;
}

export const PHASES: PhaseDescriptor[] = [
	{ role: "plan", workflowFile: "plan_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-plan", workflowFile: "review_plan", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "implement", workflowFile: "implement_plan", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-code", workflowFile: "review_code", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "validate", workflowFile: "validate_task", personaNoun: "qa-engineer", isReview: true, maxIterations: 3 },
	{ role: "approve", workflowFile: "architect_approve", personaNoun: "architect", isReview: true, maxIterations: 3 },
	{ role: "writeback", workflowFile: "collator_agent", personaNoun: "collator", isReview: false, maxIterations: 1 },
	{ role: "commit", workflowFile: "commit_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
];

// ── State persistence ─────────────────────────────────────────────────────

export interface RunTaskState {
	taskId: string;
	phaseIndex: number;
	iterationCounts: Record<string, number>;
	halted: boolean;
	lastError?: string;
	savedAt: string;
}

function stateFilePath(cwd: string, taskId: string): string {
	return path.join(cwd, ".forge", "cache", `run-task-state-${taskId}.json`);
}

function readState(cwd: string, taskId: string): RunTaskState | null {
	const fp = stateFilePath(cwd, taskId);
	try {
		if (!fs.existsSync(fp)) return null;
		const raw = fs.readFileSync(fp, "utf8");
		return JSON.parse(raw) as RunTaskState;
	} catch {
		return null;
	}
}

function writeState(cwd: string, state: RunTaskState): void {
	const fp = stateFilePath(cwd, state.taskId);
	const dir = path.dirname(fp);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(fp, JSON.stringify(state, null, 2), "utf8");
}

function deleteState(cwd: string, taskId: string): void {
	const fp = stateFilePath(cwd, taskId);
	try {
		if (fs.existsSync(fp)) fs.unlinkSync(fp);
	} catch {
		// non-fatal
	}
}

function isStateStale(state: RunTaskState): boolean {
	const savedAt = new Date(state.savedAt).getTime();
	const ageMs = Date.now() - savedAt;
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
	return ageMs > sevenDaysMs;
}

// ── Verdict read from store-cli ────────────────────────────────────────────

type Verdict = "approved" | "revision" | "n/a" | "missing";

function readVerdict(
	taskId: string,
	phaseRole: string,
	storeCli: string,
	cwd: string,
): Verdict {
	const result = spawnSync("node", [storeCli, "read", "task", taskId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return "missing";
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		const record = JSON.parse(raw) as {
			summaries?: Record<string, { verdict?: string }>;
		};
		const verdict = record.summaries?.[phaseRole]?.verdict;
		if (!verdict) return "missing";
		if (verdict === "approved") return "approved";
		if (verdict === "revision") return "revision";
		return "missing";
	} catch {
		return "missing";
	}
}

// ── Find predecessor non-review phase for revision loop ───────────────────

function findPredecessorIndex(phases: PhaseDescriptor[], reviewIndex: number): number {
	for (let i = reviewIndex - 1; i >= 0; i--) {
		if (!phases[i].isReview) return i;
	}
	return 0;
}

// ── Task body composition ─────────────────────────────────────────────────

function composeTaskBody(subWorkflowMd: string, taskId: string): string {
	return [
		`Read the workflow below and follow it. Task ID: ${taskId}.`,
		"",
		"---",
		"",
		subWorkflowMd.trim(),
	].join("\n");
}

// ── Preflight gate ────────────────────────────────────────────────────────

type PreflightResult = "proceed" | "halt" | "escalate";

function runPreflightGate(
	preflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
): PreflightResult {
	const result = spawnSync("node", [preflightGate, "--phase", role, "--task", taskId], { cwd });
	if (result.status === 0) return "proceed";
	if (result.status === 2) return "escalate";
	return "halt";
}

// ── Registration ──────────────────────────────────────────────────────────

export interface RegisterRunTaskOptions {
	cwd?: string;
}

const STATUS_KEY = "forge:run-task";

export function registerRunTask(pi: ExtensionAPI, options: RegisterRunTaskOptions = {}): void {
	pi.registerCommand("forge:run-task", {
		description:
			"Run the full task pipeline (plan → review → implement → validate → approve → commit). " +
			"Usage: /forge:run-task <TASK_ID>. " +
			"Orchestrator archetype: each phase is an isolated subagent session (IL10).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const taskId = args.trim();

			if (!taskId) {
				ctx.ui.notify("× forge:run-task — task ID required. Usage: /forge:run-task <TASK_ID>", "error");
				return;
			}

			ctx.ui.setStatus?.(STATUS_KEY, `run-task ${taskId}: initializing…`);

			// ── Discover forge config ────────────────────────────────────────
			const forgeConfig = discoverForgeConfig(cwd);
			if (!forgeConfig) {
				ctx.ui.notify("× forge:run-task — no Forge project found at cwd. Run /forge:init first.", "error");
				ctx.ui.setStatus?.(STATUS_KEY, undefined);
				return;
			}
			const forgeRoot = forgeConfig.forgeRoot;

			// Tool paths
			const storeCli = path.join(forgeRoot, "tools", "store-cli.cjs");
			const preflightGate = path.join(forgeRoot, "tools", "preflight-gate.cjs");

			// ── Resume detection ─────────────────────────────────────────────
			const existing = readState(cwd, taskId);
			let startPhaseIndex = 0;
			let iterationCounts: Record<string, number> = {};

			if (existing) {
				if (isStateStale(existing)) {
					// Stale state: notify + offer purge
					ctx.ui.notify(
						`⚠ forge:run-task — cached state for ${taskId} is stale (>7 days old, saved at ${existing.savedAt}). ` +
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
							return;
						}
					} else {
						// Non-interactive: auto-abort on stale state
						ctx.ui.notify("forge:run-task — stale state; non-interactive mode auto-aborting.", "info");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						return;
					}
				} else {
					// Fresh state: offer resume
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume ${taskId}?`,
							`Cached state found at phase ${existing.phaseIndex} (saved at ${existing.savedAt}). Resume from here?`,
						);
						if (resume) {
							startPhaseIndex = existing.phaseIndex;
							iterationCounts = existing.iterationCounts;
							ctx.ui.notify(
								`forge:run-task — resuming ${taskId} from phase ${PHASES[startPhaseIndex]?.role ?? startPhaseIndex}`,
								"info",
							);
						} else {
							// Restart from beginning
							deleteState(cwd, taskId);
						}
					} else {
						// Non-interactive + halted state: auto-abort
						ctx.ui.notify(
							`forge:run-task — cached state for ${taskId} found but non-interactive mode; aborting.`,
							"info",
						);
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						return;
					}
				}
			}

			// ── Main phase loop ───────────────────────────────────────────────
			let currentPhaseIndex = startPhaseIndex;

			while (currentPhaseIndex < PHASES.length) {
				const phase = PHASES[currentPhaseIndex];
				if (!phase) {
					ctx.ui.notify(`× forge:run-task — invalid phase index ${currentPhaseIndex}`, "error");
					break;
				}

				ctx.ui.setStatus?.(
					STATUS_KEY,
					`run-task ${taskId}: phase ${currentPhaseIndex + 1}/${PHASES.length} (${phase.role})`,
				);

				const subWorkflowPath = path.join(cwd, ".forge", "workflows", `${phase.workflowFile}.md`);

				// ── Read sub-workflow ─────────────────────────────────────────
				let subWorkflowMd: string;
				let subWorkflowAudience: AudienceValue = "any";
				try {
					const loaded = loadWorkflow(subWorkflowPath);
					subWorkflowMd = loaded.rawMarkdown;
					subWorkflowAudience = loaded.audience;
				} catch (err: unknown) {
					const e = err as { message?: string };
					ctx.ui.notify(
						`× forge:run-task — failed to read sub-workflow for ${phase.role}: ${e.message ?? "unknown"}`,
						"error",
					);
					writeState(cwd, {
						taskId,
						phaseIndex: currentPhaseIndex,
						iterationCounts,
						halted: true,
						lastError: `sub-workflow read failed: ${e.message ?? "unknown"}`,
						savedAt: new Date().toISOString(),
					});
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}

				// ── 6a. Preflight gate ────────────────────────────────────────
				if (fs.existsSync(preflightGate)) {
					const preflightResult = runPreflightGate(preflightGate, phase.role, taskId, cwd);
					if (preflightResult === "halt") {
						ctx.ui.notify(
							`× forge:run-task — preflight gate failed for phase ${phase.role} (exit 1); halting.`,
							"error",
						);
						writeState(cwd, {
							taskId,
							phaseIndex: currentPhaseIndex,
							iterationCounts,
							halted: true,
							lastError: `preflight gate exit 1 for ${phase.role}`,
							savedAt: new Date().toISOString(),
						});
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						return;
					}
					if (preflightResult === "escalate") {
						ctx.ui.notify(
							`× forge:run-task — preflight gate escalated for phase ${phase.role} (exit 2); manual intervention required.`,
							"error",
						);
						writeState(cwd, {
							taskId,
							phaseIndex: currentPhaseIndex,
							iterationCounts,
							halted: true,
							lastError: `preflight gate exit 2 (escalate) for ${phase.role}`,
							savedAt: new Date().toISOString(),
						});
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						return;
					}
				}

				// ── 6. Materialization-marker check ───────────────────────────
				const markerCheck = checkMaterialization(subWorkflowPath, subWorkflowMd);
				if (!markerCheck.ok) {
					for (const marker of markerCheck.missing) {
						ctx.ui.notify(
							`× workflow regression: ${marker} not found in ${subWorkflowPath}`,
							"error",
						);
					}
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}

				// ── 5. Audience check ─────────────────────────────────────────
				// Wrap with CallerContextStore.asSubagent so assertAudience treats
				// this as a subagent context (IL10: we ARE dispatching from subagent chain).
				const audienceOk = CallerContextStore.asSubagent(() =>
					assertAudience({ workflowName: phase.workflowFile, audience: subWorkflowAudience }, ctx),
				);
				if (!audienceOk) {
					writeState(cwd, {
						taskId,
						phaseIndex: currentPhaseIndex,
						iterationCounts,
						halted: true,
						lastError: `audience check failed for ${phase.workflowFile}`,
						savedAt: new Date().toISOString(),
					});
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}

				// ── Persona load ──────────────────────────────────────────────
				let persona;
				try {
					persona = loadForgePersona(phase.personaNoun, cwd);
				} catch (err: unknown) {
					const e = err as { message?: string };
					ctx.ui.notify(
						`× forge:run-task — persona '${phase.personaNoun}' not found for phase ${phase.role}: ${e.message ?? "unknown"}. ` +
							"Run /forge:regenerate to materialize persona files.",
						"error",
					);
					writeState(cwd, {
						taskId,
						phaseIndex: currentPhaseIndex,
						iterationCounts,
						halted: true,
						lastError: `persona load failed: ${e.message ?? "unknown"}`,
						savedAt: new Date().toISOString(),
					});
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}

				// ── 4. Dispatch via runForgeSubagent (IL10) ───────────────────
				// NEVER sendKickoff here — that would reproduce issue #30 (same-context inline = no fork).
				const taskBody = composeTaskBody(subWorkflowMd, taskId);
				let result;
				try {
					result = await runForgeSubagent({
						persona,
						task: taskBody,
						cwd,
						onEvent: (event) => {
							// Live monitor: surface tool calls and turn progress
							if (event.type === "tool_execution_start") {
								ctx.ui.setStatus?.(
									STATUS_KEY,
									`run-task ${taskId}: ${phase.role} · tool: ${event.toolName ?? "unknown"}`,
								);
							}
						},
					});
				} catch (err: unknown) {
					const e = err as { message?: string };
					ctx.ui.notify(
						`× forge:run-task — runForgeSubagent threw for phase ${phase.role}: ${e.message ?? "unknown"}`,
						"error",
					);
					writeState(cwd, {
						taskId,
						phaseIndex: currentPhaseIndex,
						iterationCounts,
						halted: true,
						lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}`,
						savedAt: new Date().toISOString(),
					});
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}

				// ── Halt-on-failure ───────────────────────────────────────────
				if (result.exitCode !== 0) {
					ctx.ui.notify(
						`× forge:run-task — phase ${phase.role} failed (exit ${result.exitCode})` +
							(result.errorMessage ? `: ${result.errorMessage}` : "") +
							(result.stopReason ? ` [${result.stopReason}]` : ""),
						"error",
					);
					writeState(cwd, {
						taskId,
						phaseIndex: currentPhaseIndex,
						iterationCounts,
						halted: true,
						lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
						savedAt: new Date().toISOString(),
					});
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}

				// ── 6b. Verdict check (review phases only) ────────────────────
				if (phase.isReview) {
					const verdict = readVerdict(taskId, phase.role, storeCli, cwd);

					if (verdict === "missing") {
						ctx.ui.notify(
							`× forge:run-task — verdict missing for phase ${phase.role} after subagent completed. ` +
								"Subagent may have crashed or failed to write summaries. Escalating.",
							"error",
						);
						writeState(cwd, {
							taskId,
							phaseIndex: currentPhaseIndex,
							iterationCounts,
							halted: true,
							lastError: `verdict missing for ${phase.role}`,
							savedAt: new Date().toISOString(),
						});
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						return;
					}

					if (verdict === "revision") {
						// Increment iteration count for this review phase
						iterationCounts[phase.role] = (iterationCounts[phase.role] ?? 0) + 1;

						if (iterationCounts[phase.role] >= phase.maxIterations) {
							ctx.ui.notify(
								`× forge:run-task — revision cap reached for phase ${phase.role} ` +
									`(${iterationCounts[phase.role]}/${phase.maxIterations} iterations). Escalating.`,
								"error",
							);
							writeState(cwd, {
								taskId,
								phaseIndex: currentPhaseIndex,
								iterationCounts,
								halted: true,
								lastError: `revision cap reached for ${phase.role}`,
								savedAt: new Date().toISOString(),
							});
							ctx.ui.setStatus?.(STATUS_KEY, undefined);
							return;
						}

						// Loop back to predecessor non-review phase
						const predIndex = findPredecessorIndex(PHASES, currentPhaseIndex);
						ctx.ui.notify(
							`⟳ forge:run-task — ${phase.role} returned revision; looping to ${PHASES[predIndex]?.role ?? predIndex} ` +
								`(attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
							"info",
						);
						// Write intermediate state (not halted — still running)
						writeState(cwd, {
							taskId,
							phaseIndex: predIndex,
							iterationCounts,
							halted: false,
							savedAt: new Date().toISOString(),
						});
						currentPhaseIndex = predIndex;
						continue;
					}

					// verdict === "approved": fall through to advance
				}

				// ── Advance to next phase ─────────────────────────────────────
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: false,
					savedAt: new Date().toISOString(),
				});
				currentPhaseIndex++;
			}

			// ── All phases complete ───────────────────────────────────────────
			deleteState(cwd, taskId);
			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.notify(
				`〇 forge:run-task — ${taskId} pipeline complete (${PHASES.length} phases).`,
				"info",
			);
		},
	});
}
