// session-monitor.ts — register /forge:sessions slash command and Ctrl+Shift+S
// shortcut that toggle the session-monitor widget below the input swimline.
//
// Focus model: pi keeps keyboard focus on the editor when an extension widget
// is mounted via setWidget(). To route arrow keys / Tab / Esc to the widget
// while it is open, we install a ctx.ui.onTerminalInput handler that consumes
// those keys and forwards them to the widget's handleInput. Letter keys and
// Enter pass through to the editor so the user can still type and submit
// prompts while monitoring sessions.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import {
	buildSessionMonitorWidget,
	type SessionMonitorWidget,
} from "./session-monitor-widget.js";

const WIDGET_KEY = "forge-sessions";

// Process-global state. The slash command and the shortcut share one toggle
// state; pi only paints one widget per key at a time.
let isOpen = false;
let widgetRef: SessionMonitorWidget | undefined;
let unsubscribeInput: (() => void) | undefined;

// Keys that should always route to the widget while it is open.
function isWidgetKey(data: string): boolean {
	if (data === "") return true; // bare Esc
	if (data === "\t") return true; // Tab
	if (data === "[A" || data === "OA") return true; // up
	if (data === "[B" || data === "OB") return true; // down
	if (data === "[C" || data === "OC") return true; // right
	if (data === "[D" || data === "OD") return true; // left
	if (data === "[H" || data === "[F") return true; // Home / End
	if (data === "[5~" || data === "[6~") return true; // PgUp / PgDn
	return false;
}

function closeWidget(ctx: ExtensionContext): void {
	unsubscribeInput?.();
	unsubscribeInput = undefined;
	widgetRef = undefined;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	isOpen = false;
}

function toggle(ctx: ExtensionContext): void {
	if (isOpen) {
		closeWidget(ctx);
		ctx.ui.notify("forge:sessions closed", "info");
		return;
	}

	ctx.ui.notify("forge:sessions opening…", "info");

	if (process.env.FORGE_SESSIONS_PROBE === "1") {
		// Plain string[] form — confirms whether widgets render at all in this
		// pi build. Set FORGE_SESSIONS_PROBE=1 before launching forge to use.
		ctx.ui.setWidget(
			WIDGET_KEY,
			[
				"── Forge Sessions (probe) ──────────────────────────",
				"  This is the string[] form of setWidget.",
				"  If you see this, widgets render.",
				"  Press /forge:sessions again to close.",
			],
			{ placement: "belowEditor" },
		);
		isOpen = true;
		return;
	}

	try {
		const factory = buildSessionMonitorWidget({
			requestRender: () => {
				// pi re-renders widgets on its own tick when they emit lines from
				// render(); the SessionRegistry "change" listener calls
				// invalidate() on the SelectLists inside the widget.
			},
			onClose: () => {
				closeWidget(ctx);
			},
			onMount: (w) => {
				widgetRef = w;
			},
		});
		ctx.ui.setWidget(WIDGET_KEY, factory, { placement: "belowEditor" });
		isOpen = true;

		// Install raw input interceptor so arrow keys / Tab / Esc reach the
		// widget instead of the editor. Letter keys & Enter pass through.
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!widgetRef || !isOpen) return undefined;
			if (!isWidgetKey(data)) return undefined;
			try {
				widgetRef.handleInput(data);
			} catch (err: unknown) {
				const e = err as { message?: string };
				process.stderr.write(
					`[forge:sessions] widget.handleInput threw: ${e.message ?? "unknown"}\n`,
				);
			}
			return { consume: true };
		});
	} catch (err: unknown) {
		const e = err as { message?: string; stack?: string };
		ctx.ui.notify(
			`forge:sessions failed to mount: ${e.message ?? "unknown"}\n${e.stack ?? ""}`,
			"error",
		);
		isOpen = false;
	}
}

export function registerSessionMonitor(pi: ExtensionAPI): void {
	process.stderr.write(
		"[forge:sessions] registerSessionMonitor: registering command + shortcut\n",
	);

	pi.registerCommand("forge:sessions", {
		description:
			"Toggle the Forge session monitor: live list of run-task subagent sessions " +
			"with per-event details. Below the input. Shortcut: Ctrl+Shift+S. " +
			"While open: ↑↓ navigate, Tab/→ switch panes, Esc closes.",
		async handler(_args, ctx) {
			process.stderr.write("[forge:sessions] command handler invoked\n");
			try {
				toggle(ctx);
			} catch (err: unknown) {
				const e = err as { message?: string; stack?: string };
				process.stderr.write(
					`[forge:sessions] handler threw: ${e.message ?? "unknown"}\n${e.stack ?? ""}\n`,
				);
				try {
					ctx.ui.notify(
						`forge:sessions handler threw: ${e.message ?? "unknown"}`,
						"error",
					);
				} catch {
					/* notify itself failed; stderr line above is the durable trace */
				}
			}
		},
	});

	// Ctrl+L is reserved by pi (terminal clear). Use Ctrl+Shift+S — unbound by
	// default in pi and unlikely to clash with shell/terminal muscle memory.
	pi.registerShortcut(Key.ctrlShift("s"), {
		description: "Toggle Forge session monitor",
		handler: (ctx) => {
			toggle(ctx);
		},
	});
}
