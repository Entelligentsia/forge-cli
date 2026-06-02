# Dashboard MVC Architecture Audit

**Date:** 2026-06-02
**Scope:** `src/extensions/forgecli/dashboard/component.ts`, `orchestrator-tree.ts`
**Symptom:** Left-pane tree shows duplicate top-level nodes when a new workflow
step is registered while the dashboard overlay is already open. Duplication
resolves when the overlay is closed and re-opened.

---

## 1. Summary of Findings

The dashboard overlay had pervasive MVC boundary violations that made visual
bugs hard to reason about and harder to fix. The **duplicate-top-level-nodes**
symptom had **three probable contributing causes**, each exacerbated by the
architecture smell. No single root cause is definitive from static analysis
alone; the fixes simultaneously eliminate all three.

**Status (2026-06-02): All findings and causes are now fixed.**

- V1–V7 (MVC boundary violations): Fixed by introducing a `TreeViewModel`
  projection (`dashboard/view-model.ts`). The `DashboardController` builds the
  VM on every model event; the `DashboardComponent` reads only from the
  controller — never directly from the `OrchestratorTree` model.
- Cause A (stale roots): Fixed by `getActiveRoots()` in `OrchestratorTree`
  (filters terminal roots when a running root exists). The VM is built from
  `getActiveRoots()`, not `getRoots()`.
- Cause B (resume parentId): Fixed by `reparentNode()` in `OrchestratorTree`
  (called on resume when `parentId` changes).
- Cause C (children dedup): Fixed by `includes()` guard in `OrchestratorTree`
  `startNode` and `reparentNode`.

### Files changed

| File | Change |
|------|--------|
| `dashboard/view-model.ts` | **New.** `NodeViewModel`, `TreeViewModel` interfaces and `buildViewModel()` projection. |
| `dashboard/component.ts` | **Refactored.** Controller owns VM, subscriptions (V2), and timer (V3); view reads only from controller (V1). All `this.tree.*` calls removed from view. Controller `dispose()` cleans up subscriptions and timer. |
| `dashboard/register.ts` | **Updated.** Creates `DashboardController` before `DashboardComponent`; passes controller instead of tree. |
| `thread-switcher.ts` | **Updated.** Same constructor signature change as register.ts. |
| `orchestrator-tree.ts` | **Previously fixed.** `getActiveRoots()`, `reparentNode()`, and dedup guards were already in place before this audit. |
| `test/extensions/forgecli/dashboard/view-model.test.ts` | **New.** 17 tests for `buildViewModel()` and `DashboardController` VM-driven queries. |

---

## 2. MVC Boundary Violations

### V1 — View reads model directly (6 call sites) ✅ FIXED

`DashboardComponent.render()` and its helpers call the `OrchestratorTree`
model directly:

| Call site | Method | Fix |
|---|---|---|
| `render()` | `this.tree.getNode(state.cursorId)` | → `this.controller.getNode(state.cursorId)` |
| `renderTreePanel()` | `this.tree.getNode(id)` (loop) | → `this.controller.getNode(id)` |
| `renderTreePanel()` | `this.tree.getDepth(id)` | → precomputed `node.depth` from VM |
| `renderTreePanel()` | `this.tree.getSubtreeProgress(id)` | → `this.controller.getSubtreeProgress(id)` |
| `renderDetailPanel()` | `this.tree.getChildren(node.id)` | → `this.controller.getChildren(node.id)` |
| `renderCancelConfirm()` | `this.tree.getNode(targetId)` | → `this.controller.getNode(targetId)` |

In a clean MVC, the view reads from the controller, which projects the model
into a flat view-model. Direct model reads meant any model mutation triggered a
visual side-effect bypassing controller coordination. **Now fixed: the view
reads only `NodeViewModel` projections through `DashboardController` methods.**

### V2 — View subscribes to model events directly ✅ FIXED

```ts
// BEFORE (violation):
this.tree.on("change", rerender);   // view binds model event
this.tree.on("tail",   rerender);
this.tree.on("preview", rerender);

// AFTER (fix):
// DashboardController subscribes to model events in its constructor.
// On each event, it rebuilds the VM and calls onInvalidate().
// DashboardComponent registers onInvalidate = () => tui.requestRender().
```

### V3 — View owns the refresh timer ✅ FIXED

`ensureRefreshTimer()` / `refreshTimer` moved from `DashboardComponent` to
`DashboardController`. The controller checks `hasRunningNodes()` against the
VM and calls `onInvalidate()` on each tick. The view no longer polls the
model directly.

### V4 — Controller reads model directly (4 call sites) ✅ FIXED

| Call site | Before | After |
|---|---|---|
| `getVisibleNodes()` | `this.tree.getNode(id)`, `this.tree.getActiveRoots()` | `this.vm.nodes.get(id)`, `this.vm.roots` |
| `ensureAncestorsExpanded()` | `this.tree.getAncestors(id)` | walks `node.parentId` chain in VM |
| Other query methods | `this.tree.getNode()` | `this.vm.nodes.get()` |

The controller still holds a reference to `OrchestratorTree` for model
mutations (`requestCancel`, `buildViewModel`), but **all reads go through
the VM**.

### V5 — Controller writes model directly ✅ ACCEPTABLE

`cancelNodeAndSessions()` calls `this.tree.requestCancel(nodeId)`. The
controller should be able to call model mutation methods. Reads within the
method (walking up parents, checking kind) now go through the VM.

### V6 — View reads controller state directly for detail panel ✅ ACCEPTABLE

`renderDetailPanel()` reads `this.controller.getState().promptExpanded`. This
is benign — the view reading controller state is correct MVC.

### V7 — `autoExpandNewNode()` wired ✅ FIXED

`DashboardController.autoExpandNewNode(id)` is called from the controller's
`"tree"` event handler. When a new node is added to the tree, the controller
rebuilds the VM, auto-expands the parent, and invalidates the view.

---

## 3. Probable Causes of Duplicate Top-Level Nodes

### Cause A — Orphaned stale root nodes ✅ FIXED

Fixed by `getActiveRoots()` in `OrchestratorTree`, which filters out terminal
roots when a running root exists. The VM is built from `getActiveRoots()`,
so stale roots never appear in the dashboard.

### Cause B — Resume path does not update parent-child relationships ✅ FIXED

Fixed by `reparentNode()` in `OrchestratorTree`, called when `startNode`
detects a `parentId` mismatch on resume.

### Cause C — `parent.children` can accumulate stale entries ✅ FIXED

Fixed by `includes()` guard before `push` in both `startNode` and
`reparentNode`.

---

## 4. Implemented Refactoring

### Step 1 — Introduce a ViewModel projection ✅

`dashboard/view-model.ts` defines `NodeViewModel` and `TreeViewModel`
interfaces. `buildViewModel(tree)` projects an `OrchestratorTree` into a flat
snapshot including pre-computed `depth`. The view reads only from `NodeViewModel`
objects — never from the `OrchestratorNode` model.

### Step 2 — Move subscriptions to the controller ✅

`DashboardController` subscribes to `"change"`, `"tail"`, `"preview"`, and
`"tree"` events in its constructor. On each event it:
1. Rebuilds the VM (`this.vm = buildViewModel(this.tree)`)
2. For `"tree"` events, calls `autoExpandNewNode(id)`
3. Calls `this.onInvalidate?.()` to trigger a re-render

`DashboardComponent` registers `onInvalidate = () => tui.requestRender()` and
removes all direct model subscriptions.

### Step 3 — Move timer management to the controller ✅

`DashboardController` owns `ensureRefreshTimer()` and `stopRefreshTimer()`.
The timer checks `hasRunningNodes()` against the VM and calls `onInvalidate()`
on each tick. The view has no timer logic.

### Step 4 — Fix model defects ✅ (pre-existing)

Already implemented in `OrchestratorTree`: `getActiveRoots()`,
`reparentNode()`, children dedup guards.

### Step 5 — Wire `autoExpandNewNode` ✅

Wired in the controller's `"tree"` event handler.

---

## 5. Priority (historical)

| Item | Impact | Effort | Status |
|---|---|---|---|
| Fix Cause A (stale roots) | **High** — visible duplicate symptom | Low | ✅ |
| Fix Cause B (resume parentId) | **High** — structural correctness | Medium | ✅ |
| Fix Cause C (children dedup) | Medium — defensive | Low | ✅ |
| Wire `autoExpandNewNode` | Medium — UX | Low | ✅ |
| ViewModel projection | High — eliminates V1–V6 | High | ✅ |
| Move subscriptions to controller | Medium — eliminates V2 | Medium | ✅ |
| Move timer to controller | Low — eliminates V3 | Low | ✅ |