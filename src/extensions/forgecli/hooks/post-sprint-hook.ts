// hooks/post-sprint-hook.ts — Post-sprint enhancement auto-trigger (FORGE-S21-T05).
//
// Fires `/forge:enhance --phase 2` after each successful sprint collate phase.
// The handler is registered on the synthetic `sprint-collate-complete` event
// emitted by run-sprint.ts after the sprint's collate completes.
//
// Plugin parity reference: forge/forge/hooks/post-sprint.cjs (read-only — do NOT edit).
//
// Parity contract:
//   - Filter regex `^[A-Z]+-S\d+$` excludes bug IDs (FORGE-BUG-015, BUG-031, etc.)
//     matching the plugin's trigger regex `\S*-S\d+` which also requires the
//     sprint-ID shape. Bug-fix collate runs must NOT trigger sprint enhancement.
//   - Idempotency sentinel per sprint: `.forge/cache/post-sprint-<id>-enhancement-triggered`
//     (mirrors plugin sentinel naming).
//   - Fail-open: error in any step → ctx.ui.notify, return without throwing.
//
// Behaviour:
//   1. Validate sprint-ID regex gate `^[A-Z]+-S\d+$`. Bug IDs filtered out;
//      handler notifies and returns without dispatching.
//   2. Check idempotency sentinel `.forge/cache/post-sprint-<id>-enhancement-triggered`.
//      If present: notify "already fired" and return.
//   3. Load `.forge/workflows/enhance.md` and run the Pack-06 materialization
//      marker check. If any marker is missing: notify "workflow regression" and
//      return without dispatching.
//   4. assertAudience: meta-enhance is orchestrator-only. Hook runs from the
//      run-sprint orchestrator context → CallerContextStore returns "orchestrator"
//      → check passes.
//   5. Write sentinel BEFORE dispatching (fail-open: if dispatch fails, the
//      sentinel prevents re-fire flooding).
//   6. sendKickoff "/forge:enhance --phase 2". If this throws: catch, notify
//      error, do NOT re-throw (sprint must still report success).
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL6 — no shell-string interpolation; no spawn calls.
//   IL7 — every failure path emits ctx.ui.notify and returns; no silent
//         continuation past a gate failure.
//   AC#8 — NO ctx.ui.input/select. NO raw fs.writeFile to .forge/store/.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertAudience } from "../audience-gate.js";
import { sendKickoff } from "../kickoff.js";
import { checkMaterialization } from "../enhance.js";
import { onSyntheticEvent, type SprintCollateCompleteEvent } from "../hook-dispatcher.js";
import { loadWorkflow, WorkflowLoaderError } from "../loaders/workflow-loader.js";

// ── Types (re-exported for tests) ─────────────────────────────────────────────

/** Payload for the sprint-collate-complete synthetic event (alias for test imports). */
export type SprintCollateCompleteEventPayload = SprintCollateCompleteEvent;

// ── Sprint-ID regex gate ──────────────────────────────────────────────────────

/**
 * Sprint-ID shape gate. Bug IDs like `FORGE-BUG-015` or `BUG-031` do NOT
 * match — they lack the `-S\d+` suffix. Parity with plugin post-sprint.cjs.
 *
 * Pattern requires:
 *   - One or more uppercase letters (e.g. FORGE, PROJECT)
 *   - Literal `-S`
 *   - One or more digits (sprint number)
 *
 * Examples:
 *   FORGE-S21       → matches (sprint)
 *   PROJECT-S3      → matches (sprint)
 *   FORGE-BUG-015   → no match (bug ID)
 *   BUG-031         → no match (bug ID — no uppercase prefix before -S)
 *   FORGE-BUG-S21   → no match (segment before -S\d+ must be first after prefix)
 *
 * Note: plugin regex `\S*-S\d+` is anchored by the collate.cjs trigger context;
 * in the synthetic event path we have the sprintId directly so we can apply a
 * stricter full-string match.
 */
export const SPRINT_ID_REGEX = /^[A-Z]+-S\d+$/;

export function isSprintId(id: string): boolean {
	return SPRINT_ID_REGEX.test(id);
}

// ── Sentinel helpers ──────────────────────────────────────────────────────────

function sentinelPath(cwd: string, sprintId: string): string {
	return path.join(cwd, ".forge", "cache", `post-sprint-${sprintId}-enhancement-triggered`);
}

function readSentinel(sentinel: string): boolean {
	return fs.existsSync(sentinel);
}

function writeSentinel(sentinel: string, sprintId: string): void {
	try {
		const dir = path.dirname(sentinel);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			sentinel,
			JSON.stringify({ firedAt: new Date().toISOString(), sprintId }, null, 2) + "\n",
			"utf8",
		);
	} catch {
		// Non-fatal: if write fails the sentinel won't prevent re-fire.
		// The worst case is a redundant enhance run — acceptable.
	}
}

// ── Handler factory ───────────────────────────────────────────────────────────

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "enhance.md");

/**
 * Create the sprint-collate-complete handler bound to the given pi ExtensionAPI.
 * Exported for unit testing — production code calls registerPostSprintHook.
 */
export function createPostSprintHookHandler(
	pi: ExtensionAPI,
): (event: SprintCollateCompleteEvent, ctx: ExtensionCommandContext) => Promise<void> {
	return async function postSprintHookHandler(
		event: SprintCollateCompleteEvent,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const { sprintId, cwd } = event;

		// 1. Sprint-ID regex gate — filter out bug IDs
		if (!isSprintId(sprintId)) {
			ctx.ui.notify(
				`post-sprint hook: sprintId "${sprintId}" does not match sprint-ID shape ` +
					`(^[A-Z]+-S\\d+$); skipping enhance trigger (bug-fix collate, not sprint collate).`,
				"info",
			);
			return;
		}

		// 2. Idempotency sentinel
		const sentinel = sentinelPath(cwd, sprintId);
		if (readSentinel(sentinel)) {
			ctx.ui.notify(`post-sprint already fired for ${sprintId}, skipping`, "info");
			return;
		}

		// 3. Load and marker-check the enhance workflow
		const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);
		let workflowMd: string;
		let workflowAudience: import("../loaders/workflow-loader.js").AudienceValue;
		try {
			const loaded = loadWorkflow(workflowPath);
			workflowMd = loaded.rawMarkdown;
			workflowAudience = loaded.audience;
		} catch (err: unknown) {
			if (err instanceof WorkflowLoaderError && err.code === "missing_file") {
				ctx.ui.notify(
					`× post-sprint hook: enhance workflow not found at ${WORKFLOW_REL_PATH}; ` +
						"run /forge:init or /forge:regenerate first. Skipping phase-2 enhance.",
					"info",
				);
			} else {
				const e = err as { message?: string };
				ctx.ui.notify(
					`× post-sprint hook: failed to load enhance workflow: ${e.message ?? "unknown"}`,
					"error",
				);
			}
			return;
		}

		const markerCheck = checkMaterialization(workflowPath, workflowMd);
		if (!markerCheck.ok) {
			for (const marker of markerCheck.missing) {
				ctx.ui.notify(`× workflow regression: ${marker} not found in ${workflowPath}`, "error");
			}
			return;
		}

		// 4. Audience check — meta-enhance is orchestrator-only
		// assertAudience reads CallerContextStore which defaults to "orchestrator"
		// from the run-sprint orchestrator context.
		if (!assertAudience({ workflowName: "enhance", audience: workflowAudience }, ctx)) {
			// Error notification already emitted by assertAudience.
			return;
		}

		// 5. Write sentinel BEFORE dispatch (fail-open on dispatch error)
		writeSentinel(sentinel, sprintId);

		// 6. Dispatch /forge:enhance --phase 2 (best-effort, fail-open)
		try {
			sendKickoff(pi, "/forge:enhance --phase 2");
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× post-sprint hook: failed to trigger /forge:enhance --phase 2: ${e.message ?? "unknown"}`,
				"error",
			);
			// Do NOT re-throw — sprint must still report success.
		}
	};
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the post-sprint hook handler on the `sprint-collate-complete`
 * synthetic event. MUST be called BEFORE registerRunSprint in index.ts to
 * prevent the emit-before-consumer race.
 */
export function registerPostSprintHook(pi: ExtensionAPI): void {
	onSyntheticEvent<SprintCollateCompleteEvent>(
		"sprint-collate-complete",
		createPostSprintHookHandler(pi),
	);
}
