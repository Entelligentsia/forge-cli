// run-task.ts — /forge:run-task native Orchestrator handler (FORGE-S21-T02)
//
// Archetype: Orchestrator (Pack-04).
// Reads .forge/workflows/orchestrate_task.md (materialized runtime contract).
// Chains: plan → review-plan → implement → review-code → validate → approve → writeback → commit.
// Sub-workflow phases dispatched via sendKickoff (deliverAs:"steer"); each awaited
// via ctx.waitForIdle(). State persisted to .forge/cache/run-task-state-<taskId>.json.
//
// Three-layer exit-gate protocol per SPRINT_PLAN.md §Exit-Gate Protocol:
//   Layer 1: spawnSync preflight-gate before each dispatch (Iron Law 6)
//   Layer 2: post-dispatch verdict read via store-cli
//   Layer 3: 4-substring materialization-marker check against per-phase sub-workflow body (Pack-06)
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/
//   IL4 — no JSON.stringify-chain subagent dispatch
//   IL6 — argv-array spawn only; no shell-string interpolation
//   IL7 — every failure path emits ctx.ui.notify; no silent continuation

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { assertAudience, CallerContextStore } from "./audience-gate.js";
import { sendKickoff } from "./kickoff.js";
import { loadWorkflow, WorkflowLoaderError } from "./loaders/workflow-loader.js";
import type { LoadedWorkflow } from "./loaders/workflow-loader.js";
import { checkMaterialization } from "./plan.js";
import { resolveToolDir } from "./forge-tools.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface Phase {
	role: string;
	workflow: string;
	maxIterations?: number;
}

export interface RunTaskState {
	taskId: string;
	currentPhaseIndex: number;
	iterationCounts: Record<string, number>;
	lastGateFailureStderr: string;
	/** true when state written on gate-halt or escalation (resume → retry same phase) */
	gateHalted?: boolean;
	/** ISO8601 timestamp */
	timestamp: string;
}

export interface RunTaskOptions {
	cwd?: string;
}

// ── Default phase chain (D3 fix: writeback added between approve and commit) ──

export const DEFAULT_PHASES: Phase[] = [
	{ role: "plan", workflow: "plan_task.md", maxIterations: 1 },
	{ role: "review-plan", workflow: "review_plan.md", maxIterations: 3 },
	{ role: "implement", workflow: "implement_plan.md", maxIterations: 1 },
	{ role: "review-code", workflow: "review_code.md", maxIterations: 3 },
	{ role: "validate", workflow: "validate_task.md", maxIterations: 3 },
	{ role: "approve", workflow: "architect_approve.md", maxIterations: 3 },
	{ role: "writeback", workflow: "collator_agent.md", maxIterations: 1 }, // D3: added
	{ role: "commit", workflow: "commit_task.md", maxIterations: 1 },
];

// ── Role → persona noun/banner mappings (from orchestrate_task.md lines 139–263) ──

const ROLE_TO_NOUN: Record<string, string> = {
	"plan": "engineer",
	"review-plan": "architect",
	"implement": "engineer",
	"review-code": "architect",
	"validate": "qa-engineer",
	"approve": "architect",
	"writeback": "collator",
	"commit": "engineer",
};

const BANNER_MAP: Record<string, string> = {
	"plan": "forge",
	"review-plan": "forge",
	"implement": "forge",
	"review-code": "forge",
	"validate": "forge",
	"approve": "forge",
	"writeback": "forge",
	"commit": "forge",
};

// ── STALE_DAYS constant ───────────────────────────────────────────────────

const STALE_DAYS = 7;

// ── Non-interactive mode helper ───────────────────────────────────────────

export function isNonInteractive(): boolean {
	return process.env.FORGE_NON_INTERACTIVE === "1" || process.env.FORGE_YES === "1";
}

// ── Forge root resolver ───────────────────────────────────────────────────

export function resolveForgeRoot(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".forge", "config.json");
		try {
			if (fs.statSync(candidate).isFile()) {
				const raw = fs.readFileSync(candidate, "utf8");
				const config = JSON.parse(raw) as { paths?: { forgeRoot?: unknown } };
				const forgeRootValue = config?.paths?.forgeRoot;
				if (typeof forgeRootValue === "string" && forgeRootValue.length > 0) {
					const projectDir = path.dirname(path.dirname(candidate));
					return path.isAbsolute(forgeRootValue)
						? forgeRootValue
						: path.resolve(projectDir, forgeRootValue);
				}
			}
		} catch {
			// continue
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

// ── State file helpers ────────────────────────────────────────────────────

function stateFilePath(taskId: string, cwd: string): string {
	return path.join(cwd, ".forge", "cache", `run-task-state-${taskId}.json`);
}

export function readRunTaskState(taskId: string, cwd: string): RunTaskState | null {
	const filePath = stateFilePath(taskId, cwd);
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as RunTaskState;
	} catch {
		return null;
	}
}

export function writeRunTaskState(state: RunTaskState, cwd: string): void {
	const cacheDir = path.join(cwd, ".forge", "cache");
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
	} catch {
		// may already exist
	}
	fs.writeFileSync(stateFilePath(state.taskId, cwd), JSON.stringify(state, null, 2), "utf8");
}

export function purgeRunTaskState(taskId: string, cwd: string): void {
	const filePath = stateFilePath(taskId, cwd);
	try {
		fs.unlinkSync(filePath);
	} catch {
		// non-fatal
	}
}

export function isStateStale(state: RunTaskState): boolean {
	try {
		const ts = new Date(state.timestamp).getTime();
		if (isNaN(ts)) return true; // treat unparseable timestamp as stale
		const now = Date.now();
		const diffDays = (now - ts) / (1000 * 60 * 60 * 24);
		return diffDays > STALE_DAYS;
	} catch {
		return true; // treat unparseable timestamp as stale
	}
}

// ── Review-phase determination ────────────────────────────────────────────

export function isReviewPhase(role: string): boolean {
	return role === "review-plan" || role === "review-code" || role === "validate" || role === "approve";
}

// ── Phase chain resolver ──────────────────────────────────────────────────

export function resolvePhaseChain(cwd: string, _taskId: string): Phase[] {
	// Future: read task.pipeline from store, look up config.pipelines.
	// For T02, always returns DEFAULT_PHASES.
	void cwd;
	return DEFAULT_PHASES;
}

// ── findRevisionTarget ────────────────────────────────────────────────────
//
// Contract:
//   Input: phases array, currentIndex = the review phase that returned "revision"
//   Output: index of the nearest preceding phase whose role is NOT a review role
//
// Algorithm:
//   for j = currentIndex - 1 downto 0:
//     if not isReviewPhase(phases[j].role): return j
//   return 0

export function findRevisionTarget(phases: Phase[], currentIndex: number): number {
	for (let j = currentIndex - 1; j >= 0; j--) {
		if (!isReviewPhase(phases[j].role)) return j;
	}
	return 0;
}

// ── Verdict reading via store-cli ─────────────────────────────────────────

export function readVerdictFromStore(
	taskId: string,
	phaseRole: string,
	forgeRoot: string,
	cwd: string,
): "approved" | "revision" | "missing" {
	const storeCli = path.join(resolveToolDir(forgeRoot), "store-cli.cjs");
	const result = spawnSync("node", [storeCli, "read", "task", taskId, "--json"], {
		encoding: "utf8",
		cwd,
	});

	if (result.status !== 0) return "missing";

	let record: Record<string, unknown>;
	try {
		record = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		return "missing";
	}

	const summaries = record.summaries as Record<string, unknown> | undefined;
	if (!summaries) return "missing";
	const phaseSummary = summaries[phaseRole] as Record<string, unknown> | undefined;
	if (!phaseSummary) return "missing";

	const verdict = phaseSummary.verdict;
	if (verdict === "approved") return "approved";
	if (verdict === "revision") return "revision";
	return "missing";
}

// ── Materialization-marker check for sub-workflows (D2 fix) ──────────────
//
// Thin wrapper around checkMaterialization imported from plan.ts.
// Receives the SUB-WORKFLOW's path and raw markdown — NOT orchestrate_task.md's body.

export function checkMaterializationForSubWorkflow(
	subWorkflowPath: string,
	subWorkflowMd: string,
): { ok: boolean; missing: string[] } {
	return checkMaterialization(subWorkflowPath, subWorkflowMd);
}

// ── Kickoff composition ───────────────────────────────────────────────────

export interface ComposeOrchestratorKickoffOpts {
	workflowMd: string;
	taskId: string;
	phase: Phase;
	forgeRoot: string;
	cwd: string;
}

export function composeOrchestratorKickoff(opts: ComposeOrchestratorKickoffOpts): string {
	const { workflowMd, taskId, phase, cwd } = opts;

	const ts = new Date().toISOString().replace(/[-:.Z]/g, "").slice(0, 15) + "Z";
	const actionSlug = phase.role.replace(/-/g, "_");
	const eventId = `${ts}_${taskId}_${phase.role}_${actionSlug}`;
	const sprintId = taskId.replace(/-T\d+$/, "");
	const progressLog = `.forge/store/events/${sprintId}/progress.log`;
	const personaNoun = ROLE_TO_NOUN[phase.role] ?? phase.role;

	void cwd;

	return [
		`## /forge:run-task — dispatching sub-workflow: ${phase.role} for ${taskId}`,
		``,
		`You are acting as the Forge ${personaNoun} persona.`,
		`Persona file: .forge/personas/${personaNoun}.md`,
		`Skills file: .forge/skills/${personaNoun}-skills.md`,
		``,
		`### Agent Identity`,
		`- Agent name: ${taskId}:${personaNoun}:${phase.role}:1`,
		`- Banner: ${BANNER_MAP[phase.role] ?? "forge"}`,
		`- Event ID: ${eventId}`,
		`- Progress log: ${progressLog}`,
		``,
		`### Task Context`,
		`- Task ID: ${taskId}`,
		`- Phase: ${phase.role}`,
		`- Workflow to follow: .forge/workflows/${phase.workflow}`,
		``,
		`### Instruction`,
		`Read \`.forge/workflows/${phase.workflow}\` and follow it. Task ID: ${taskId}.`,
		`Append progress entries to ${progressLog} via store-cli as you work.`,
		``,
		`### Workflow Body`,
		workflowMd.trim(),
		``,
		`### Finalize`,
		`Before returning, follow the finalize fragment at $FORGE_ROOT/meta/workflows/_fragments/finalize.md`,
		`— run /cost, parse fields, emit sidecar via /forge:store emit ${sprintId} '<json>' --sidecar`,
		`with eventId ${eventId}.`,
	].join("\n");
}

// ── registerRunTask ───────────────────────────────────────────────────────

export function registerRunTask(pi: ExtensionAPI, options: RunTaskOptions = {}): void {
	pi.registerCommand("forge:run-task", {
		description:
			"Run the full task pipeline (plan → review-plan → implement → review-code → validate → approve → writeback → commit). " +
			"Usage: /forge:run-task <TASK-ID>. " +
			"Orchestrator archetype: manages dispatch state, halt-on-failure, and resume.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();

			// 1. Parse taskId from args
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify(
					"× forge:run-task — taskId required (usage: /forge:run-task <TASK-ID>)",
					"error",
				);
				return;
			}

			// 2. Load forgeRoot from .forge/config.json
			const forgeRoot = resolveForgeRoot(cwd);
			if (!forgeRoot) {
				ctx.ui.notify(
					"× forge:run-task — no Forge project at cwd; run /forge:init first",
					"error",
				);
				return;
			}

			// 3. Load orchestrator workflow + audience check (orchestrator context)
			const orchestratorWorkflowPath = path.join(cwd, ".forge", "workflows", "orchestrate_task.md");
			let orchestratorLoaded: LoadedWorkflow;
			try {
				orchestratorLoaded = loadWorkflow(orchestratorWorkflowPath);
			} catch (err: unknown) {
				if (err instanceof WorkflowLoaderError && err.code === "missing_file") {
					ctx.ui.notify(
						"× forge:run-task — orchestrate_task.md not found; run /forge:init or /forge:regenerate first.",
						"error",
					);
				} else {
					const e = err as { message?: string };
					ctx.ui.notify(
						`× forge:run-task — failed to load orchestrate_task.md: ${e.message ?? "unknown"}`,
						"error",
					);
				}
				return;
			}

			// Self-check: the orchestrator workflow's audience must be compatible with orchestrator context.
			if (!assertAudience({ workflowName: "orchestrate_task", audience: orchestratorLoaded.audience }, ctx)) {
				return;
			}

			// 4. Resume detection
			let startPhaseIndex = 0;
			const existingState = readRunTaskState(taskId, cwd);
			if (existingState) {
				if (isStateStale(existingState)) {
					ctx.ui.notify(
						`△ forge:run-task — state for ${taskId} is >7 days old. Starting fresh.`,
						"warning",
					);
					const doPurge = isNonInteractive()
						? false
						: await ctx.ui.confirm("Purge stale state?", "The previous run state is stale (>7 days). Purge it?");
					if (doPurge) {
						purgeRunTaskState(taskId, cwd);
					}
					// start fresh regardless of purge answer
					startPhaseIndex = 0;
				} else {
					const shouldResume = isNonInteractive()
						? process.env.FORGE_YES === "1"
						: await ctx.ui.confirm(
								"Resume run-task?",
								`Last recorded phase index: ${existingState.currentPhaseIndex}. Resume?`,
							);
					if (shouldResume) {
						// If state was written on a gate-halt, retry the same phase.
						// If written on successful completion, advance past completed phase.
						startPhaseIndex = existingState.gateHalted
							? existingState.currentPhaseIndex // retry failed phase
							: existingState.currentPhaseIndex + 1; // advance past completed phase
					} else {
						purgeRunTaskState(taskId, cwd);
						startPhaseIndex = 0;
					}
				}
			}

			// 5. Resolve phase chain from config or default
			const phases = resolvePhaseChain(cwd, taskId);

			// 6. Phase loop
			const iterationCounts: Record<string, number> = existingState?.iterationCounts ?? {};
			ctx.ui.setStatus?.("forge:run-task", `Running ${taskId}...`);

			let i = startPhaseIndex;
			while (i < phases.length) {
				const phase = phases[i];

				// ── Layer 1: preflight-gate ──────────────────────────────────────
				const gateResult = spawnSync(
					"node",
					[
						path.join(resolveToolDir(forgeRoot), "preflight-gate.cjs"),
						"--phase",
						phase.role,
						"--task",
						taskId,
					],
					{ encoding: "utf8", cwd },
				);

				if (gateResult.status === 1) {
					ctx.ui.notify(
						`× forge:run-task — preflight gate failed for phase '${phase.role}': ${(gateResult.stderr ?? "").trim()}`,
						"error",
					);
					writeRunTaskState(
						{
							taskId,
							currentPhaseIndex: i,
							iterationCounts,
							lastGateFailureStderr: (gateResult.stderr ?? "").trim(),
							gateHalted: true,
							timestamp: new Date().toISOString(),
						},
						cwd,
					);
					if (!isNonInteractive()) {
						await ctx.ui.confirm(
							"Gate failed — resume later?",
							"The preflight gate failed. State has been saved; you can resume this run later.",
						);
					}
					ctx.ui.setStatus?.("forge:run-task", undefined);
					return;
				}

				if (gateResult.status === 2) {
					ctx.ui.notify(
						`× forge:run-task — preflight gate misconfigured for phase '${phase.role}' (exit 2). Escalating.`,
						"error",
					);
					ctx.ui.setStatus?.("forge:run-task", undefined);
					return;
				}

				// 6a. Load sub-workflow (needed for Layer 3 marker check AND audience check)
				const subWorkflowPath = path.join(cwd, ".forge", "workflows", phase.workflow);
				let subLoaded: LoadedWorkflow;
				try {
					subLoaded = loadWorkflow(subWorkflowPath);
				} catch (err: unknown) {
					const msg =
						err instanceof WorkflowLoaderError ? err.message : (err as { message?: string }).message ?? String(err);
					ctx.ui.notify(
						`× forge:run-task — cannot load sub-workflow '${phase.workflow}': ${msg}`,
						"error",
					);
					writeRunTaskState(
						{
							taskId,
							currentPhaseIndex: i,
							iterationCounts,
							lastGateFailureStderr: msg,
							gateHalted: true,
							timestamp: new Date().toISOString(),
						},
						cwd,
					);
					ctx.ui.setStatus?.("forge:run-task", undefined);
					return;
				}

				// ── Layer 3: materialization-marker check (D2 fix) ───────────────
				// Check is against the SUB-WORKFLOW's body, not orchestrate_task.md.
				const markerCheck = checkMaterializationForSubWorkflow(subWorkflowPath, subLoaded.rawMarkdown);
				if (!markerCheck.ok) {
					for (const m of markerCheck.missing) {
						ctx.ui.notify(`× workflow regression: ${m} not found in ${subWorkflowPath}`, "error");
					}
					ctx.ui.setStatus?.("forge:run-task", undefined);
					return;
				}

				// 6b. assertAudience for the sub-workflow in subagent context (D1 fix)
				// The LLM driving the sub-workflow IS the subagent — check from subagent perspective.
				const audienceOk = CallerContextStore.asSubagent(() =>
					assertAudience({ workflowName: phase.workflow, audience: subLoaded.audience }, ctx),
				);
				if (!audienceOk) {
					// assertAudience already emitted ctx.ui.notify. Persist state and halt.
					writeRunTaskState(
						{
							taskId,
							currentPhaseIndex: i,
							iterationCounts,
							lastGateFailureStderr: `audience check failed for ${phase.workflow}`,
							gateHalted: true,
							timestamp: new Date().toISOString(),
						},
						cwd,
					);
					ctx.ui.setStatus?.("forge:run-task", undefined);
					return;
				}

				// Compose sub-workflow kickoff and dispatch
				ctx.ui.setStatus?.("forge:run-task", `${taskId} / ${phase.role}`);
				const kickoffText = composeOrchestratorKickoff({
					workflowMd: subLoaded.rawMarkdown,
					taskId,
					phase,
					forgeRoot,
					cwd,
				});

				sendKickoff(pi, kickoffText);
				await ctx.waitForIdle();

				// ── Layer 2: post-dispatch verdict check (for review/approval phases) ──
				if (isReviewPhase(phase.role)) {
					const verdict = readVerdictFromStore(taskId, phase.role, forgeRoot, cwd);
					if (verdict === "approved") {
						// Successful: checkpoint the completed phase index (gateHalted=false)
						writeRunTaskState(
							{
								taskId,
								currentPhaseIndex: i,
								iterationCounts,
								lastGateFailureStderr: "",
								gateHalted: false,
								timestamp: new Date().toISOString(),
							},
							cwd,
						);
						i++;
					} else if (verdict === "revision") {
						const count = (iterationCounts[phase.role] ?? 0) + 1;
						iterationCounts[phase.role] = count;
						if (count >= (phase.maxIterations ?? 3)) {
							ctx.ui.notify(
								`× forge:run-task — max iterations (${count}) reached for '${phase.role}' on ${taskId}. Escalating.`,
								"error",
							);
							writeRunTaskState(
								{
									taskId,
									currentPhaseIndex: i,
									iterationCounts,
									lastGateFailureStderr: "",
									gateHalted: true,
									timestamp: new Date().toISOString(),
								},
								cwd,
							);
							ctx.ui.setStatus?.("forge:run-task", undefined);
							return;
						}
						// Loop to nearest preceding non-review phase
						i = findRevisionTarget(phases, i);
					} else {
						// verdict === "missing"
						ctx.ui.notify(
							`× forge:run-task — verdict missing for phase '${phase.role}' on ${taskId}. Escalating.`,
							"error",
						);
						writeRunTaskState(
							{
								taskId,
								currentPhaseIndex: i,
								iterationCounts,
								lastGateFailureStderr: "verdict missing",
								gateHalted: true,
								timestamp: new Date().toISOString(),
							},
							cwd,
						);
						ctx.ui.setStatus?.("forge:run-task", undefined);
						return;
					}
				} else {
					// Non-review phase: advance; checkpoint the completed phase (gateHalted=false)
					writeRunTaskState(
						{
							taskId,
							currentPhaseIndex: i,
							iterationCounts,
							lastGateFailureStderr: "",
							gateHalted: false,
							timestamp: new Date().toISOString(),
						},
						cwd,
					);
					i++;
				}
			}

			// 7. Complete
			ctx.ui.setStatus?.("forge:run-task", undefined);
			ctx.ui.notify(`〇 forge:run-task — ${taskId} pipeline complete.`, "info");
		},
	});
}
