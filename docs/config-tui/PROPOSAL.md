# Config-TUI Refactor Proposal

> **Updated** — incorporates review feedback (see §Hard Rules). Verified against the
> `phaseIndex → phaseRole` data-binding change; all references use `phaseRole: string`.

## Hard Rules (Non-Negotiable)

These come from code review and must be followed by the implementing agent:

1. **Keep `Focusable`**. It is not decorative — it is the mechanism by which pi routes
   arrow-key and escape input to overlay components. Commit 07e886f added it precisely
   because arrow keys were swallowed at the overlay layer without it. The `focused`
   property must stay on the component. (Reference: `oauth-selector.ts:23,177`.)

2. **No async-persistence overhaul**. Config files are <5 KB; `writeRoutingConfig` uses
   temp-file + rename (sub-millisecond). The existing synchronous pattern is correct.
   Do not add `persist-start` / `persist-complete` / `persist-error` actions, BorderedLoader
   spinners, or any other async-write machinery. Revisit only if profiling shows real lag.

3. **No render caching**. At this UI scale, render is cheap string concatenation. A cache
   that must be invalidated on every state change, theme change, and dispatch is a stale-UI
   bug waiting to happen. The `invalidate()` method body stays empty (`// Stateless
   renderer; no cache to drop.`). Defer caching until profiling justifies it.

4. **`maybePersist` layer derivation is explicit**. The `/* derive from action */` hand-wave
   is replaced by:
   ```
   commit-persona-edit   → layer = action.layer
   delete-persona-entry → layer = action.layer
   commit-override-name → always "project" (L4 lives on project only)
   commit-override-inline → always "project"
   clear-phase-override → always "project"
   ```
   If the implementing agent writes to the wrong layer, persona edits will silently go to
   the wrong file.

5. **Auto-clear `setTimeout` must guard against unmount**. The save-banner auto-clear
   fires `this.dispatch({ kind: "clear-status" })` after 3 seconds. If the user quits
   within that window, the callback dispatches against dead state. Fix:
   ```typescript
   private clearStatusTimer?: ReturnType<typeof setTimeout>;

   // After mark-clean dispatch:
   this.clearStatusTimer = setTimeout(() => {
     if (!this.state.shouldExit) {
       this.dispatch({ kind: "clear-status" });
     }
   }, 3000);

   // In the onExit path or dispose:
   if (this.clearStatusTimer) clearTimeout(this.clearStatusTimer);
   ```

## Investigation Gate

Before committing to the LOC estimate, the implementing agent must verify one thing:

6. **SelectList scroll hints**. The proposal assumes `SelectList` can replace hand-rolled
   list rendering in `personas-list`, `persona-picker`, and `show-resolved`. The current
   UI shows `"↑ N more above"` / `"↓ N more below"` scroll indicators outside the list
   items. Check that `SelectList` renders its scroll indicator (`scrollInfo` theme
   callback) in a visually equivalent position. If `SelectList` only shows a `(3/12)`
   counter, the agent should keep manual rendering for those screens and adjust the LOC
   estimate accordingly.

## Snapshot Test Churn Budget

Phase 3 (theming + `truncateToWidth`) will change rendering output. Switching from
`padRight` to `truncateToWidth` alters padding for any line previously over-padded.
This is **not** Phase 2 — it's Phase 3 work. The implementing agent must budget a
snapshot-update pass when theming lands, not claim "behavior unchanged."

---

## Problem

| Problem | Root cause | Impact |
|---------|-----------|--------|
| Single 644-line `component.ts` | All input handling in one file | Hard to navigate, easy to regress |
| Single 791-line `screens.ts` | All render functions in one file | No clear ownership per screen |
| No theming | `_theme` received but discarded | Monochrome wall-of-text UX |
| No component reuse | SelectList, SettingsList, DynamicBorder, Text all unused | ~400 lines of duplicated list/scroll logic |
| Width-unsafe rendering | `padRight()` uses `string.length`, no `truncateToWidth` | Breaks on narrow terminals + CJK |
| 500+ lines input handling | 8 handler methods in cascade | Adding a screen means editing 3 places |
| Fragile menu mapping | `fireMenuItem()` index → action | Adding/removing items breaks silently |
| Disk I/O in input handler | `persistLayer()` in `handleInput()` | Correct for <5 KB sync writes (see Hard Rule 2) |
| Save banner never clears | `clear-status` action defined but never dispatched | "✓ Saved" stays forever |
| `Focusable` kept but cursor-less | Arrow keys need it; no CURSOR_MARKER yet | Must stay (Hard Rule 1) |
| `uniqueProviders()` duplicated | Same function in screens.ts and component.ts | Drift risk |

## Design Principles

1. **One screen, one module** — each View variant lives in its own file
2. **Compose, don't build** — use pi-tui's `SelectList`, `Container`, `Text`, `DynamicBorder`, `Spacer` where they match; keep manual rendering only where they don't
3. **Theme everywhere** — every visible string goes through `theme.fg()`
4. **Width-safe by construction** — every line passes through `truncateToWidth()`
5. **No render cache** — per Hard Rule 3
6. **No async persistence** — per Hard Rule 2
7. **Data-driven menus** — items carry their own actions, no index mapping
8. **Keep `Focusable`** — per Hard Rule 1

## Target File Structure

```
config-tui/
├── index.ts                    # Public re-exports for handler.ts & config-command.ts
├── component.ts                # ~100 lines — thin orchestrator + Component & Focusable impl
├── theme.ts                    # ~50 lines — wraps pi-tui Theme for config-TUI specifics
├── keys.ts                     # ~30 lines — shared key-binding constants
│
├── state/
│   ├── model.ts                # ~90 lines — ConfigTuiState, View, Action type unions
│   ├── constants.ts            # ~25 lines — CANONICAL_PHASES (moved from screens.ts)
│   ├── init.ts                 # ~35 lines — initialState() constructor
│   ├── reducer.ts              # ~200 lines — pure reducer (slimmed, no buffer ops)
│   ├── selectors.ts            # ~90 lines — listResolvedPersonas, uniqueProviders, etc.
│   └── buffer.ts               # ~90 lines — writePersonaEntry, deletePersonaEntry, writePhaseOverride, clearPhaseOverride, cloneJSON
│                                  NOTE: writePhaseOverride/clearPhaseOverride now operate on
│                                  Record<string, PhaseConfig> (role-keyed), not PhaseConfig[]
│
├── screens/
│   ├── types.ts                # ~20 lines — Screen interface + InputResult
│   ├── shared.ts                # ~40 lines — windowList, breadcrumb, rule, formatOverride
│   ├── top-menu.ts             # ~120 lines — data-driven menu with actions
│   ├── personas-list.ts        # ~90 lines — list/delete/view personas
│   ├── persona-picker.ts       # ~70 lines — pick which persona to assign a model to
│   ├── persona-editor.ts       # ~150 lines — 3-step wizard (provider → model → layer)
│   ├── show-resolved.ts        # ~100 lines — resolved routing table (read-only)
│   ├── overrides-list.ts        # ~90 lines — per-pipeline override browser
│   ├── override-editor.ts       # ~130 lines — pick type → name|provider → model
│   └── confirm-quit.ts          # ~50 lines — modal confirmation dialog
│
├── handler.ts                   # ~150 lines — CLI arg parsing + model/auth discovery (slimmed)
└── plugin-config-reader.ts      # ~80 lines — unchanged
```

**File count**: 17 focused modules (up from 5 monoliths)
**Total estimated**: ~1,500 lines (down from 2,316) — note this may grow if SelectList scroll
hints don't match current UX and some screens keep manual rendering (Investigation Gate §6).
**Largest file**: ~200 lines (`reducer.ts`) vs current 791 (`screens.ts`)

## Architecture

### Screen Interface

Each screen module exports a class implementing `Screen`. The orchestrator delegates
`render` and `handleInput` to the active screen.

```typescript
// screens/types.ts

import type { ConfigTuiAction } from "../state/model.js";

export type InputResult =
  | { kind: "consumed" }                          // Key handled, re-render needed
  | { kind: "no-op" }                             // Key not relevant
  | { kind: "dispatch"; action: ConfigTuiAction } // Emit a state action
  | { kind: "pop" }                               // Navigate back
  | { kind: "quit" };                             // Request quit

export interface Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[];
  handleInput(data: string, state: ConfigTuiState): InputResult;
}
```

The `InputResult` discriminated union replaces void-returning, side-effecting handlers.
No more hidden `this.state` mutations inside `handleInput` sub-methods.

### Orchestrator (component.ts)

```typescript
export class ConfigTuiComponent implements Component, Focusable {
  private state: ConfigTuiState;
  private opts: ConfigTuiOptions;
  focused: boolean = false;  // Hard Rule 1: Keep this. Pi routes arrow/escape keys via Focusable.

  private clearStatusTimer?: ReturnType<typeof setTimeout>;  // Hard Rule 5

  invalidate(): void {
    // Hard Rule 3: No render cache. Body stays empty.
  }

  render(width: number): string[] {
    const screen = createScreen(getActiveView(this.state), this.opts.theme);
    return screen.render(this.state, width, this.opts.theme);
  }

  handleInput(data: string): void {
    if (this.state.shouldExit) return;

    const view = getActiveView(this.state);
    const screen = createScreen(view, this.opts.theme);
    const result: InputResult = this.state.confirmQuit
      ? confirmQuitInput(data, this.state)
      : screen.handleInput(data, this.state);

    switch (result.kind) {
      case "dispatch": this.dispatch(result.action); break;
      case "pop":      this.dispatch({ kind: "pop-view" }); break;
      case "quit":     this.dispatch({ kind: "request-quit" }); this.maybeExit(); break;
      case "consumed": this.opts.requestRender(); break;
      case "no-op":    break;
    }
  }

  private dispatch(action: ConfigTuiAction): void {
    this.state = reducer(this.state, action);
    this.opts.requestRender();
    this.maybePersist(action);
  }

  private maybePersist(action: ConfigTuiAction): void {
    // Hard Rule 4: Explicit layer derivation
    const layer = persistLayerForAction(action);
    if (!layer) return;
    try {
      const buffer = layer === "global" ? this.state.buffer.global : this.state.buffer.project;
      const target = writeRoutingConfig({ layer, cwd: this.state.cwd, buffer });
      this.dispatch({ kind: "mark-clean", lastSaved: { target, layer } });
      this.scheduleClearStatus();  // Hard Rule 5
      this.opts.onSaved?.(target);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  private scheduleClearStatus(): void {
    // Hard Rule 5: Guard against unmount
    if (this.clearStatusTimer) clearTimeout(this.clearStatusTimer);
    this.clearStatusTimer = setTimeout(() => {
      if (!this.state.shouldExit) {
        this.dispatch({ kind: "clear-status" });
      }
    }, 3000);
  }

  private maybeExit(): void {
    if (this.state.shouldExit) {
      if (this.clearStatusTimer) clearTimeout(this.clearStatusTimer);  // Hard Rule 5
      this.opts.onExit(0);
    }
  }
}

// Hard Rule 4: Explicit layer-to-action mapping
function persistLayerForAction(action: ConfigTuiAction): ConfigLayer | undefined {
  switch (action.kind) {
    case "commit-persona-edit":   return action.layer;
    case "delete-persona-entry":  return action.layer;
    case "commit-override-name":  return "project";  // L4 lives on project only
    case "commit-override-inline": return "project";  // L4 lives on project only
    case "clear-phase-override":  return "project";   // L4 lives on project only
    default: return undefined;
  }
}
```

Key changes from current:
- **Keep `Focusable`** (Hard Rule 1) — `focused: boolean = false` stays
- **No render cache** (Hard Rule 3) — `invalidate()` body stays empty
- **Sync persistence** (Hard Rule 2) — `writeRoutingConfig` stays in `handleInput`; no async overhaul
- **Explicit layer derivation** (Hard Rule 4) — `persistLayerForAction()` returns `ConfigLayer | undefined`
- **Auto-clear with unmount guard** (Hard Rule 5) — `clearTimeout` on exit, `shouldExit` guard in callback
- **Theme passed through** — every screen receives `Theme`

### Data-Driven Menu Items

```typescript
// screens/top-menu.ts

interface MenuItem {
  label: (state: ConfigTuiState, theme: Theme) => string;
  description?: (state: ConfigTuiState) => string;
  action: (state: ConfigTuiState) => ConfigTuiAction | null;  // null = stub
}

const TOP_MENU_ITEMS: MenuItem[] = [
  {
    label: (s, t) => `Personas ...`,
    action: () => ({ kind: "push-view", view: { kind: "personas-list", cursor: 0 } }),
  },
  // ...
];
```

Eliminates the fragile `fireMenuItem(index)` if-else chain. Adding a menu item = adding one
object to the array. The action is co-located with the label.

### Theming via `theme.ts`

```typescript
// theme.ts — thin helpers wrapping pi-tui Theme

export const configTheme = {
  rule: (width: number) => "─".repeat(Math.max(1, width)),
  authBadge: (ok: boolean, theme: Theme) => ok ? theme.fg("success", "✓") : theme.fg("error", "✗"),
  cursor: (isSelected: boolean, theme: Theme) => isSelected ? theme.fg("accent", "▸") : " ",
  truncate: (text: string, width: number) => truncateToWidth(text, width),
  // ...
};
```

### Width-Safe Rendering

Every screen's render method wraps with a final guarantee:

```typescript
render(state: ConfigTuiState, width: number, theme: Theme): string[] {
  // ... build lines ...
  return lines.map(line => truncateToWidth(line, width));
}
```

Replaces all uses of `padRight()`. Eliminates hardcoded column widths (56, 36, etc.)
overflowing on narrow terminals.

### Confirm-Quit Modal

Replace the 59-char hardcoded ASCII box with pi-tui `Container` + `DynamicBorder` +
`SelectList`. Adapts to terminal width automatically. (Code sketch in the original proposal
remains valid.)

### Save Banner Auto-Clear

After `mark-clean`, schedule a `clear-status` dispatch with a 3-second timer, guarded
against unmount (Hard Rule 5). See `scheduleClearStatus()` in the orchestrator sketch.

### State Module Split

Current `state.ts` (546 lines) splits into 6 focused files:

```
state/
├── model.ts       # 90 lines — types (View with persona-picker, Action with phaseRole, etc.)
├── constants.ts   # 25 lines — CANONICAL_PHASES (shared by selectors + screens)
├── init.ts        # 35 lines — initialState()
├── reducer.ts      # 200 lines — pure reducer
├── selectors.ts    # 90 lines — listResolvedPersonas, listPersonaPickerEntries, uniqueProviders, etc.
└── buffer.ts       # 90 lines — writePersonaEntry, deletePersonaEntry, writePhaseOverride, clearPhaseOverride, cloneJSON
```

**`phaseRole` compatibility**: `buffer.ts` works with `Record<string, PhaseConfig>` (role-keyed),
not arrays. Key assignment/deletion instead of array splicing — simpler.

### Handler Cleanup

1. **Surface auth failures** — `readAvailableModels()` should return an `authError?: string`
   so the top menu can display a diagnostic instead of a silent empty list.
2. **`edit-persona` / `edit-override` CLI stubs** — either wire them to navigate directly
   or remove them until implemented.

## Validation Against the `phaseRole` Migration

| What Changed | Impact on Proposal |
|---|---|
| `phaseIndex: number` → `phaseRole: string` | `model.ts` picks up automatically. Screen modules look up `CANONICAL_PHASES.find(p => p.role === phaseRole)`. |
| `PipelineConfig.phases`: `PhaseConfig[]` → `Record<string, PhaseConfig>` | `buffer.ts` simpler — key assignment, no array padding. |
| New `View.persona-picker` | Adds one screen module. Already in target file structure. |
| `listPersonaPickerEntries` selector | Fits naturally into `selectors.ts`. |
| `handlePersonaPickerInput` → 25 more lines in component.ts | Strengthens the refactor case. |

**Bottom line: the proposal is fully compatible. No structural changes needed.**

## Migration Plan

Three phases, each leaving the TUI working. Phase 4 from the original proposal is cut
per Hard Rule 2 (no async-persistence overhaul) and Hard Rule 3 (no render caching).

### Phase 1: Split files, no behavior change (est: 1 day)

1. Extract `state/model.ts`, `state/init.ts`, `state/reducer.ts`, `state/selectors.ts`,
   `state/buffer.ts`, `state/constants.ts` from `state.ts`
2. Extract `screens/shared.ts` (windowList, breadcrumb, rule) from `screens.ts`
3. Add `index.ts` barrel files re-exporting everything
4. Update all imports
5. Run existing tests — all green, no behavior change

### Phase 2: Introduce Screen interface, extract screens (est: 1 day)

1. Create `screens/types.ts` with `Screen` and `InputResult`
2. Extract each render function into its own `screens/*.ts` module as a `Screen` class
3. Create `component.ts` orchestrator that delegates to active screen
4. Each screen's `handleInput` returns `InputResult` instead of calling `this.dispatch`
5. Wire up in the orchestrator
6. Run tests — behavior unchanged, but now modular

### Phase 3: Theming + pi-tui components + width safety + polish (est: 2 days)

1. Pass `theme` through from `config-command.ts` into the component
2. Create `theme.ts` helper module
3. Replace render functions with pi-tui composition (`SelectList`, `Container`, `Text`,
   `DynamicBorder`) **where they match the UX** (Investigation Gate §6)
4. Add `truncateToWidth` width-safety to every render output
5. Data-driven menu items (eliminate `fireMenuItem()`)
6. Auto-clear `lastSaved` banner (3-second `setTimeout` with unmount guard — Hard Rule 5)
7. Surface `authError` in top-menu when model discovery fails
8. **Snapshot test update pass** — this is where rendering changes, not Phase 2
9. New tests for width safety and input routing

## Summary of Changes

| Metric | Before | After |
|--------|--------|-------|
| Files | 5 | 17 |
| Largest file | 791 lines (`screens.ts`) | ~200 lines (`reducer.ts`) |
| Total lines | 2,316 | ~1,500 (±Investigation Gate §6) |
| Input handling | 500+ lines (8 methods, cascade) | ~15 lines (delegates to screen) |
| Rendering | Plain text, no colors | Themed with pi-tui components |
| Width safety | `padRight()` (broken) | `truncateToWidth()` (correct) |
| Component reuse | 0 built-in components | SelectList, Text, Container, DynamicBorder, Spacer (where UX matches) |
| Render caching | None | None (Hard Rule 3) |
| Menu items | Index-mapped (fragile) | Data-driven with `action` field |
| Disk I/O | Synchronous (correct) | Synchronous (stays — Hard Rule 2) |
| Save banner | Never clears | Auto-clears after 3s (with unmount guard — Hard Rule 5) |
| Auth failures | Silent empty list | Surfaces diagnostic message |
| Focusable | Present (dead) | Present (required — Hard Rule 1) |
| Phase indexing | `phaseRole: string` | `phaseRole: string` (already migrated) |