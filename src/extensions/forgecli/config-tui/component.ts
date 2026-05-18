// Composite Component that drives the config TUI.
//
// Phase 2: thin orchestrator that delegates render and handleInput to the
// active Screen implementation. The Component & Focusable impl stays here;
// per-view logic moved into screens/*.ts modules.
//
// The component composes:
//   - state/ reducer (single source of truth)
//   - screens/* renderers + input handlers (delegated via Screen interface)
//   - config-writer.ts for atomic persistence on commit-persona-edit

import * as fs from "node:fs";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ConfigLayer } from "../config-writer.js";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { writeRoutingConfig } from "../config-writer.js";
import {
  getActiveView,
  initialState,
  reducer,
  type AvailableModel,
  type ConfigTuiAction,
  type ConfigTuiState,
  type InitOptions,
  type View,
} from "./state.js";
import { CANONICAL_PHASES } from "./state/constants.js";

import { AdvancedMenuScreen } from "./screens/advanced-menu.js";
import { TierMenuScreen } from "./screens/tier-menu.js";
import { TierPickerScreen } from "./screens/tier-picker.js";
import { ConfirmQuitScreen, renderSaveBanner } from "./screens/confirm-quit.js";
import { PersonasListScreen } from "./screens/personas-list.js";
import { PersonaPickerScreen } from "./screens/persona-picker.js";
import { PersonaEditorScreen } from "./screens/persona-editor.js";
import { ShowResolvedScreen } from "./screens/show-resolved.js";
import { OverridesListPipelinesScreen } from "./screens/overrides-list.js";
import { OverridesListPhasesScreen } from "./screens/overrides-list-phases.js";
import { OverrideEditorScreen } from "./screens/override-editor.js";
import type { InputResult, Screen } from "./screens/types.js";

function debugLog(line: string): void {
  if (process.env.FORGE_DEBUG_INPUT !== "1") return;
  try {
    const ts = new Date().toISOString();
    const path = process.env.FORGE_DEBUG_INPUT_LOG ?? "/tmp/forge-input-router.log";
    fs.appendFileSync(path, `${ts} [config-tui] ${line}\n`);
  } catch {
    /* swallow */
  }
}

function hexEscape(s: string): string {
  return [...s]
    .map((c) => {
      const cp = c.codePointAt(0)!;
      if (cp >= 0x20 && cp <= 0x7e) return c;
      return `\\x${cp.toString(16).padStart(2, "0")}`;
    })
    .join("");
}

// ── Screen factory ──────────────────────────────────────────────────────────

const SCREEN_INSTANCES: Record<string, Screen> = {
  "confirm-quit": new ConfirmQuitScreen(),
  "tier-menu": new TierMenuScreen(),
  "tier-picker": new TierPickerScreen(),
  "advanced-menu": new AdvancedMenuScreen(),
  "personas-list": new PersonasListScreen(),
  "persona-picker": new PersonaPickerScreen(),
  "persona-editor": new PersonaEditorScreen(),
  "show-resolved": new ShowResolvedScreen(),
  "overrides-list-pipelines": new OverridesListPipelinesScreen(),
  "overrides-list-phases": new OverridesListPhasesScreen(),
  "override-editor": new OverrideEditorScreen(),
};

function createScreen(view: View): Screen {
  return SCREEN_INSTANCES[view.kind] ?? SCREEN_INSTANCES["tier-menu"];
}

// ── Hard Rule 4: Explicit layer-to-action mapping ──────────────────────────

function persistLayerForAction(action: ConfigTuiAction): ConfigLayer | undefined {
  switch (action.kind) {
    case "commit-tier-model":     return action.layer;
    case "commit-persona-edit":    return action.layer;
    case "delete-persona-entry":  return action.layer;
    case "commit-override-name":   return "project";  // L4 lives on project only
    case "commit-override-inline": return "project";    // L4 lives on project only
    case "clear-phase-override":   return "project";   // L4 lives on project only
    default: return undefined;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export interface ConfigTuiComponentOptions extends InitOptions {
  /** Called by the component when the user has quit (with discard or via clean exit). */
  onExit: (exitCode: number) => void;
  /** Called when a write to disk completes successfully — surfaces "saved to X". */
  onSaved?: (target: string) => void;
  /** Called on write failure — surfaces the error to the parent ctx. */
  onError?: (message: string) => void;
  /** Optional invalidate hook supplied by the TUI driver (forces re-render). */
  requestRender?: () => void;
  /** pi TUI theme — drives all colour choices inside the overlay. */
  theme: Theme;
}

export class ConfigTuiComponent implements Component, Focusable {
  private state: ConfigTuiState;
  private readonly opts: ConfigTuiComponentOptions;

  /** Focusable — pi sets this to true when the overlay has keyboard focus.
   *  Without this, arrow keys don't route to handleInput (see commit 07e886f). */
  focused: boolean = false;

  /** Timer handle for the auto-clearing save banner (guards against unmount). */
  private clearStatusTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: ConfigTuiComponentOptions) {
    this.opts = opts;
    this.state = initialState(opts);
  }

  invalidate(): void {
    // Stateless renderer; no cache to drop. (Hard Rule 3: no render caching.)
  }

  render(width: number): string[] {
    const theme = this.opts.theme;
    const view = getActiveView(this.state);

    // Delegate rendering to the active screen (or confirm-quit overlay).
    let contentLines: string[];
    if (this.state.confirmQuit) {
      // show the underlying screen plus the confirm-quit overlay
      const screen = createScreen(view);
      const baseLines = screen.render(this.state, width, theme);
      const quitLines = SCREEN_INSTANCES["confirm-quit"].render(this.state, width, theme);
      contentLines = [...baseLines, ...renderSaveBanner(this.state, width, theme), ...quitLines];
    } else {
      const screen = createScreen(view);
      contentLines = [
        ...screen.render(this.state, width, theme),
        ...renderSaveBanner(this.state, width, theme),
      ];
    }

    // ── Modal frame ────────────────────────────────────────────────────
    const bgFn = (s: string) => theme.bg("selectedBg", s);
    const lines: string[] = [];

    // Top border
    lines.push(...new DynamicBorder((s) => theme.fg("borderAccent", s)).render(width));

    // Content: each line padded to full width so the background colour fills
    // the entire row.  visibleWidth correctly ignores ANSI codes added by theme.
    // truncateToWidth ensures no line exceeds the terminal width.
    for (const line of contentLines) {
      const truncated = truncateToWidth(line, width, "");
      const vis = visibleWidth(truncated);
      const padded = vis < width ? truncated + " ".repeat(width - vis) : truncated;
      lines.push(bgFn(padded));
    }

    // Bottom border
    lines.push(...new DynamicBorder((s) => theme.fg("borderAccent", s)).render(width));

    return lines;
  }

  handleInput(data: string): void {
    debugLog(`handleInput IN data="${hexEscape(data)}" focused=${this.focused} view=${getActiveView(this.state).kind}`);
    if (this.state.shouldExit) {
      debugLog(`handleInput RETURN (shouldExit)`);
      return;
    }

    // Universal: q always requests quit
    if (matchesKey(data, "q")) {
      this.dispatch({ kind: "request-quit" });
      this.maybeExit();
      return;
    }

    // confirmQuit modal hijacks subsequent input
    if (this.state.confirmQuit) {
      const result = SCREEN_INSTANCES["confirm-quit"].handleInput(data, this.state);
      this.handleResult(result);
      // After confirm-quit, check if we should exit
      this.maybeExit();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.dispatch({ kind: "pop-view" });
      return;
    }

    // Delegate to the active screen's handleInput
    const view = getActiveView(this.state);
    const screen = createScreen(view);
    const result = screen.handleInput(data, this.state);
    this.handleResult(result);
  }

  // ── Result dispatcher ─────────────────────────────────────────────────────

  private handleResult(result: InputResult): void {
    switch (result.kind) {
      case "dispatch":
        this.dispatch(result.action);
        this.maybePersist(result.action);
        break;
      case "dispatch-seq":
        for (const action of result.actions) {
          this.dispatch(action);
        }
        // Persist the last action (the one that triggers the write)
        if (result.actions.length > 0) {
          this.maybePersist(result.actions[result.actions.length - 1]);
        }
        break;
      case "pop":
        this.dispatch({ kind: "pop-view" });
        break;
      case "quit":
        this.dispatch({ kind: "request-quit" });
        this.maybeExit();
        break;
      case "error":
        this.opts.onError?.(result.message);
        this.opts.requestRender?.();
        break;
      case "consumed":
        this.opts.requestRender?.();
        break;
      case "no-op":
        break;
    }
  }

  // ── Dispatcher helpers ────────────────────────────────────────────────────

  private dispatch(action: ConfigTuiAction): void {
    this.state = reducer(this.state, action);
    this.opts.requestRender?.();
  }

  private maybeExit(): void {
    if (this.state.shouldExit) {
      if (this.clearStatusTimer) clearTimeout(this.clearStatusTimer);  // Hard Rule 5
      this.opts.onExit(0);
    }
  }

  private maybePersist(action: ConfigTuiAction): void {
    const layer = persistLayerForAction(action);
    if (!layer) return;
    try {
      const buffer = layer === "global" ? this.state.buffer.global : this.state.buffer.project;
      const target = writeRoutingConfig({ layer, cwd: this.state.cwd, buffer });
      this.dispatch({ kind: "mark-clean", lastSaved: { target, layer } });
      this.scheduleClearStatus();  // Hard Rule 5
      this.opts.onSaved?.(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError?.(msg);
    }
  }

  /** Schedule save-banner auto-clear.  Guards against unmount (Hard Rule 5). */
  private scheduleClearStatus(): void {
    if (this.clearStatusTimer) clearTimeout(this.clearStatusTimer);
    this.clearStatusTimer = setTimeout(() => {
      if (!this.state.shouldExit) {
        this.dispatch({ kind: "clear-status" });
      }
    }, 3000);
  }
}

export function createConfigTuiComponent(opts: ConfigTuiComponentOptions): ConfigTuiComponent {
  return new ConfigTuiComponent(opts);
}