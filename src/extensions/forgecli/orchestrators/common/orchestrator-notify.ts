// orchestrator-notify.ts — shared UI-notification facade for the orchestrator
// pipelines (run-task, fix-bug, run-sprint).
//
// Owns the per-command label, the status/message keys, and the two highest-
// frequency mechanical notification shapes:
//
//   error(msg)  → `× <label> — <msg>`   (level "error")
//   warn(msg)   → `⚠ <label> — <msg>`   (level "warning")
//   info(msg)   → `<label> — <msg>`     (level "info")
//
// The semantic-symbol lines (⊘ cancel, ⟳ loopback, 〇 complete, ✓ phase-done,
// → phase-start, ▶ dispatch) stay inline at their call sites but are emitted
// through `notify(...)` so they still hit the transcript recorder.
//
// IMPORTANT: every method reads `ctx.ui.notify` LIVE on each call (never a
// captured/bound reference) so the transcript-recorder swap installed by
// withOrchestratorTranscript is honored.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type NotifyLevel = Parameters<ExtensionCommandContext["ui"]["notify"]>[1];

export interface OrchestratorNotifierOptions {
	/** Command label, e.g. "forge:run-task" / "forge:fix-bug" / "forge:run-sprint". */
	label: string;
	/** ctx.ui status key for this command. */
	statusKey: string;
	/** Optional detail-message status key (absent for run-sprint). */
	messageKey?: string;
}

export interface OrchestratorNotifier {
	readonly label: string;
	readonly statusKey: string;
	/** Raw passthrough to the live ctx.ui.notify. */
	notify(message: string, level?: NotifyLevel): void;
	/** `× <label> — <msg>` at error level. */
	error(msg: string): void;
	/** `⚠ <label> — <msg>` at warning level. */
	warn(msg: string): void;
	/** `<label> — <msg>` at info level. */
	info(msg: string): void;
	/** Set the command status line. */
	setStatus(text: string): void;
	/** Clear the status key (and message key, if configured). */
	clearStatus(): void;
}

export function createOrchestratorNotifier(
	ctx: ExtensionCommandContext,
	opts: OrchestratorNotifierOptions,
): OrchestratorNotifier {
	const { label, statusKey, messageKey } = opts;
	return {
		label,
		statusKey,
		notify(message: string, level?: NotifyLevel): void {
			ctx.ui.notify(message, level);
		},
		error(msg: string): void {
			ctx.ui.notify(`× ${label} — ${msg}`, "error");
		},
		warn(msg: string): void {
			ctx.ui.notify(`⚠ ${label} — ${msg}`, "warning");
		},
		info(msg: string): void {
			ctx.ui.notify(`${label} — ${msg}`, "info");
		},
		setStatus(text: string): void {
			ctx.ui.setStatus?.(statusKey, text);
		},
		clearStatus(): void {
			ctx.ui.setStatus?.(statusKey, undefined);
			if (messageKey) ctx.ui.setStatus?.(messageKey, undefined);
		},
	};
}
