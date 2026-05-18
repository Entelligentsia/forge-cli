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

export class ForgeInputRouter {
  private listeners: Entry[] = [];
  private overlayDepth = 0;

  register(listener: RouterListener, opts: RegisterOptions): () => void {
    const entry: Entry = { fn: listener, opts };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  pushOverlay(): void {
    this.overlayDepth++;
  }

  popOverlay(): void {
    if (this.overlayDepth > 0) this.overlayDepth--;
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
    let current = data;
    for (const entry of this.listeners) {
      if (this.overlayDepth > 0 && entry.opts.skipWhenOverlayActive) continue;
      const result = entry.fn(current);
      if (result?.consume) return { consume: true };
      if (result?.data !== undefined) current = result.data;
    }
    if (current !== data) return { data: current };
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
