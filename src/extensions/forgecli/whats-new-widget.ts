// What's-New strip + detail widget.
//
// Mounts a single-row strip below the editor on session_start when the
// running versions of pi / forge-plugin / forge-cli have advanced past
// the last-seen baseline. UX mirrors thread-switcher.ts:
//
//   INACTIVE (default): "what's new ─ pi 30 · forge-plugin 8 · forge-cli 2  ↓ to view"
//   ACTIVE   (↓):       "what's new ─ ▸● pi 30   ○ forge-plugin 8   ○ forge-cli 2  ←→ · enter · esc dismiss"
//
//   Enter on a chip → setOutputSource(WhatsNewDetailComponent) showing
//   that component's full changelog between previous-seen and current.
//   Esc → setOutputSource(null), strip remains until user dismisses.
//   Esc twice (or `d`) → dismissWhatsNew(): collapse prev baseline to
//   seen so the strip stops auto-mounting and /whats-new returns empty.
//
// Activation key (↓) only fires when the editor has no newlines, same
// guard thread-switcher uses to avoid breaking multi-line nav.
//
// Coexistence with thread-switcher: both register widgets at
// `belowEditor` and both consume ↓ when active. In practice the
// What's-New strip is short-lived (clears on first Esc/dismiss), and
// auto-clears its summaries once the user has interacted; thread-switcher
// only activates once a run-task session exists, which doesn't happen
// during the startup-banner window.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	type ChangeSummary,
	computeAndPersistStartupPanel,
	computeSummaries,
	computeWhatsNewView,
	dismissWhatsNew,
	readSeenState,
	renderComponentDetail,
	renderSummaryPanel,
	resolveChangelogPaths,
	type WhatsNewRuntime,
} from "./whats-new.js";
import * as os from "node:os";
import * as path from "node:path";

const WIDGET_KEY = "forge:whats-new";

// ── Detail-view component: rendered into chat viewport on Enter ──────────

class WhatsNewDetailComponent implements Component {
	private invalidationCb?: () => void;

	constructor(private lines: string[]) {}

	render(width: number): string[] {
		return this.lines.map((l) => (visibleWidth(l) <= width ? l : truncateToWidth(l, width)));
	}

	invalidate(): void {
		// Static content — re-render only when caller updates `lines`.
	}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
	}

	updateLines(lines: string[]): void {
		this.lines = lines;
		this.invalidationCb?.();
	}

	dispose: () => void = () => {};
}

// ── Strip component: single row below the editor ─────────────────────────

class WhatsNewStripComponent implements Component {
	private cursorIdx = 0;
	private stripActive = false;
	/** Component currently focused into the chat viewport. */
	private focusedComponent: string | null = null;
	private invalidationCb?: () => void;

	constructor(
		private summaries: ChangeSummary[],
		private readonly theme: Theme,
	) {}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
	}

	invalidate(): void {
		// Re-render driven by caller via invalidationCb → tui.requestRender().
	}

	hasContent(): boolean {
		return this.summaries.length > 0;
	}

	getStripActive(): boolean {
		return this.stripActive;
	}

	cursorSummary(): ChangeSummary | undefined {
		return this.summaries[this.cursorIdx];
	}

	setStripActive(active: boolean): void {
		if (this.stripActive === active) return;
		this.stripActive = active;
		this.invalidationCb?.();
	}

	moveCursor(delta: number): void {
		if (this.summaries.length === 0) return;
		this.cursorIdx = Math.max(0, Math.min(this.summaries.length - 1, this.cursorIdx + delta));
		this.invalidationCb?.();
	}

	setFocused(id: string | null): void {
		this.focusedComponent = id;
		this.invalidationCb?.();
	}

	clearSummaries(): void {
		this.summaries = [];
		this.focusedComponent = null;
		this.invalidationCb?.();
	}

	render(width: number): string[] {
		if (!this.hasContent()) return [];
		const dim = (s: string) => this.theme.fg("dim", s);
		const accent = (s: string) => this.theme.fg("accent", s);
		const bold = (s: string) => this.theme.bold(s);

		const prefix = this.stripActive ? accent("what's new ─ ") : dim("what's new ─ ");
		const hint = this.stripActive ? dim("  ←→ · enter · esc dismiss") : dim("  ↓ to view");

		const parts = this.summaries.map((s, i) => {
			const focusedGlyph = this.focusedComponent === s.component ? "●" : "○";
			const inner = `${focusedGlyph} ${s.label} ${s.totalChanges}`;
			if (this.stripActive && i === this.cursorIdx) return accent(bold(`▸${inner}`));
			return dim(inner);
		});
		const chips = parts.join("   ");
		let line = `${prefix}${chips}${hint}`;
		if (visibleWidth(line) > width) line = truncateToWidth(line, width);
		return [line];
	}

	dispose: () => void = () => {};
}

// ── Key recognition (mirrors thread-switcher.ts) ─────────────────────────

function isLeftArrow(d: string): boolean {
	return d === "\x1b[D";
}
function isRightArrow(d: string): boolean {
	return d === "\x1b[C";
}
function isDownArrow(d: string): boolean {
	return d === "\x1b[B" || d === "\x1bOB";
}
function isUpArrow(d: string): boolean {
	return d === "\x1b[A" || d === "\x1bOA";
}
function isEnter(d: string): boolean {
	return d === "\r" || d === "\n";
}
function isEsc(d: string): boolean {
	return d === "\x1b";
}

// ── Mount ────────────────────────────────────────────────────────────────

/**
 * Compute startup summaries and, if any, mount the strip widget. Marks
 * versions as seen via the standard cache so subsequent sessions won't
 * auto-mount unless a new bump occurs. Returns true when mounted.
 */
export async function mountWhatsNewWidgetOnStartup(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rt: WhatsNewRuntime,
): Promise<boolean> {
	const result = await computeAndPersistStartupPanel(rt);
	if (!result || result.summaries.length === 0) return false;
	mountStripWithSummaries(pi, ctx, rt, result.summaries);
	return true;
}

/**
 * Mount the strip directly with a pre-computed summary list. Used by the
 * `/whats-new` slash command to replay the panel without re-touching the
 * seen baseline.
 */
export function mountStripWithSummaries(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rt: WhatsNewRuntime,
	summaries: ChangeSummary[],
): void {
	let stripRef: WhatsNewStripComponent | undefined;
	let tuiRef: TUI | undefined;
	let detailRef: WhatsNewDetailComponent | undefined;

	try {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui;
				const strip = new WhatsNewStripComponent(summaries, theme);
				strip.setInvalidationCallback(() => tui.requestRender());
				stripRef = strip;
				return strip;
			},
			{ placement: "belowEditor" },
		);
	} catch (err) {
		if (process.env.FORGE_DEBUG_WHATS_NEW === "1") {
			console.error("[forge-cli whats-new] setWidget failed:", err);
		}
		return;
	}

	const setFocusToMain = () => {
		stripRef?.setFocused(null);
		detailRef?.dispose?.();
		detailRef = undefined;
		ctx.ui.setOutputSource(null);
	};

	const commitFocus = () => {
		if (!stripRef) return;
		const summary = stripRef.cursorSummary();
		if (!summary) return;
		stripRef.setFocused(summary.component);
		const lines = renderComponentDetail(summary).split("\n");
		if (detailRef) {
			detailRef.updateLines(lines);
		} else {
			detailRef = new WhatsNewDetailComponent(lines);
			if (tuiRef) detailRef.setInvalidationCallback(() => tuiRef?.requestRender());
		}
		ctx.ui.setOutputSource(detailRef);
	};

	ctx.ui.onTerminalInput((data) => {
		if (!stripRef || !stripRef.hasContent()) return undefined;

		if (!stripRef.getStripActive()) {
			if (!isDownArrow(data)) return undefined;
			const editorText = ctx.ui.getEditorText();
			if (editorText.includes("\n")) return undefined;
			stripRef.setStripActive(true);
			return { consume: true };
		}

		if (isLeftArrow(data)) {
			stripRef.moveCursor(-1);
			return { consume: true };
		}
		if (isRightArrow(data)) {
			stripRef.moveCursor(1);
			return { consume: true };
		}
		if (isUpArrow(data)) {
			stripRef.setStripActive(false);
			return { consume: true };
		}
		if (isEnter(data)) {
			commitFocus();
			return { consume: true };
		}
		if (isEsc(data)) {
			stripRef.setStripActive(false);
			setFocusToMain();
			// Permanent dismiss: collapse prev baseline to seen so the strip
			// stops auto-mounting AND /whats-new returns empty.
			void dismissWhatsNew(rt)
				.catch(() => undefined)
				.then(() => stripRef?.clearSummaries());
			return { consume: true };
		}
		return undefined;
	});
}

/**
 * Compute the summaries that should populate the strip when /whats-new is
 * invoked: prev baseline first (post auto-dismiss), then lastShown frozen
 * baseline (post explicit dismiss). Returns empty when neither yields a
 * set — caller falls back to a notify message.
 */
async function computeReplaySummaries(rt: WhatsNewRuntime): Promise<ChangeSummary[]> {
	const cacheDir = rt.cacheDir ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "forgecli");
	const seen = await readSeenState(cacheDir);
	const sources = resolveChangelogPaths(rt.pkgRoot);
	let s = computeSummaries({ sources, current: rt.current, seen, baseline: "prev" });
	if (s.length === 0) s = computeSummaries({ sources, current: rt.current, seen, baseline: "lastShown" });
	return s;
}

/**
 * Register the /whats-new slash command: re-mounts the interactive strip
 * widget (same UI as the startup auto-mount). `/whats-new dismiss` clears
 * the replay baseline. Headless / non-TTY callers fall through to a text
 * notify so the command is still usable.
 */
export function registerWhatsNewWidgetCommand(pi: ExtensionAPI, rt: WhatsNewRuntime): void {
	pi.registerCommand("whats-new", {
		description: "Re-show the What's New strip (or /whats-new dismiss to clear)",
		async handler(args, ctx) {
			const arg = args.trim().toLowerCase();
			try {
				if (arg === "dismiss" || arg === "--dismiss") {
					await dismissWhatsNew(rt);
					ctx.ui.notify("whats-new: dismissed.", "info");
					return;
				}
				const summaries = await computeReplaySummaries(rt);
				if (summaries.length === 0) {
					ctx.ui.notify("What's New: no recent updates.", "info");
					return;
				}
				if (!ctx.hasUI) {
					// Headless / RPC mode — widget surface unavailable; dump text.
					const view = await computeWhatsNewView(rt, arg.length > 0 ? arg : null);
					ctx.ui.notify(view, "info");
					return;
				}
				// Echo the overall summary into the main chat container so
				// users have a record of the change counts, then mount the
				// strip below the editor for arrow-key drill-down.
				ctx.ui.notify(
					`${renderSummaryPanel(summaries)}\n\n(Use the strip below the editor: ↓ to activate, ←→ to navigate, Enter to expand.)`,
					"info",
				);
				mountStripWithSummaries(pi, ctx, rt, summaries);
			} catch (err) {
				if (process.env.FORGE_DEBUG_WHATS_NEW === "1") {
					console.error("[forge-cli whats-new] handler failed:", err);
				}
				ctx.ui.notify("whats-new: failed to render — set FORGE_DEBUG_WHATS_NEW=1 for details.", "warning");
			}
		},
	});
}
