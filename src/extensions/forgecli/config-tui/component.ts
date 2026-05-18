// Composite Component that drives the config TUI.
//
// Plan 16 Slice 4b. ctx.ui.custom() is the mount point; this module exports a
// factory that returns the Component. The component composes:
//   - state.ts reducer (single source of truth)
//   - screens.ts pure renderers (string[] output)
//   - a key-input dispatcher that maps keystrokes to actions
//   - config-writer.ts for atomic persistence on commit-persona-edit
//
// The component renders a modal frame (border top/bottom + background fill)
// around the screen content, giving the overlay visual weight and separation
// from whatever terminal content lies beneath it.

import * as fs from "node:fs";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { writeRoutingConfig } from "../config-writer.js";
import type { ConfigLayer } from "../config-writer.js";

type MenuViewKind = "top-menu" | "empty-state" | "no-project";

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
import {
  getActiveView,
  initialState,
  listPersonaPickerEntries,
  listPipelineOverrideSummaries,
  listResolvedPersonas,
  reducer,
  type AvailableModel,
  type ConfigTuiAction,
  type ConfigTuiState,
  type InitOptions,
  type View,
} from "./state.js";
import { CANONICAL_PHASES } from "./state/constants.js";
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
    const contentLines = renderActive(this.state, width, theme);

    // ── Modal frame ────────────────────────────────────────────────────
    // DynamicBorder top + background-fill on every content line + border bottom.
    // This gives the overlay a visual "panel" that sits on top of the terminal
    // rather than floating as raw text.

    const bgFn = (s: string) => theme.bg("selectedBg", s);
    const lines: string[] = [];

    // Top border
    lines.push(...new DynamicBorder((s) => theme.fg("borderAccent", s)).render(width));

    // Content: each line padded to full width so the background colour fills
    // the entire row.  visibleWidth correctly ignores ANSI codes added by theme.
    for (const line of contentLines) {
      const vis = visibleWidth(line);
      const padded = vis < width ? line + " ".repeat(width - vis) : line;
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

    const view = getActiveView(this.state);

    // Universal: q always requests quit
    if (matchesKey(data, "q")) {
      this.dispatch({ kind: "request-quit" });
      this.maybeExit();
      return;
    }

    // confirmQuit modal hijacks subsequent input
    if (this.state.confirmQuit) {
      if (matchesKey(data, "y") || matchesKey(data, Key.enter)) {
        this.dispatch({ kind: "confirm-quit", discard: true });
        this.maybeExit();
      } else if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
        this.dispatch({ kind: "confirm-quit", discard: false });
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
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

    if (view.kind === "persona-picker") {
      this.handlePersonaPickerInput(data, view);
      return;
    }

    if (view.kind === "persona-editor") {
      this.handlePersonaEditorInput(data, view);
      return;
    }

    if (view.kind === "show-resolved") {
      this.handleShowResolvedInput(data, view);
      return;
    }

    if (view.kind === "overrides-list-pipelines") {
      this.handleOverridesListPipelinesInput(data, view);
      return;
    }

    if (view.kind === "overrides-list-phases") {
      this.handleOverridesListPhasesInput(data, view);
      return;
    }

    if (view.kind === "override-editor") {
      this.handleOverrideEditorInput(data, view);
      return;
    }
  }

  private handleShowResolvedInput(
    data: string,
    _view: Extract<View, { kind: "show-resolved" }>,
  ): void {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.dispatch({ kind: "cursor-move", delta: -1 });
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.dispatch({ kind: "cursor-move", delta: 1 });
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
    const view = getActiveView(this.state);
    const isMenu =
      view.kind === "top-menu" || view.kind === "empty-state" || view.kind === "no-project";
    const itemCount = isMenu ? this.topLevelItemCount() : 0;

    // ↑/↓ on a menu moves the cursor between rows.
    if (isMenu && (matchesKey(data, Key.up) || matchesKey(data, "k"))) {
      this.dispatch({ kind: "cursor-move", delta: -1 });
      return;
    }
    if (isMenu && (matchesKey(data, Key.down) || matchesKey(data, "j"))) {
      const cursor = (view as { cursor: number }).cursor;
      if (cursor < itemCount - 1) this.dispatch({ kind: "cursor-move", delta: 1 });
      return;
    }

    // Enter fires the cursor row's action.
    if (matchesKey(data, Key.enter) && isMenu) {
      this.fireMenuItem(view.kind, (view as { cursor: number }).cursor);
      return;
    }

    // Number shortcuts — independent of cursor.
    if (matchesKey(data, "1")) {
      this.fireMenuItem(view.kind as MenuViewKind, 0);
      return;
    }
    if (matchesKey(data, "2")) {
      this.fireMenuItem(view.kind as MenuViewKind, 1);
      return;
    }
    if (matchesKey(data, "3")) {
      this.fireMenuItem(view.kind as MenuViewKind, 2);
      return;
    }
    // 'r' shortcut → show resolved (always works on top-level views).
    if (matchesKey(data, "r")) {
      this.dispatch({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
      return;
    }
  }

  private topLevelItemCount(): number {
    const view = getActiveView(this.state);
    if (view.kind === "no-project") return 2;
    if (view.kind === "empty-state" || this.state.isEmpty) return 2;
    if (view.kind === "top-menu") {
      // 1 Personas, 2 Overrides, 3 Show resolved, [4 Pipelines], 5 Plugin config
      return this.state.pipelineCatalogue ? 5 : 4;
    }
    return 0;
  }

  /**
   * Fire the action bound to a top-level menu row. Mirrors the visual
   * numbering in screens.ts (1-indexed there, 0-indexed here).
   */
  private fireMenuItem(viewKind: MenuViewKind, index: number): void {
    // isEmpty takes precedence — even in no-project mode, if there's nothing
    // to list yet, row 0 is "add a persona-model" (jump straight to editor).
    if (this.state.isEmpty) {
      if (index === 0) {
        this.dispatch({ kind: "push-view", view: { kind: "persona-picker", cursor: 0 } });
      } else if (index === 1) {
        this.dispatch({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
      }
      return;
    }
    if (viewKind === "no-project") {
      if (index === 0) {
        this.dispatch({ kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
      } else if (index === 1) {
        this.dispatch({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
      }
      return;
    }
    if (viewKind === "empty-state") {
      if (index === 0) {
        this.dispatch({ kind: "push-view", view: { kind: "persona-picker", cursor: 0 } });
      } else if (index === 1) {
        this.dispatch({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
      }
      return;
    }
    // top-menu (non-empty, has pipelines)
    if (index === 0) {
      this.dispatch({ kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    } else if (index === 1) {
      this.dispatch({
        kind: "push-view",
        view: { kind: "overrides-list-pipelines", cursor: 0 },
      });
    } else if (index === 2) {
      this.dispatch({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
    } else if (index === 3 && this.state.pipelineCatalogue) {
      // Pipelines (read-only catalogue display) — stub for now.
      this.opts.onError?.("Pipeline catalogue browser lands in a follow-up slice.");
    } else if ((index === 3 && !this.state.pipelineCatalogue) || index === 4) {
      // Plugin config (read-only) — stub for now (plugin-config-reader exists,
      // a screen for it lands in a follow-up).
      this.opts.onError?.("Plugin config view lands in a follow-up slice.");
    }
  }

  private handlePersonasListInput(
    data: string,
    view: Extract<View, { kind: "personas-list" }>,
  ): void {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.dispatch({ kind: "cursor-move", delta: -1 });
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      const max = Math.max(0, listResolvedPersonas(this.state).length - 1);
      const current = view.cursor;
      if (current < max) this.dispatch({ kind: "cursor-move", delta: 1 });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const personas = listResolvedPersonas(this.state);
      const target = personas[view.cursor];
      if (target) {
        this.dispatch({ kind: "begin-persona-edit", persona: target.persona });
      }
      return;
    }
    if (matchesKey(data, "n")) {
      this.dispatch({ kind: "push-view", view: { kind: "persona-picker", cursor: 0 } });
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

  private handlePersonaPickerInput(
    data: string,
    view: Extract<View, { kind: "persona-picker" }>,
  ): void {
    const entries = listPersonaPickerEntries(this.state);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.dispatch({ kind: "cursor-move", delta: -1 });
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < entries.length - 1) this.dispatch({ kind: "cursor-move", delta: 1 });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const target = entries[view.cursor];
      if (target) {
        // Pop the picker and push the editor in one render cycle.
        this.dispatch({ kind: "pop-view" });
        this.dispatch({ kind: "begin-persona-edit", persona: target.persona });
      }
      return;
    }
  }

  private handlePersonaEditorInput(
    data: string,
    view: Extract<View, { kind: "persona-editor" }>,
  ): void {
    if (view.step === "pick-provider") {
      const providers = this.uniqueProviders();
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.dispatch({ kind: "cursor-move", delta: -1 });
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (view.cursor < providers.length - 1) {
          this.dispatch({ kind: "cursor-move", delta: 1 });
        }
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const provider = providers[view.cursor];
        if (provider) this.dispatch({ kind: "set-persona-provider", provider });
        return;
      }
      // Quick single-letter shortcuts: a=anthropic, o=openai, g=google, l=ollama
      const shortcut = this.providerShortcut(data);
      if (shortcut) this.dispatch({ kind: "set-persona-provider", provider: shortcut });
      return;
    }

    if (view.step === "pick-model") {
      const models = this.state.availableModels.filter((m) => m.provider === view.provider);
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.dispatch({ kind: "cursor-move", delta: -1 });
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (view.cursor < models.length - 1) {
          this.dispatch({ kind: "cursor-move", delta: 1 });
        }
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const target = models[view.cursor];
        if (target) this.dispatch({ kind: "set-persona-model", model: target.id });
      }
      return;
    }

    if (view.step === "pick-layer") {
      // Cursor 0 = project, 1 = global (matches render order in screens.ts).
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.dispatch({ kind: "cursor-move", delta: -1 });
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (view.cursor < 1) this.dispatch({ kind: "cursor-move", delta: 1 });
        return;
      }
      if (matchesKey(data, "g")) {
        this.commitAndPersist("global");
        return;
      }
      if (matchesKey(data, "p")) {
        this.commitAndPersist("project");
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const layer: ConfigLayer = view.cursor === 0 ? "project" : "global";
        this.commitAndPersist(layer);
        return;
      }
    }
  }

  // ── Slice 4c — per-phase overrides handlers ─────────────────────────────────

  private handleOverridesListPipelinesInput(
    data: string,
    view: Extract<View, { kind: "overrides-list-pipelines" }>,
  ): void {
    const summaries = listPipelineOverrideSummaries(this.state);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.dispatch({ kind: "cursor-move", delta: -1 });
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < summaries.length - 1) this.dispatch({ kind: "cursor-move", delta: 1 });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const target = summaries[view.cursor];
      if (target) {
        this.dispatch({
          kind: "push-view",
          view: { kind: "overrides-list-phases", pipeline: target.pipeline, cursor: 0 },
        });
      }
    }
  }

  private handleOverridesListPhasesInput(
    data: string,
    view: Extract<View, { kind: "overrides-list-phases" }>,
  ): void {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.dispatch({ kind: "cursor-move", delta: -1 });
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < CANONICAL_PHASES.length - 1) {
        this.dispatch({ kind: "cursor-move", delta: 1 });
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const phase = CANONICAL_PHASES[view.cursor];
      if (phase) {
        this.dispatch({
          kind: "begin-override-edit",
          pipeline: view.pipeline,
          phaseRole: phase.role,
        });
      }
      return;
    }
    // space → clear override on current row (then persist)
    if (matchesKey(data, Key.space)) {
      const phase = CANONICAL_PHASES[view.cursor];
      if (phase) {
        this.dispatch({
          kind: "clear-phase-override",
          pipeline: view.pipeline,
          phaseRole: phase.role,
        });
        this.persistLayer("project");
      }
    }
  }

  private handleOverrideEditorInput(
    data: string,
    view: Extract<View, { kind: "override-editor" }>,
  ): void {
    if (view.step === "pick-type") {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.dispatch({ kind: "cursor-move", delta: -1 });
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (view.cursor < 2) this.dispatch({ kind: "cursor-move", delta: 1 });
        return;
      }
      const advance = (idx: number) => {
        if (idx === 0) {
          this.dispatch({ kind: "set-override-step", step: "pick-name" });
        } else if (idx === 1) {
          this.dispatch({ kind: "set-override-step", step: "pick-provider" });
        } else {
          this.dispatch({
            kind: "clear-phase-override",
            pipeline: view.pipeline,
            phaseRole: view.phaseRole,
          });
          this.persistLayer("project");
        }
      };
      if (matchesKey(data, Key.enter)) {
        advance(view.cursor);
        return;
      }
      if (matchesKey(data, "1")) return advance(0);
      if (matchesKey(data, "2")) return advance(1);
      if (matchesKey(data, "3")) return advance(2);
      return;
    }

    if (view.step === "pick-name") {
      const personas = listResolvedPersonas(this.state);
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.dispatch({ kind: "cursor-move", delta: -1 });
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (view.cursor < personas.length - 1) this.dispatch({ kind: "cursor-move", delta: 1 });
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const target = personas[view.cursor];
        if (target) {
          this.dispatch({ kind: "commit-override-name", name: target.persona });
          this.persistLayer("project");
        }
      }
      return;
    }

    if (view.step === "pick-provider") {
      const providers = this.uniqueProviders();
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.dispatch({ kind: "cursor-move", delta: -1 });
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (view.cursor < providers.length - 1) this.dispatch({ kind: "cursor-move", delta: 1 });
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const provider = providers[view.cursor];
        if (provider) this.dispatch({ kind: "set-override-provider", provider });
      }
      return;
    }

    if (view.step === "pick-model") {
      const models = this.state.availableModels.filter((m) => m.provider === view.provider);
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.dispatch({ kind: "cursor-move", delta: -1 });
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (view.cursor < models.length - 1) this.dispatch({ kind: "cursor-move", delta: 1 });
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const target = models[view.cursor];
        if (target && view.provider) {
          this.dispatch({
            kind: "commit-override-inline",
            provider: view.provider,
            model: target.id,
          });
          this.persistLayer("project");
        }
      }
      return;
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
      // Clear dirty flag + record last-saved path so the TUI can surface
      // confirmation in-overlay (ctx.ui.notify gets clipped by the modal).
      this.dispatch({ kind: "mark-clean", lastSaved: { target, layer } });
      this.scheduleClearStatus();
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
