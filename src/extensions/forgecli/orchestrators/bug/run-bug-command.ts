// run-bug-command.ts — the /forge:fix-bug command handler (config discovery,
// bug-ID resolution / minting, resume detection, session registration, then
// delegate to runBugPipeline). Extracted VERBATIM from fix-bug.ts (no logic
// changes).

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { assertAudience, CallerContextStore } from "../../audience-gate.js";
import { type ForgeToolDefs } from "../../forge-tools.js";
import { loadGovernorProjectConfig } from "../../governor-config.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";
import { loadWorkflow } from "../../parsers/workflow-loader.js";
import { getSessionRegistry } from "../../session-registry.js";
import { resolveToCanonicalId, resolveToolDir } from "../../store/store-resolver.js";
import { archiveRun } from "../../transcript-archive.js";
import { createOrchestratorNotifier } from "../common/orchestrator-notify.js";
import { resolveOrchestratorEntry } from "../common/orchestrator-entry.js";
import { formatLocalTime, isNonInteractive } from "../common/orchestrator-misc.js";

import { assignNextBugId, extractBugIdFromReportText, preCreateBug, readBugRecord } from "./bug-id.js";
import { BUG_PHASES, BUG_TERMINAL_STATES } from "./bug-phases.js";
import { deleteBugState, isBugStateStale, readBugState, type RunBugState } from "./bug-state.js";
import { runBugPipeline } from "./run-bug-pipeline.js";

const STATUS_KEY = "forge:fix-bug";
const MESSAGE_KEY = "forge:fix-bug:message";

// ── Thin wrapper registration ────────────────────────────────────────────

export interface RegisterFixBugOptions {
	cwd?: string;
	forgeToolDefs?: ForgeToolDefs;
}

export function registerFixBug(pi: ExtensionAPI, options: RegisterFixBugOptions = {}): void {
	pi.registerCommand("forge:fix-bug", {
		description:
			"Run the full bug-fix pipeline (triage → plan-fix → review-plan → implement → review-code → approve → commit). " +
			"Usage: /forge:fix-bug <BUG_ID_OR_SUMMARY>. " +
			"Orchestrator archetype: each phase is an isolated subagent session (IL10).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const rawArg = args.trim();

			if (!rawArg) {
				ctx.ui.notify(
					"× forge:fix-bug — bug ID or summary required. Usage: /forge:fix-bug <BUG_ID_OR_SUMMARY>",
					"error",
				);
				return;
			}

			const notify = createOrchestratorNotifier(ctx, {
				label: "forge:fix-bug",
				statusKey: STATUS_KEY,
				messageKey: MESSAGE_KEY,
			});
			notify.setStatus(`fix-bug: initializing…`);

			// ── Discover forge config + sweep orphaned transcripts ───────────
			const entry = resolveOrchestratorEntry({ cwd, notify });
			if (!entry) return;
			const { forgeRoot, storeCli, preflightGate } = entry;

			// ── Determine bugId ────────────────────────────────────────────
			let bugId: string;
			let isNewBug = false;

			// Check if arg looks like it could be a bug ID (prefixed or unprefixed).
			// Covers: FORGE-BUG-042, BUG-042, B042.
			const looksLikeBugId = /^(?:[A-Z0-9]+-)?(?:BUG-?\d+|B\d+)$/i.test(rawArg) || /^BUG-\d+$/i.test(rawArg);

			if (/^[A-Z][A-Z0-9]*-BUG-\d+$/.test(rawArg)) {
				// Canonical prefixed bug ID (any project prefix, e.g. FORGE-BUG-042,
				// CART-BUG-001) — verify it exists. Previously hardcoded to FORGE-,
				// which pushed other-prefix canonical IDs through the resolver.
				bugId = rawArg;
				const bugRecord = readBugRecord(bugId, storeCli, cwd);
				if (!bugRecord) {
					ctx.ui.notify(`× forge:fix-bug — bug ${bugId} not found in store.`, "error");
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
				// Check if bug is already in a terminal state
				if (BUG_TERMINAL_STATES.has(bugRecord.status ?? "")) {
					ctx.ui.notify(
						`× forge:fix-bug — bug ${bugId} is already in terminal state '${bugRecord.status}'. No further processing.`,
						"error",
					);
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
			} else if (looksLikeBugId) {
				// Unprefixed bug ID — resolve through the store cascade.
				// Issue #20: unprefixed entity IDs silently poisoned substitutions.
				const toolDir = resolveToolDir(forgeRoot);
				const resolvedBugId = await resolveToCanonicalId(rawArg, toolDir, cwd, "bug", {
					ctx,
					commandLabel: "forge:fix-bug",
				});
				if (!resolvedBugId) {
					// Error already emitted by resolver
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
					return;
				}
				bugId = resolvedBugId;
				// Re-verify the resolved bug exists
				const bugRecord = readBugRecord(bugId, storeCli, cwd);
				if (!bugRecord) {
					ctx.ui.notify(`× forge:fix-bug — bug ${bugId} not found in store.`, "error");
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
				if (BUG_TERMINAL_STATES.has(bugRecord.status ?? "")) {
					ctx.ui.notify(
						`× forge:fix-bug — bug ${bugId} is already in terminal state '${bugRecord.status}'. No further processing.`,
						"error",
					);
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
			} else {
				// @file or free-form text. If an @file report references a canonical
				// <PREFIX>-BUG-NNN that already exists in the store, fix THAT record —
				// minting a new bug here duplicated CART-BUG-001 as a phantom in the
				// CART incident (the report header carried the real ID all along).
				let reportBugId: string | null = null;
				if (rawArg.startsWith("@")) {
					const rel = rawArg.slice(1).trim();
					const reportPath = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
					try {
						// 256 KB cap — bug reports are small; never slurp arbitrary files.
						if (fs.existsSync(reportPath) && fs.statSync(reportPath).size <= 262144) {
							const projectPrefix = loadGovernorProjectConfig(cwd).prefix;
							reportBugId = extractBugIdFromReportText(fs.readFileSync(reportPath, "utf8"), projectPrefix);
						}
					} catch {
						/* unreadable report — fall through to new-bug intake */
					}
				}

				const reportRecord = reportBugId ? readBugRecord(reportBugId, storeCli, cwd) : null;
				if (reportBugId && reportRecord) {
					if (BUG_TERMINAL_STATES.has(reportRecord.status ?? "")) {
						ctx.ui.notify(
							`× forge:fix-bug — ${rawArg} references ${reportBugId}, which is already in terminal state ` +
								`'${reportRecord.status}'. No further processing.`,
							"error",
						);
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						return;
					}
					bugId = reportBugId;
					ctx.ui.notify(
						`forge:fix-bug — ${rawArg} references existing bug ${bugId}; fixing it (no new record minted).`,
						"info",
					);
				} else {
					// Free-form text (or report with no resolvable ID) — defer bug
					// creation to the triage-phase subagent via a PENDING placeholder.
					bugId = `PENDING-${Date.now()}`;
					isNewBug = true;
				}
			}

			// ── Pre-flight confirm ───────────────────────────────────────────
			if (!isNonInteractive()) {
				const confirmMsg = isNewBug
					? `Fix bug: "${rawArg.slice(0, 80)}"? A bug record will be created during triage.`
					: `Fix bug ${bugId}?`;
				const proceed = await ctx.ui.confirm(`Fix bug?`, confirmMsg);
				if (!proceed) {
					ctx.ui.notify("forge:fix-bug — cancelled.", "info");
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
			}

			// ── Resume detection ─────────────────────────────────────────────
			const registry = getSessionRegistry();
			const existing = isNewBug ? null : readBugState(cwd, bugId);
			let resumeFromState: RunBugState | undefined;

			if (existing) {
				if (isBugStateStale(existing)) {
					ctx.ui.notify(
						`⚠ forge:fix-bug — cached state for ${bugId} is stale (>7 days old, saved at ${formatLocalTime(existing.savedAt)}). Offering purge.`,
						"warning",
					);
					if (!isNonInteractive()) {
						const purge = await ctx.ui.confirm(
							`Purge stale state for ${bugId}?`,
							"The cached state is older than 7 days. Purge and restart from the beginning?",
						);
						if (purge) {
							deleteBugState(cwd, bugId);
						} else {
							ctx.ui.notify("forge:fix-bug — stale state kept; aborting.", "info");
							ctx.ui.setStatus?.(STATUS_KEY, undefined);
							ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
							return;
						}
					} else {
						ctx.ui.notify("forge:fix-bug — stale state; non-interactive mode auto-aborting.", "info");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}
				} else {
					// ADR-S21-01: offer resume for ALL non-stale states — halted=true
					// (explicit failure), halted=false (cancelled/interrupted), and
					// any state with existing.status set.
					const stateStatus = existing.status ?? (existing.halted ? "halted" : "interrupted");
					const statusLabel =
						stateStatus === "cancelled" ? "cancelled" : stateStatus === "halted" ? "halted" : "interrupted";
					const phaseRole = BUG_PHASES[existing.phaseIndex]?.role ?? existing.phaseIndex;
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume ${bugId}?`,
							`Cached state — phase ${existing.phaseIndex} (${phaseRole}), ${statusLabel}, ` +
								`saved at ${formatLocalTime(existing.savedAt)}. Resume from here?`,
						);
						if (resume) {
							resumeFromState = existing;
							ctx.ui.notify(
								`forge:fix-bug — resuming ${bugId} from phase ${phaseRole} (${statusLabel})`,
								"info",
							);
						} else {
							deleteBugState(cwd, bugId);
						}
					} else {
						// Non-interactive: auto-resume from state (no confirmation).
						// Cancelled/interrupted states are valid resume points.
						resumeFromState = existing;
						ctx.ui.notify(`forge:fix-bug — resuming ${bugId} from phase ${phaseRole} (${statusLabel})`, "info");
					}
				}
			}

			// For new bugs, triage phase will create the bug record.
			// After triage, we need to capture the bugId from the subagent events.
			// This is handled inside runBugPipeline via onEvent interception.
			// For now, we pass the temporary bugId; runBugPipeline will update it.

			// ── Materialization check (top-level workflow) ──────────────────
			const workflowPath = path.join(cwd, ".forge", "workflows", "fix_bug.md");
			if (fs.existsSync(workflowPath)) {
				try {
					const loaded = loadWorkflow(workflowPath);
					// AC#12: Top-level audience check for the fix_bug.md workflow.
					// The orchestrator ITSELF runs fix_bug.md (not a subagent), so check
					// from orchestrator context. Using asSubagent would falsely reject
					// orchestrator-only workflows called by the orchestrator.
					const topAudienceOk = CallerContextStore.asOrchestrator(() =>
						assertAudience({ workflowName: "fix_bug", audience: loaded.audience }, ctx),
					);
					if (!topAudienceOk) {
						ctx.ui.notify("× forge:fix-bug — audience check failed for top-level fix_bug workflow.", "error");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}

					// Note: no materialization-marker check here. fix_bug.md is the
					// orchestrator workflow (prose algorithm), not a sub-workflow that
					// subagents run directly. Per-phase sub-workflows (architect_approve,
					// review_code, etc.) each get their own materialization check inside
					// runBugPipeline at line ~481, which is the correct guard layer.
				} catch {
					// Workflow file exists but couldn't be read — non-fatal, continue
				}
			}

			// ── Pre-assign real bug ID for new bugs ────────────────────────
			// Previously this was done inside runBugPipeline, but the session registry
			// needs the real ID before startSession is called.
			if (isNewBug && bugId.startsWith("PENDING-")) {
				const realBugId = assignNextBugId(storeCli, cwd, loadGovernorProjectConfig(cwd).prefix);
				const title = rawArg && !rawArg.startsWith("@") ? rawArg.slice(0, 120) : "New bug (pending triage)";
				if (preCreateBug(realBugId, title, storeCli, cwd)) {
					ctx.ui.notify(`forge:fix-bug — pre-assigned bug ID: ${realBugId}`, "info");
					bugId = realBugId;
				} else {
					ctx.ui.notify(
						"× forge:fix-bug — failed to pre-create bug record. Falling back to PENDING capture.",
						"error",
					);
				}
			}

			// Register session
			registry.startSession(bugId);

			// Bridge: register bug in OrchestratorTree.
			const tree = getOrchestratorTree();
			tree.startNode(bugId, { label: `fix-bug ${bugId}`, kind: "orchestrator" });

			// ── Delegate to pipeline ─────────────────────────────────────────
			// ── Delegate to pipeline ─────────────────────────────────────────
			const signal = registry.getAbortSignal(bugId);

			const pipelineResult = await runBugPipeline({
				bugId,
				originalArg: isNewBug ? rawArg : undefined,
				isNewBug,
				cwd,
				ctx,
				forgeRoot,
				storeCli,
				preflightGate,
				registry,
				resumeFromState,
				signal,
				forgeToolDefs: options.forgeToolDefs,
			});

			// ── Handle result ────────────────────────────────────────────────
			if (pipelineResult.status === "completed") {
				registry.completeSession(bugId, "completed");
				tree.completeNode(bugId, "completed");
				ctx.ui.notify(`〇 forge:fix-bug — ${bugId} pipeline complete (${BUG_PHASES.length} phases).`, "info");
			} else if (pipelineResult.status === "cancelled") {
				registry.completeSession(bugId, "cancelled");
				tree.completeNode(bugId, "cancelled");
			} else {
				registry.completeSession(bugId, "failed");
				tree.completeNode(bugId, "failed");
			}

			// Mirror this run into the central transcript archive (best-effort —
			// archiveRun never throws).
			if (pipelineResult.orchestratorTranscriptPath) {
				archiveRun({
					cwd,
					orchestratorJsonlPath: pipelineResult.orchestratorTranscriptPath,
				});
			}

			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
		},
	});
}
