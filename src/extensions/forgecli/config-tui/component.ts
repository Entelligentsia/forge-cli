// Composite Component that drives the config TUI.
//
// Plan 16 Slice 4b. ctx.ui.custom() is the mount point; this module exports a
// factory that returns the Component. The component composes:
//   - state.ts reducer (single source of truth)
//   - screens.ts pure renderers (string[] output)
//   - a key-input dispatcher that maps keystrokes to actions
//   - config-writer.ts for atomic persistence on commit-persona-edit
//
// Rendering is intentionally render-to-string: the test surface (screens tests)
// matches what the user sees character-for-character, modulo styling.

import { matchesKey } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { writeRoutingConfig } from "../config-writer.js";
import type { ConfigLayer } from "../config-writer.js";
import {
  getActiveView,
  initialState,
  listResolvedPersonas,
  reducer,
  type AvailableModel,
  type ConfigTuiAction,
  type ConfigTuiState,
  type InitOptions,
  type View,
} from "./state.js";
import { renderActive } from "./screens.js";

export interface ConfigTuiComponentOptions extends InitOptions {
  /** Called by the component when the user has quit (with discard or via clean exit). */
  onExit: (exitCode: number) => void;
  /** Called when a write to disk completes successfully — surfaces "saved to X". */
  onSaved?: (target: string) => void;
  /** Called on write failure — surfaces the error to the parent ctx. */
  onError?: (message: string) => void;
  /** Optional invalidate hook supplied by the TUI driver (forces re-render). */
  requestRender?: () => void;
}

export class ConfigTuiComponent implements Component {
  private state: ConfigTuiState;
  private readonly opts: ConfigTuiComponentOptions;

  constructor(opts: ConfigTuiComponentOptions) {
    this.opts = opts;
    this.state = initialState(opts);
  }

  invalidate(): void {
    // Stateless renderer; no cache to drop.
  }

  render(width: number): string[] {
    return renderActive(this.state, width);
  }

  handleInput(data: string): void {
    if (this.state.shouldExit) return;

    const view = getActiveView(this.state);

    // Universal: q always requests quit
    if (matchesKey(data, "q")) {
      this.dispatch({ kind: "request-quit" });
      this.maybeExit();
      return;
    }

    // confirmQuit modal hijacks subsequent input
    if (this.state.confirmQuit) {
      if (matchesKey(data, "y") || matchesKey(data, "enter")) {
        this.dispatch({ kind: "confirm-quit", discard: true });
        this.maybeExit();
      } else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
        this.dispatch({ kind: "confirm-quit", discard: false });
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.dispatch({ kind: "pop-view" });
      return;
    }

    if (view.kind === "top-menu" || view.kind === "empty-state" || view.kind === "no-project") {
      this.handleTopLevelInput(data);
      return;
    }

    if (view.kind === "personas-list") {
      this.handlePersonasListInput(data, view);
      return;
    }

    if (view.kind === "persona-editor") {
      this.handlePersonaEditorInput(data, view);
      return;
    }
  }

  // ── Dispatcher helpers ──────────────────────────────────────────────────────

  private dispatch(action: ConfigTuiAction): void {
    this.state = reducer(this.state, action);
    this.opts.requestRender?.();
  }

  private maybeExit(): void {
    if (this.state.shouldExit) this.opts.onExit(0);
  }

  // ── Per-view input handlers ─────────────────────────────────────────────────

  private handleTopLevelInput(data: string): void {
    // 1 → Personas (or "Add a persona-model assignment" on empty state)
    if (matchesKey(data, "1") || matchesKey(data, "enter")) {
      if (this.state.isEmpty) {
        // Open editor with a persona prompt — for slice 4b we jump straight to
        // the "default" persona. 4c can add a chooser screen.
        this.dispatch({ kind: "begin-persona-edit", persona: "default" });
      } else {
        this.dispatch({ kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
      }
      return;
    }
  }

  private handlePersonasListInput(
    data: string,
    view: Extract<View, { kind: "personas-list" }>,
  ): void {
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.dispatch({ kind: "cursor-move", delta: -1 });
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      const max = Math.max(0, listResolvedPersonas(this.state).length - 1);
      const current = view.cursor;
      if (current < max) this.dispatch({ kind: "cursor-move", delta: 1 });
      return;
    }
    if (matchesKey(data, "enter")) {
      const personas = listResolvedPersonas(this.state);
      const target = personas[view.cursor];
      if (target) {
        this.dispatch({ kind: "begin-persona-edit", persona: target.persona });
      }
      return;
    }
    if (matchesKey(data, "n")) {
      // For slice 4b: jump to a fresh editor for "default" (4c adds a name picker).
      this.dispatch({ kind: "begin-persona-edit", persona: "default" });
      return;
    }
    if (matchesKey(data, "d")) {
      const personas = listResolvedPersonas(this.state);
      const target = personas[view.cursor];
      if (target) {
        // Best-effort: delete from whichever layer claims the entry.
        const layer: ConfigLayer = target.source.endsWith("L2") ? "project" : "global";
        this.dispatch({ kind: "delete-persona-entry", layer, persona: target.persona });
        // Persist immediately — d is a destructive action with one undo (n/edit).
        this.persistLayer(layer);
      }
      return;
    }
  }

  private handlePersonaEditorInput(
    data: string,
    view: Extract<View, { kind: "persona-editor" }>,
  ): void {
    if (view.step === "pick-provider") {
      // For slice 4b: a single-keystroke advance using the first authenticated provider.
      // The picker UI is rendered (screens.ts) but we don't yet have a list-cursor for
      // it — 4c will introduce one. For now, enter picks the first row.
      if (matchesKey(data, "enter")) {
        const provider = this.uniqueProviders()[0];
        if (provider) this.dispatch({ kind: "set-persona-provider", provider });
      }
      // Quick single-letter shortcuts: a=anthropic, o=openai, g=google, l=ollama
      const shortcut = this.providerShortcut(data);
      if (shortcut) this.dispatch({ kind: "set-persona-provider", provider: shortcut });
      return;
    }

    if (view.step === "pick-model") {
      if (matchesKey(data, "enter")) {
        const models = this.state.availableModels.filter((m) => m.provider === view.provider);
        const first = models[0];
        if (first) this.dispatch({ kind: "set-persona-model", model: first.id });
      }
      return;
    }

    if (view.step === "pick-layer") {
      if (matchesKey(data, "g")) {
        this.commitAndPersist("global");
        return;
      }
      if (matchesKey(data, "p") || matchesKey(data, "enter")) {
        this.commitAndPersist("project");
        return;
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private uniqueProviders(): string[] {
    const providers = new Set<string>();
    for (const m of this.state.availableModels) providers.add(m.provider);
    for (const p of this.state.authenticatedProviders) providers.add(p);
    return [...providers].sort();
  }

  private providerShortcut(data: string): string | null {
    const pairs: Array<[Parameters<typeof matchesKey>[1], string]> = [
      ["a", "anthropic"],
      ["o", "openai"],
      ["g", "google"],
      ["l", "ollama"],
      ["r", "openrouter"],
    ];
    for (const [key, provider] of pairs) {
      if (matchesKey(data, key) && this.uniqueProviders().includes(provider)) {
        return provider;
      }
    }
    return null;
  }

  private commitAndPersist(layer: ConfigLayer): void {
    this.dispatch({ kind: "commit-persona-edit", layer });
    this.persistLayer(layer);
  }

  private persistLayer(layer: ConfigLayer): void {
    try {
      const buffer = layer === "global" ? this.state.buffer.global : this.state.buffer.project;
      const target = writeRoutingConfig({
        layer,
        cwd: this.state.cwd,
        buffer,
      });
      this.opts.onSaved?.(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError?.(msg);
    }
  }
}

export function createConfigTuiComponent(opts: ConfigTuiComponentOptions): ConfigTuiComponent {
  return new ConfigTuiComponent(opts);
}
