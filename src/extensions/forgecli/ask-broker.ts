// ask-broker.ts — bridges a subagent's forge_ask_user call to the
// orchestrator's TUI.
//
// THE PROBLEM (verified against pi runtime):
//   A subagent spawned via runForgeSubagent uses createAgentSession, which has
//   NO seam to attach a UI (CreateAgentSessionOptions has no ui field). Its
//   ExtensionRunner.uiContext stays noOpUIContext, so ctx.hasUI === false and
//   ctx.ui.* are no-ops. When the subagent's own LLM calls forge_ask_user, the
//   visible TUI cannot help it — that TUI is bound to a DIFFERENT session (the
//   orchestrator). See runner.ts hasUI(), sdk.ts CreateAgentSessionOptions.
//
// THE BRIDGE:
//   The orchestrator runs in-process with its subagents (createAgentSession is
//   in-process; pi serialises turns on one event loop). So a process-global
//   singleton holding the orchestrator's live ctx.ui is enough — no IPC. The
//   orchestrator binds its UI for the duration of subagent dispatch
//   (AskBroker.withUI). When a subagent's forge_ask_user finds ctx.hasUI ===
//   false but the broker bound, it routes the request here; we render on the
//   orchestrator's real UI and return the answer. The subagent's tool-call
//   await holds the subagent turn paused; the orchestrator's await on
//   runForgeSubagent does NOT block the event loop, so the dialog renders and
//   resolves normally.
//
// SERIALISATION:
//   Parallel fan-out (e.g. init's discovery agents) can have multiple
//   subagents call forge_ask_user concurrently, but a single terminal can show
//   only one overlay at a time. ask() chains every request onto a tail promise
//   so prompts render strictly one-at-a-time; later askers wait their turn with
//   their subagent turn paused. This trades parallelism for correctness while a
//   human is being asked — acceptable, and the reason init should still prefer
//   collecting answers up-front (questions that CAN be hoisted, should be).
//
// REFCOUNTED BINDING:
//   Under parallel dispatch several withUI() scopes overlap. They all bind the
//   same process UI, so a simple save/restore would let the first scope to exit
//   clear the binding while siblings are still running. A depth counter keeps
//   the UI bound until the LAST overlapping scope exits.
//
// Iron Law 7: ask() throws (never silently defaults) when called with no UI
// bound — that is a wiring bug in the orchestrator, and must surface loudly.

import { type AskRender, type AskUI, type AskUserRequest, renderAskPrompt } from "./ask-user-render.js";

let boundUI: AskUI | null = null;
let bindDepth = 0;
// Serialisation chain: every ask() renders only after the previous one settles.
let tail: Promise<unknown> = Promise.resolve();

/**
 * An overlay-owned renderer for a pending ask (Plan 16 Slice 3). While a
 * full-terminal `ctx.ui.custom` overlay (the dashboard) is mounted, pi renders
 * the editor-slot `ctx.ui.select/confirm/input` dialogs BENEATH the overlay —
 * invisible and unfocused. So when such an overlay is active it registers a
 * renderer here; ask() routes to it instead of `renderAskPrompt`, and the
 * overlay paints the prompt in its own layer where the user can actually see
 * and answer it. Cleared on overlay dispose → asks fall back to the editor slot.
 */
export type OverlayAskRenderer = (req: AskUserRequest, signal?: AbortSignal) => Promise<AskRender>;

let overlayRenderer: OverlayAskRenderer | null = null;

export const AskBroker = {
	/** True when an orchestrator UI is currently bound. */
	isBound(): boolean {
		return boundUI !== null;
	},

	/**
	 * Register (or clear, with null) the overlay-owned ask renderer. Called by a
	 * full-terminal overlay on mount/dispose. Last registration wins; only one
	 * overlay is ever mounted at a time in practice.
	 */
	setOverlayRenderer(renderer: OverlayAskRenderer | null): void {
		overlayRenderer = renderer;
	},

	/** True when an overlay has registered itself to render pending asks. */
	hasOverlayRenderer(): boolean {
		return overlayRenderer !== null;
	},

	/**
	 * Bind the orchestrator's live UI. Refcounted — call once per overlapping
	 * dispatch scope and pair every bind() with exactly one unbind(). Prefer
	 * withUI() for RAII safety.
	 */
	bind(ui: AskUI): void {
		boundUI = ui;
		bindDepth += 1;
	},

	/** Release one binding. The UI stays bound until the last overlapping scope releases. */
	unbind(): void {
		bindDepth = Math.max(0, bindDepth - 1);
		if (bindDepth === 0) boundUI = null;
	},

	/**
	 * Bind `ui` for the duration of `fn`, releasing on return or throw. Safe to
	 * nest and to overlap (parallel fan-out) because binding is refcounted.
	 */
	async withUI<T>(ui: AskUI, fn: () => Promise<T>): Promise<T> {
		AskBroker.bind(ui);
		try {
			return await fn();
		} finally {
			AskBroker.unbind();
		}
	},

	/**
	 * Marshal an ask request to the bound orchestrator UI. Serialised against
	 * all other in-flight asks so only one dialog renders at a time. Throws if
	 * no UI is bound.
	 */
	async ask(req: AskUserRequest, signal?: AbortSignal): Promise<AskRender> {
		if (!boundUI && !overlayRenderer) {
			throw new Error(
				"AskBroker.ask called with no orchestrator UI bound and no overlay renderer — a subagent tried " +
					"to reach the user but the orchestrator did not wrap its subagent dispatch in " +
					"AskBroker.withUI(ctx.ui, ...) and no overlay registered a renderer.",
			);
		}
		// Choose the renderer at run-time (inside the tail), not now: a dashboard
		// overlay may mount/dispose between enqueue and execution, and the ask
		// should render wherever the user actually is when its turn arrives. An
		// active overlay wins (editor-slot dialogs render beneath it); otherwise
		// the bound orchestrator UI renders in the editor slot.
		const doRender = (): Promise<AskRender> =>
			overlayRenderer ? overlayRenderer(req, signal) : renderAskPrompt(boundUI!, req, signal);
		// Chain onto the tail so overlays never overlap. `.catch(() => {})` keeps
		// the chain alive after a rejected/cancelled prior ask.
		const run = tail.catch(() => {}).then(doRender);
		tail = run.catch(() => {});
		return run;
	},

	/** Test-only: reset module state between cases. */
	_resetForTest(): void {
		boundUI = null;
		bindDepth = 0;
		tail = Promise.resolve();
		overlayRenderer = null;
	},
};
