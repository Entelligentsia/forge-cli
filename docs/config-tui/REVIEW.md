# Config-TUI Code Review

> **Reviewer**: pi-tui architecture review  
> **Scope**: `src/extensions/forgecli/config-tui/` — component.ts, screens.ts, state.ts, handler.ts, plugin-config-reader.ts  
> **Reference**: `pi-mono/packages/coding-agent/docs/tui.md` and pi-tui source

---

## Executive Summary

The config-tui is a functional, multi-screen TUI for managing Forge routing configuration. It implements a clean **state-reducer-render** architecture that separates concerns well and achieves good testability on the rendering path. However, it essentially **ignores the pi-tui component framework**: it renders plain-text lines instead of using `Container`, `Text`, `Box`, `SelectList`, `DynamicBorder`, or theming. The result works but is visually flat, width-unsafe, non-accessible, and misses the composability that pi-tui provides. Below is a detailed breakdown.

---

## The Good

### 1. Clean State / Reducer / Renderer Separation
`state.ts` houses a single `ConfigTuiState` with a proper Elm-style reducer. Views are pushed/popped from a `View[]` stack, and every user action maps to a typed `ConfigTuiAction`. This is exactly right: immutable state transitions, single source of truth, and trivially testable.

```typescript
export function reducer(state: ConfigTuiState, action: ConfigTuiAction): ConfigTuiState {
  // ...
}
```

### 2. Pure Render-to-String Functions
`screens.ts` exports pure `(state, width) => string[]` functions. These are directly unit-testable character-by-character (as the test file demonstrates). No side effects, no DOM, no terminal dependencies. This is a genuinely good pattern for testability.

### 3. Proper Test Coverage for Screen Rendering
`config-tui-screens.test.ts` exercises every screen renderer through state transitions. Tests walk the reducer, then assert on rendered output. This is a real strength.

### 4. Correct Overlay Lifecycle Management
`config-command.ts` correctly uses `ctx.ui.custom()` with `{ overlay: true }`, wraps the exit callback via `done()`, and properly uses `try/finally` to push/pop the input router overlay:

```typescript
const exitCode = await ctx.ui.custom<number>((tui, _theme, _kb, done) => {
  const component = createConfigTuiComponent({
    ...init,
    onExit: (code) => done(code),
    ...
    requestRender: () => tui.requestRender(),
  });
  return component;
}, { overlay: true });
```

### 5. Windowed Scrolling for Long Lists
The `windowList()` utility in screens.ts handles virtual scrolling with above/below counts and scroll indicators. This is essential for lists that overflow terminal height.

### 6. Exhaustive Union Checking
`renderActive()` has a `default: { const _exhaustive: never = view; }` branch, which means adding a new View variant without updating the router is a compile-time error. Good discipline.

### 7. Side Effects Segregated from Reducer
The reducer in `state.ts` is pure I/O-free. All disk writes (`writeRoutingConfig`) live in `component.ts`'s `persistLayer()`. This makes the state layer trivially testable.

### 8. Breadcrumb Navigation
Each screen renders a breadcrumb (`forge config › personas › pick which`), giving the user clear positional context. Simple and effective.

### 9. Input Debugging Harness
The `debugLog` / `hexEscape` helpers in component.ts, gated on `FORGE_DEBUG_INPUT`, are useful for debugging key event issues without polluting production output.

---

## The Bad

### 1. **No Theming — Everything is Plain Text**

The entire TUI renders uncolored, unbordered plain text. The pi-tui docs explicitly state: *"Always use theme from the callback — Don't import theme directly. Use theme from the `ctx.ui.custom((tui, theme, keybindings, done) => ...)` callback."*

The `config-command.ts` factory function receives `_theme` but discards it:
```typescript
const exitCode = await ctx.ui.custom<number>((tui, _theme, _kb, done) => { ... });
```

The component renders no colors — no `theme.fg("accent", ...)`, no `theme.bg("selectedBg", ...)`, no `DynamicBorder`. The result is a wall of monochrome text that's hard to scan. Every other pi-tui overlay in the codebase uses theming.

**Fix**: Pass theme into the component and use it in render functions. The `renderActive` entry point should accept a theme object and thread it through every screen.

### 2. **No Use of Built-in Components**

The pi-tui docs say: *"Use existing components — `SelectList`, `SettingsList`, `BorderedLoader` cover 90% of cases. Don't rebuild them."*

This code rebuilds a selection list from scratch in every screen. Key patterns that should use `SelectList`:
- `renderPersonasList` → selectable list with labels + descriptions
- `renderPersonaEditor` → 3-step wizard that's essentially `SelectList` instances
- `renderOverridesListPipelines` / `renderOverridesListPhases` → `SelectList` with descriptions
- The confirm-quit modal → `SelectList` with two options

This means:
- No fuzzy search filtering (SelectList has this built-in)
- No scrolling indicators matching the pi standard
- No consistent cursor styling (`→` vs `▸` inconsistency with pi norms)
- No description columns on the right
- Double the code to maintain

### 3. **Width-Unsafe Rendering — No Truncation**

The pi-tui docs say: *"Critical: Each line from `render()` must not exceed the `width` parameter. Use `truncateToWidth()` for safety."*

`screens.ts` uses a home-grown `padRight()`:
```typescript
function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}
```

This uses `.length` on strings that may contain ANSI escape codes or multi-width CJK characters. More critically, many render functions produce lines with fixed-width columns (`padRight(field, 56)`, `padRight(field, 36)`) that can easily exceed the terminal width on narrow terminals. The `width` parameter is received but never used for truncation — it's only passed to `rule()`.

**Fix**: Replace `padRight` with `truncateToWidth` / `visibleWidth` from `@earendil-works/pi-tui`. Wrap or truncate every line before returning it.

### 4. **No Rendering Cache — Rebuilds on Every Frame**

The pi-tui docs explicitly recommend caching render output:
```typescript
render(width: number): string[] {
  if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
  // ...compute...
  this.cachedWidth = width;
  this.cachedLines = lines;
  return lines;
}
invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
```

`ConfigTuiComponent.invalidate()` is a no-op (`// Stateless renderer; no cache to drop`), which means every `requestRender()` triggers a full recomputation of the active screen. For screens with resolved-row computation (show-resolved), this walks all pipelines × phases on every keystroke.

**Fix**: Cache rendered lines in the component and invalidate on state change. Or compose from pi-tui components that already cache.

### 5. **Dead Focusable Implementation**

The component implements `Focusable` but never uses `CURSOR_MARKER`:

```typescript
export class ConfigTuiComponent implements Component, Focusable {
  focused: boolean = false; // Never read, never written to by the component
  render(width: number): string[] {
    return renderActive(this.state, width); // No CURSOR_MARKER usage
  }
}
```

The pi-tui docs say Focusable is for *"components that display a text cursor and need IME support."* Since this component uses vi-style navigation (arrow keys, j/k) rather than text input, implementing Focusable is misleading. It should either:
- Drop the `Focusable` interface (it's not needed here), OR
- Use `CURSOR_MARKER` so the hardware cursor tracks the `▸` selection indicator, giving screen-reader / accessibility benefits

### 6. **Hardcoded Menu-Item-to-Action Mapping**

`fireMenuItem()` maps index integers to action dispatches via a fragile if-else chain:
```typescript
if (index === 0) {
  this.dispatch({ kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
} else if (index === 1) {
  this.dispatch({ kind: "push-view", view: { kind: "overrides-list-pipelines", cursor: 0 } });
} else if (index === 2) { ... }
```

The menu items are defined separately in `topMenuItems()` in screens.ts, and `topLevelItemCount()` computes their count independently. If anyone adds/removes/reorders menu items, all three must be updated in sync. This is the definition of fragility.

**Fix**: Give each `MenuItem` an `action` field, and drive both rendering and dispatch from the same data structure.

### 7. **Side-Effect Ordering in `persistLayer()`**

```typescript
private persistLayer(layer: ConfigLayer): void {
  try {
    const target = writeRoutingConfig({ layer, cwd: this.state.cwd, buffer });
    this.dispatch({ kind: "mark-clean", lastSaved: { target, layer } });
    this.opts.onSaved?.(target);
  } catch (err) { ... }
}
```

This is called from within `handleInput()`, which means:
1. A write to disk happens synchronously on a keystroke
2. If the write fails, `this.opts.onError` fires but the state has already been committed (dirty=false from the prior action dispatch, before `mark-clean` fires)
3. The `onSaved` callback fires after the state mutation, meaning the render may happen before the notification

The pi-tui pattern for async work is `BorderedLoader` with an `AbortSignal`. Disk I/O in `handleInput` is a coupling violation.

### 8. **`requestRender` Passed as Option Rather Than Using `tui` Object**

The pi-tui pattern is: the factory callback receives `(tui, theme, keybindings, done)`, and the component calls `tui.requestRender()`. Here, `requestRender` is passed through `opts`:

```typescript
requestRender: () => tui.requestRender(),
```

This works but is a non-standard workaround that prevents the component from accessing other `tui` APIs (like future features).

### 9. **`q` Always-Quit Key Conflicts with Conventions**

`q` is wired as a universal quit key. This conflicts with pi-tui's convention where `Escape` is cancel/back. The user must press `q` → confirm `y`, whereas pi-tui overlays use `Escape` for dismissal. Users familiar with pi will press Escape expecting to quit, and instead navigate "back" one level.

### 10. **`uniqueProviders()` Is Duplicated**

The function appears in both `screens.ts` and `component.ts` with identical logic. The state module is the natural home for selectors.

### 11. **`padRight` Is Width-Unsafe and ANSI-Blind**

As noted above, `padRight` uses `text.length` which doesn't account for:
- ANSI escape sequences (future theming will break column alignment)
- CJK wide characters (full-width glyphs count as 2 columns but `length` sees 1)

Should use `visibleWidth()` and `truncateToWidth()` from pi-tui utils.

---

## The Ugly

### 1. **The `handleInput` God Method**

`handleInput()` in component.ts is a ~200-line if-else chain that dispatches to per-view handlers. Each handler is itself an if-else chain on `matchesKey()`. This is the worst code smell in the module:

```typescript
handleInput(data: string): void {
  if (this.state.shouldExit) return;
  const view = getActiveView(this.state);
  if (matchesKey(data, "q")) { ... return; }
  if (this.state.confirmQuit) { ... return; }
  if (matchesKey(data, Key.escape)) { ... return; }
  if (view.kind === "top-menu" || ...) { this.handleTopLevelInput(data); return; }
  if (view.kind === "personas-list") { this.handlePersonasListInput(data, view); return; }
  // ... 6 more view kinds
}
```

If pi-tui's `SelectList` were used, all navigation, selection, and cancellation logic for each list screen would be eliminated — replaced by a single `onSelect` / `onCancel` callback per SelectList instance. That's probably 60-70% of the input handling code gone.

### 2. **The `fireMenuItem` Dispatch Map**

The mapping from index 0-4 to specific push-view actions is not data-driven. Adding a new top-level menu item requires edits in:
- `topMenuItems()` (label)
- `topLevelItemCount()` (count)
- `fireMenuItem()` (action)
- `handleTopLevelInput()` (number shortcut handling: `"1"`, `"2"`, etc.)

This violates DRY and is a maintenance hazard.

### 3. **The Confirm-Quit Modal Is Hand-Marked ASCII Art**

```typescript
function renderConfirmQuitOverlay(state: ConfigTuiState, _width: number): string[] {
  return [
    "",
    `  ┌─────────────────────────────────────────────────────────┐`,
    `  │  Unsaved changes — discard and quit?                    │`,
    // ...
  ];
}
```

This:
- Doesn't respect terminal width (hardcoded 59-char box)
- Doesn't use `theme.fg()` for colors
- Doesn't use `Box` or `DynamicBorder` components
- Ignores the `_width` parameter
- Has no vertical centering or positioning

The pi-tui overlay system supports `{ overlayOptions: { anchor: "center" } }` for proper modal positioning. This should be a proper dialog component.

### 4. **The Save Banner Has No Timeout / Auto-Clear**

```typescript
function renderSaveBanner(state: ConfigTuiState, _width: number): string[] {
  if (!state.lastSaved) return [];
  return [``, `  ✓ Saved → ${state.lastSaved.target}  (${state.lastSaved.layer})`];
}
```

The `lastSaved` field is set by `mark-clean` but never cleared. There's a `clear-status` action in the reducer, but no code ever dispatches it. The "✓ Saved" banner will remain forever until the next navigation action pops the view. This should be a timed notification using `ctx.ui.notify()`.

### 5. **Silent Error Swallowing in `readAvailableModels()` and `readPersonaCatalogue()`**

```typescript
async function readAvailableModels(): Promise<{...}> {
  try { ... } catch { return { available: [], authenticated: [] }; }
}
```

And:

```typescript
function readPersonaCatalogue(): string[] {
  // tries multiple paths, returns [] on failure
}
```

If auth or model discovery fails, the user sees an empty model list with zero explanation. The TUI just shows "No models available for this provider" without any hint that auth failed. This should at minimum surface a warning and possibly offer to re-authenticate.

### 6. **The `show-resolved` Screen Can Have 16+ Rows With No Visible Cursor Context**

For projects with multiple pipelines, `computeResolvedRows()` flattens all phases. With 2 pipelines × 8 phases = 16 rows, the scrolling list doesn't show which pipeline name is currently relevant unless the user manually reads the "Pipeline: default" header embedded in the list. A proper list component would fix this.

### 7. **`handler.ts` Has Unused and Dead Parameters**

- `write()` callback is always `() => {}` in interactive mode
- `writeErr` falls back to `write` but `write` is a no-op
- The `edit-persona` and `edit-override` routes reach the same `mountConfigTui` entry point but don't pre-select the corresponding view — the user always lands on the top menu regardless of which subcommand they used
- `registerConfigCommand` receives `forgeRoot` but never uses it (the entire plugin-config screen is a "follow-up slice" stub)

### 8. **No Fuzzy Search / Type-Ahead**

The pi-tui `SelectList` supports type-to-filter via `setFilter()`. Every list screen in this TUI requires the user to arrow-key through potentially dozens of models. For providers with 100+ models (OpenRouter, etc.), this will be painful.

### 9. **Magic Numbers Throughout `screens.ts`**

Column widths like `56`, `36`, `12`, `13`, `25`, `31` are hardcoded padding values. If any string exceeds these widths, the columns misalign. If any string is shorter, there are gaps. These should be computed dynamically based on the actual data and terminal width.

---

## Recommendations (Priority Order)

| Priority | Recommendation | Effort |
|----------|---------------|--------|
| P0 | **Add theme support.** Thread `theme` from the factory callback into every render function. Use `theme.fg()`, `theme.bg()`, and `DynamicBorder`. | Medium |
| P0 | **Use `truncateToWidth` / `visibleWidth`.** Replace all `padRight()` calls and raw `string.length` usages. Every line in `render()` must respect `width`. | Low |
| P1 | **Replace hand-rolled list rendering with `SelectList`.** The `SelectList` component handles navigation, scrolling, selection, search, and theming out of the box. This would eliminate ~70% of `handleInput` and most screen render functions. | Medium |
| P1 | **Implement proper render caching.** Cache rendered lines per `(state, width)` and clear on `invalidate()`. | Low |
| P1 | **Make menu items data-driven.** Give each `MenuItem` an `action` callback and eliminate `fireMenuItem()`, `topLevelItemCount()`, and the number-shortcut if-else chain. | Low |
| P2 | **Drop the `Focusable` interface** or implement it correctly with `CURSOR_MARKER`. Given that this is a keyboard-navigable overlay, dropping it is correct for now. | Trivial |
| P2 | **Fix `lastSaved` banner timeout.** Dispatch `clear-status` after a few seconds, or use `ctx.ui.notify()` instead. | Low |
| P2 | **Move disk I/O out of `handleInput`.** Use `BorderedLoader` or an async pattern. At minimum, handle write failures without leaving state inconsistent. | Medium |
| P2 | **Use overlay options for the confirm-quit modal.** Replace hand-drawn box art with a centered overlay using `anchor: "center"`. | Low |
| P3 | **Consolidate `uniqueProviders()`.** Move the selector to `state.ts`. | Trivial |
| P3 | **Add search/filter to model and provider lists.** Either use `SelectList` with search enabled or implement type-ahead. | Medium |
| P3 | **Surface auth failures.** When `readAvailableModels` returns `[]`, show a diagnostic message rather than an empty list. | Low |

---

## Architectural Scorecard

| Criterion | Rating | Notes |
|-----------|--------|-------|
| State management | ✅ Good | Clean reducer, immutable updates, view stack |
| Separation of concerns | ✅ Good | state / screens / component / handler boundaries |
| Testability | ✅ Good | Pure render functions, reducer tests exist |
| pi-tui integration | ❌ Poor | No theming, no built-in components, no caching, no CURSOR_MARKER |
| Width safety | ❌ Poor | No truncation, hardcoded column widths, ANSI-blind padding |
| Accessibility | ⚠️ Adequate | Keyboard navigation works, but no hardware cursor positioning |
| Input handling | ⚠️ Adequate | Works but verbose; most could be replaced by SelectList callbacks |
| Error handling | ⚠️ Adequate | Disk writes are try/caught, but auth failures are silent |
| Maintainability | ⚠️ At risk | Menu item dispatch mapping is fragile; ~200-line handleInput |

**Bottom line**: The data layer (state.ts) and separation of concerns are strong. The rendering and input layers are functional but bypass pi-tui's abstractions entirely, producing a monochrome, width-unsafe, code-heavy implementation that could be **60–70% shorter** by composing `SelectList`, `DynamicBorder`, `Text`, and `Container`. Theme support alone would transform the user experience from "80s terminal utility" to "pi-native overlay."