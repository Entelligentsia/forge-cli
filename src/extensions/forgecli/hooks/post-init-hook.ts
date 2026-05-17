// hooks/post-init-hook.ts — Post-init enhancement auto-trigger (FORGE-S21-T04).
//
// Fires `/forge:enhance --phase 1 --auto` after each successful `/forge:init`
// Phase 4 closure. The handler is registered on the synthetic `init-complete`
// event emitted by forge-init.ts.
//
// Plugin parity reference: forge/forge/hooks/post-init.cjs (read-only — do NOT edit).
//
// Behaviour:
//   1. Check idempotency sentinel `.forge/cache/post-init-fired-<prefix>.json`.
//      If present: notify "already fired" and return.
//   2. Load `.forge/workflows/enhance.md` and run the Pack-06 materialization
//      marker check. If any marker is missing: notify "workflow regression" and
//      return without dispatching (init already succeeded — this is post-init).
//   3. assertAudience: meta-enhance is orchestrator-only. Because the hook runs
//      from the init orchestrator context, CallerContextStore.get() returns
//      "orchestrator" → check passes. If the check fails (future pi evolution),
//      notify and return without dispatching.
//   4. Write sentinel BEFORE dispatching (fail-open: if dispatch fails, the
//      sentinel prevents re-fire flooding).
//   5. sendKickoff "/forge:enhance --phase 1 --auto". If this throws: catch,
//      notify error, do NOT re-throw (init must still report success).
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
import { onSyntheticEvent, type InitCompleteEvent } from "../hook-dispatcher.js";
import { loadWorkflow, WorkflowLoaderError } from "../loaders/workflow-loader.js";

// ── Types (re-exported for tests) ─────────────────────────────────────────────

/** Payload for the init-complete synthetic event (alias for test imports). */
export type InitCompleteEventPayload = InitCompleteEvent;

// ── Sentinel helpers ──────────────────────────────────────────────────────────

function sentinelPath(cwd: string, projectPrefix: string): string {
	return path.join(cwd, ".forge", "cache", `post-init-fired-${projectPrefix}.json`);
}

function readSentinel(sentinel: string): boolean {
	return fs.existsSync(sentinel);
}

function writeSentinel(sentinel: string, projectPrefix: string): void {
	try {
		const dir = path.dirname(sentinel);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			sentinel,
			JSON.stringify({ firedAt: new Date().toISOString(), projectPrefix }, null, 2) + "\n",
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
 * Create the init-complete handler bound to the given pi ExtensionAPI.
 * Exported for unit testing — production code calls registerPostInitHook.
 */
export function createPostInitHookHandler(
	pi: ExtensionAPI,
): (event: InitCompleteEvent, ctx: ExtensionCommandContext) => Promise<void> {
	return async function postInitHookHandler(
		event: InitCompleteEvent,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const { projectPrefix, cwd } = event;

		// 1. Idempotency sentinel
		const sentinel = sentinelPath(cwd, projectPrefix);
		if (readSentinel(sentinel)) {
			ctx.ui.notify(`post-init already fired for ${projectPrefix}, skipping`, "info");
			return;
		}

		// 2. Load and marker-check the enhance workflow
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
					`× post-init hook: enhance workflow not found at ${WORKFLOW_REL_PATH}; ` +
						"run /forge:init or /forge:regenerate first. Skipping phase-1 enhance.",
					"info",
				);
			} else {
				const e = err as { message?: string };
				ctx.ui.notify(
					`× post-init hook: failed to load enhance workflow: ${e.message ?? "unknown"}`,
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

		// 3. Audience check — meta-enhance is orchestrator-only
		// assertAudience reads CallerContextStore which defaults to "orchestrator"
		// from the init handler context. Wrapped in CallerContextStore.asSubagent
		// is NOT needed here — we ARE the orchestrator calling it, not a subagent.
		if (!assertAudience({ workflowName: "enhance", audience: workflowAudience }, ctx)) {
			// Error notification already emitted by assertAudience.
			return;
		}

		// 4. Write sentinel BEFORE dispatch (fail-open on dispatch error)
		writeSentinel(sentinel, projectPrefix);

		// 5. Dispatch /forge:enhance --phase 1 --auto (best-effort, fail-open)
		try {
			sendKickoff(pi, "/forge:enhance --phase 1 --auto");
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× post-init hook: failed to trigger /forge:enhance --phase 1 --auto: ${e.message ?? "unknown"}`,
				"error",
			);
			// Do NOT re-throw — /forge:init must still report success.
		}
	};
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the post-init hook handler on the `init-complete` synthetic event.
 * MUST be called BEFORE registerForgeInit in index.ts to prevent the
 * emit-before-consumer race described in SPRINT_REQUIREMENTS.md §Risks row 3.
 */
export function registerPostInitHook(pi: ExtensionAPI): void {
	onSyntheticEvent<InitCompleteEvent>("init-complete", createPostInitHookHandler(pi));
}
