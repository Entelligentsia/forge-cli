# Dashboard MVC Architecture Audit

**Date:** 2026-06-02
**Scope:** `src/extensions/forgecli/dashboard/component.ts`, `orchestrator-tree.ts`
**Symptom:** Left-pane tree shows duplicate top-level nodes when a new workflow
step is registered while the dashboard overlay is already open. Duplication
resolves when the overlay is closed and re-opened.

---

## 1. Summary of Findings

The dashboard overlay has pervasive MVC boundary violations that make visual
bugs hard to reason about and harder to fix. The **duplicate-top-level-nodes**
symptom has **three probable contributing causes**, each exacerbated by the
architecture smell. No single root cause is definitive from static analysis
alone; the fixes below simultaneously eliminate all three.

---

## 2. MVC Boundary Violations

### V1 — View reads model directly (6 call sites)

`DashboardComponent.render()` and its helpers call the `OrchestratorTree`
model directly:

| Call site | Method |
|---|---|
| `render()` | `this.tree.getNode(state.cursorId)` |
| `renderTreePanel()` | `this.tree.getNode(id)` (loop) |
| `renderTreePanel()` | `this.tree.getDepth(id)` |
| `renderTreePanel()` | `this.tree.getSubtreeProgress(id)` |
| `renderDetailPanel()` | `this.tree.getChildren(node.id)` |
| `renderCancelConfirm()` | `this.tree.getNode(targetId)` |

In a clean MVC, the view reads from the controller, which projects the model
into a flat view-model. Direct model reads mean any model mutation triggers a
visual side-effect bypassing controller coordination.

### V2 — View subscribes to model events directly

```ts
constructor(…) {
    // …
    this.tree.on("change", rerender);   // ← view binds model event
    this.tree.on("tail",   rerender);
    this.tree.on("preview", rerender);
}
```

The view should receive change notifications **through the controller**, not
directly from the model. This coupling means the view re-renders on every
model event even when the change is irrelevant to the visible tree region.

### V3 — View owns the refresh timer

`ensureRefreshTimer()` / `refreshTimer` lives in the view. The timer decides
*whether anything is running* by polling `this.tree.getRoots()`. Timer
management is a controller concern; the view should just be told "render now."

### V4 — Controller reads model directly (4 call sites)

| Call site | Method |
|---|---|
| `constructor` | `tree.getRoots()` |
| `getVisibleNodes()` | `this.tree.getNode(id)`, `this.tree.getRoots()` |
| `getVisibleNodes()` (DFS) | `this.tree.getNode(id)` |
| `ensureAncestorsExpanded()` | `this.tree.getAncestors(id)` |

### V5 — Controller writes model directly

`cancelNodeAndSessions()` calls `this.tree.requestCancel(nodeId)`. The
controller should request cancellation **through a model method** that also
emits a structured change event; instead it mutates the model and then relies
on the model's `"change"` event to re-render the view.

### V6 — View reads controller state directly for detail panel

`renderDetailPanel()` reads `this.controller.getState().promptExpanded`. This
is benign but illustrates how mixed concern boundaries invite further direct
access patterns.

### V7 — `autoExpandNewNode()` is dead code

`DashboardController.autoExpandNewNode(id)` is defined but **never wired**.
When a new node is added to the tree, the dashboard does not auto-expand its
parent, so new children of a collapsed orchestrator are invisible until the
user manually expands. This is a UX smell directly caused by the missing
controller→view→model coordination layer.

---

## 3. Probable Causes of Duplicate Top-Level Nodes

### Cause A — Orphaned stale root nodes

`OrchestratorTree` is a **singleton that is never reset**. Nodes from previous
sprint/run invocations persist in `this.roots` and `this.nodes`. When the
dashboard opens, `getRoots()` returns every root, including completed roots
from prior runs. The user sees:

```
 Phases
 ✔ ▸ FORGE-S26  3/3     ← stale root from previous sprint
 ❯ ● ▸ FORGE-S27  1/3   ← current sprint
```

Closure and re-opening creates a **fresh controller** (with `expanded: new
Set()`), which re-reads the same model and shows the same stale roots. The
"duplication resolves on re-open" observation is likely about the controller
state reset (cursor, expansion) accidentally making the layout look different,
not about the model actually changing.

**Fix:** Evict completed/killed roots when no running root exists, or add a
model method `getActiveRoots()` that filters out terminal roots.

### Cause B — Resume path does not update parent-child relationships

`startNode()` takes a `parentId` option, but when a node **already exists**
(resume path), it ignores the new `parentId`:

```ts
const existing = this.nodes.get(id);
if (existing) {
    // Resume — refreshes status, does NOT change parentId
    existing.status = "running";
    // …
    return existing;          // ← child-of-old-parent structure unchanged
}
```

Consequences:

1. A task first created as a **root** (standalone `/forge:run-task`)
   remains a root even when later re-started under a sprint.
2. A node evicted by `removeSubtree` and then re-added via `startNode`
   would be re-created with the new `parentId`; but if it resumes, it
   retains the old relationship.

**Fix:** Add a `reparentNode(id, newParentId)` method to the model and call
it when `startNode` detects a parentId mismatch on resume.

### Cause C — `parent.children` can accumulate stale entries

`removeSubtree` unlinks a child from `parent.children` via `filter`. But if an
evicted child is re-added by `startNode` (which pushes to `parent.children`
without a dedup check), and the eviction happened **during the same event-loop
tick** as the re-add (unlikely but not impossible in deeply nested orchestrator
scenarios), the `filter` would remove the old entry while the `push` adds a new
one — net effect: one entry. However, if `startNode` is called on an
already-present ID (resume path), `push` is skipped. Combined with Cause B,
this means stale parent structures never self-heal.

**Fix:** Replace `parent.children` with a `Set<string>` (preserving insertion
order) or add a dedup check before `push`.

---

## 4. Recommended Refactoring

### Step 1 — Introduce a ViewModel projection

```ts
// dashboard/view-model.ts

export interface TreeViewModel {
  roots: string[];              // root node IDs (active-only)
  nodes: Map<string, NodeViewModel>;
}

export interface NodeViewModel {
  id: string;
  label: string;
  kind: "orchestrator" | "leaf";
  parentId: string | null;
  children: string[];
  status: NodeStatus;
  depth: number;
  // …projected fields the view needs
}
```

The controller builds a `TreeViewModel` on each `change`/`tree`/`tail`/`preview`
model event, filtering out stale roots and pre-computing depth. The view
reads **only** from the view model — never the model.

### Step 2 — Move subscriptions to the controller

```ts
// Before (V2):
this.tree.on("change", rerender);   // in view constructor

// After:
// controller subscribes to model, projects view model, calls onInvalidate
this.tree.on("change", () => {
    this.rebuildViewModel();
    this.onInvalidate?.();
});
```

The view removes all `this.tree.*` calls and instead reads
`this.controller.getViewModel()`.

### Step 3 — Move timer management to the controller

```ts
// Before (V3):
// view owns refreshTimer, checks tree.getRoots()

// After:
// controller starts/stops timer based on model state
// controller calls onInvalidate() on each tick
```

### Step 4 — Fix model defects

| Defect | Fix |
|---|---|
| Stale roots persist indefinitely | Add `getActiveRoots()` or `pruneTerminalRoots()` |
| Resume path ignores `parentId` | Compare `existing.parentId` against `opts.parentId`; call `reparentNode()` on mismatch |
| `parent.children` is a plain array | Switch to `Set<string>` with insertion-order iteration or add `includes()` guard before `push` |

### Step 5 — Wire `autoExpandNewNode`

On the `"tree"` model event (emitted when nodes are added/removed), the
controller should call `autoExpandNewNode(id)` to auto-expand the parent of
the new node, making it immediately visible in the left pane.

---

## 5. Priority

| Item | Impact | Effort |
|---|---|---|
| Fix Cause A (stale roots) | **High** — visible duplicate symptom | Low |
| Fix Cause B (resume parentId) | **High** — structural correctness | Medium |
| Fix Cause C (children dedup) | Medium — defensive | Low |
| Wire `autoExpandNewNode` | Medium — UX | Low |
| ViewModel projection | High — eliminates V1–V6 | High |
| Move subscriptions to controller | Medium — eliminates V2 | Medium |
| Move timer to controller | Low — eliminates V3 | Low |

**Recommended sequence:** A → C → B → wire autoExpand → then the ViewModel
refactor when a sprint is not active (the dashboard is closed).