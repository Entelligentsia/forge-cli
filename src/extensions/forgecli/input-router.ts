// Centralised onTerminalInput dispatch for forge-cli.
//
// Plan 16 Slice 4c. Pi-mono's `ctx.ui.onTerminalInput` lets any extension hook
// raw stdin, with the first consumer winning. Pi runs listeners BEFORE
// routing to the focused overlay (pi-mono/packages/tui/src/tui.ts:544-560).
// That made forge-cli's two existing arrow-activator listeners
// (thread-switcher, whats-new-widget) silently eat ↑/↓ when the config TUI was
// mounted as an overlay.
//
// This router gives forge-cli a single pi listener whose dispatch is
// overlay-aware: listeners flagged `skipWhenOverlayActive: true` are bypassed
// whenever an overlay has been registered via `pushOverlay()`. Other listeners
// (critical hotkeys, theme switchers, etc.) still run.
//
// Wiring:
//   1. index.ts session_start: `ctx.ui.onTerminalInput((d) => router.dispatch(d))`.
//   2. Each consumer: `router.register(listener, { name, skipWhenOverlayActive })`.
//   3. Each overlay mounter: `router.pushOverlay()` before ctx.ui.custom,
//      `popOverlay()` in a finally.
//
// Debug logging (when FORGE_DEBUG_INPUT=1):
//   Each dispatch + push/pop is logged with timestamp + listener name +
//   overlay depth + raw byte sequence (hex-escaped). Default target:
//   /tmp/forge-input-router.log. Override with FORGE_DEBUG_INPUT_LOG=<path>.
//   Logging goes through fs.appendFileSync — synchronous so events are
//   captured even when the process crashes mid-render.

import * as fs from "node:fs";

export type RouterResult = { consume?: boolean; data?: string } | undefined;
export type RouterListener = (data: string) => RouterResult;

export interface RegisterOptions {
	/** Stable name for debugging and unsubscription tracking. */
	name: string;
	/** When true, this listener is bypassed while any overlay is active.
	 *  Use for keys that "activate" a widget (e.g. ↓ to open a strip) — the
	 *  overlay needs the same key for navigation. Default: false. */
	skipWhenOverlayActive?: boolean;
}

interface Entry {
	fn: RouterListener;
	opts: RegisterOptions;
}

function debugEnabled(): boolean {
	return process.env.FORGE_DEBUG_INPUT === "1";
}

function debugLogPath(): string {
	return process.env.FORGE_DEBUG_INPUT_LOG ?? "/tmp/forge-input-router.log";
}

function hexEscape(s: string): string {
	// Render printable ASCII as-is, escape everything else as \xNN. Helps spot
	// arrow sequences (\x1b[A etc.) and Kitty-protocol variants at a glance.
	return [...s]
		.map((c) => {
			const cp = c.codePointAt(0)!;
			if (cp >= 0x20 && cp <= 0x7e) return c;
			return `\\x${cp.toString(16).padStart(2, "0")}`;
		})
		.join("");
}

function logEvent(line: string): void {
	if (!debugEnabled()) return;
	try {
		const ts = new Date().toISOString();
		fs.appendFileSync(debugLogPath(), `${ts} ${line}\n`);
	} catch {
		// Logging must never crash the host; failure to write is silently ignored.
	}
}

export class ForgeInputRouter {
	private listeners: Entry[] = [];
	private overlayDepth = 0;

	register(listener: RouterListener, opts: RegisterOptions): () => void {
		const entry: Entry = { fn: listener, opts };
		this.listeners.push(entry);
		logEvent(
			`register name=${opts.name} skipWhenOverlayActive=${!!opts.skipWhenOverlayActive} total=${this.listeners.length}`,
		);
		return () => {
			const i = this.listeners.indexOf(entry);
			if (i >= 0) {
				this.listeners.splice(i, 1);
				logEvent(`unregister name=${opts.name} remaining=${this.listeners.length}`);
			}
		};
	}

	pushOverlay(): void {
		this.overlayDepth++;
		logEvent(`pushOverlay depth=${this.overlayDepth}`);
	}

	popOverlay(): void {
		if (this.overlayDepth > 0) this.overlayDepth--;
		logEvent(`popOverlay depth=${this.overlayDepth}`);
	}

	isOverlayActive(): boolean {
		return this.overlayDepth > 0;
	}

	/**
	 * Mirrors pi's listener-chain semantics (tui.ts:544-560):
	 * - Each listener may return { consume: true } to stop dispatch.
	 * - Each listener may return { data: rewritten } to alter the value the
	 *   next listener (and ultimately the focused overlay) sees.
	 * - Listeners flagged skipWhenOverlayActive=true are silently bypassed
	 *   whenever overlayDepth > 0.
	 */
	dispatch(data: string): RouterResult {
		if (debugEnabled()) {
			logEvent(
				`dispatch IN data="${hexEscape(data)}" overlayDepth=${this.overlayDepth} listeners=${this.listeners.length}`,
			);
		}
		let current = data;
		for (const entry of this.listeners) {
			if (this.overlayDepth > 0 && entry.opts.skipWhenOverlayActive) {
				logEvent(`  skip name=${entry.opts.name} (overlay active)`);
				continue;
			}
			const result = entry.fn(current);
			if (debugEnabled()) {
				const r =
					result === undefined
						? "passthrough"
						: `${result.consume ? "consume" : ""}${result.data !== undefined ? ` data="${hexEscape(result.data)}"` : ""}`.trim() ||
							"noop";
				logEvent(`  call name=${entry.opts.name} → ${r}`);
			}
			if (result?.consume) {
				logEvent(`dispatch OUT consumed-by=${entry.opts.name}`);
				return { consume: true };
			}
			if (result?.data !== undefined) current = result.data;
		}
		if (current !== data) {
			logEvent(`dispatch OUT rewritten data="${hexEscape(current)}"`);
			return { data: current };
		}
		logEvent(`dispatch OUT passthrough (focused overlay should receive)`);
		return undefined;
	}
}

// ── Module-level singleton ───────────────────────────────────────────────────

let singleton: ForgeInputRouter | null = null;

export function getInputRouter(): ForgeInputRouter {
	if (!singleton) singleton = new ForgeInputRouter();
	return singleton;
}

/** Test helper — replace the singleton with a fresh router. */
export function __resetInputRouterForTesting(): void {
	singleton = null;
}
