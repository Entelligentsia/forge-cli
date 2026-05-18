# Phase 3 Implementation: Theming, Width Safety, Data-Driven Menus, Auth Errors, Polish

## Summary of Changes

### 1. Theme Helpers (`theme.ts`)
- **`dirtyMarker(theme)`** — themed "* unsaved" warning  
- **`truncateLines(lines, width)`** — final width-safety guard applied by every screen's `render()` method  
- **`cursor(isSelected, theme)`** — now imported and used by all screens instead of raw `"▸"` / `" "`  
- **`padRight()`** — no longer silently overflows; truncation happens at line level via `truncateLines`  

### 2. Full Theming on All Screens
Every visible string now routes through `theme.fg()` / `theme.bold()` or the `theme.ts` helpers:

| Screen | Key Theming Changes |
|---|---|
| `top-menu.ts` | Breadcrumb, auth status line, resolved summary, menu items, help text, dirty marker all themed via helpers |
| `personas-list.ts` | Cursor marker via `cursor()`, auth badges via `authBadgeFor()`, muted/warning text, header columns |
| `persona-picker.ts` | Breadcrumb via `accentBold()`, cursor via `cursor()`, muted status text, scroll hints |
| `persona-editor.ts` | Step headers via `accent()`, auth badges, model provider lists, cursor, help text |
| `show-resolved.ts` | Breadcrumb, column headers muted, auth badges, pipeline headers via `accentBold()` |
| `overrides-list.ts` | Breadcrumb, pipeline names, override counts via `accentBold()`, muted text |
| `overrides-list-phases.ts` | Breadcrumb, column headers, muted help text, dirty marker |
| `override-editor.ts` | Step headers, provider/model lists with cursor/badges, muted help text |
| `confirm-quit.ts` | **Adaptive-width dialog** using `DynamicBorder` + themed `borderAccent`, background fill, error/muted styling |
| `shared.ts` | `authStatusLine()` now shows `authError` diagnostic when model discovery fails |

### 3. Width Safety (`truncateToWidth` + `truncateLines`)
- Every screen's `render()` method calls `safeLines(lines, width)` as a final guard
- `component.ts` adds a second `truncateToWidth(line, width, "")` guard in the modal frame render loop
- `padRight()` no longer silently overflows — it pads only; over-wide content is truncated at line level

### 4. Data-Driven Menu Items (`top-menu.ts`)
- `MenuItem` now carries an `action` field: `(s: ConfigTuiState) => ConfigTuiAction | null`
- `fireMenuItem()` derives the action from the data-driven `MenuItem` array instead of indexing
- Stub items (Pipelines, Plugin config) return `null` action → surface an error message
- Number/Enter key handling dispatches via `item.action(state)`

### 5. Auth Error Surfacing
- `InitOptions` gained optional `authError?: string` field  
- `ConfigTuiState` gained `authError: string | null`  
- `readAvailableModels()` in `handler.ts` now surfaces the error message instead of silently returning empty  
- `authStatusLine()` in `shared.ts` shows the error diagnostic when `state.authError` is set  

### 6. Confirm-Quit Dialog (Phase 3)
- Replaced hardcoded 59-char ASCII box with adaptive-width `DynamicBorder` 
- Uses themed `borderAccent` for borders, `bg("selectedBg")` for content background
- Width adapts to terminal: `Math.max(50, Math.min(width - 4, 70))`
- Error text and muted text are themed properly

### 7. Save Banner Theming
- `renderSaveBanner()` now uses `theme.fg("success", ...)` for the "✓ Saved" indicator

### 8. Tests
- **149 total tests passing** (125 original + 24 new Phase 3 tests)
- New `config-tui-phase3.test.ts` covering:
  - Theme helper units (`cursor`, `authBadge`, `dirtyMarker`, `padOrTruncate`, `padRight`)  
  - `truncateLines()` width-safety guard
  - Narrow-width rendering (40px) for top-menu, personas-list
  - Wide-width rendering (140px) for table-heavy screens
  - Auth error surfacing in top-menu
  - Data-driven menu dispatch and stub item errors
  - Themed save banner
  - Adaptive-width confirm-quit dialog
- Updated `config-tui-screens.test.ts` to use `WIDTH=140` for the table-heavy `overrides-list-phases` test

## Files Changed

| File | Change |
|---|---|
| `theme.ts` | Added `dirtyMarker()`, `truncateLines()`, reverted `padRight()` to never-truncate |
| `state/model.ts` | Added `authError` to `InitOptions` and `ConfigTuiState` |
| `state/init.ts` | Initialise `authError` from options |
| `state.ts` | Barrel re-export updated |
| `handler.ts` | `readAvailableModels()` surfaces auth error |
| `component.ts` | `truncateToWidth` guard in render loop |
| `screens/shared.ts` | `authStatusLine()` surfaces auth errors; added `safeLines()`  
| `screens/top-menu.ts` | Data-driven `MenuItem` with actions; full theming; width safety |
| `screens/personas-list.ts` | Full theming; width safety |
| `screens/persona-picker.ts` | Full theming; width safety |
| `screens/persona-editor.ts` | Full theming; width safety |
| `screens/show-resolved.ts` | Full theming; width safety; fixed `authBadge` import |
| `screens/overrides-list.ts` | Full theming; width safety |
| `screens/overrides-list-phases.ts` | Full theming; width safety |
| `screens/override-editor.ts` | Full theming; width safety |
| `screens/confirm-quit.ts` | Adaptive `DynamicBorder` dialog; themed; save banner themed |
| `screens.ts` | Barrel updated for Phase 3 exports |
| `test/extensions/forgecli/config-tui-phase3.test.ts` | **New** — 24 Phase 3 tests |
| `test/extensions/forgecli/config-tui-screens.test.ts` | Widened table test viewport |