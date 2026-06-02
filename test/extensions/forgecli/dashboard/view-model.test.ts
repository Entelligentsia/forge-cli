// view-model.test.ts — Unit tests for the dashboard ViewModel projection.
//
// Exercises buildViewModel: active-root filtering, depth projection,
// subtree progress from the VM, and controller query methods.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrchestratorTree } from "../../../../src/extensions/forgecli/orchestrator-tree.js";
import { buildViewModel } from "../../../../src/extensions/forgecli/dashboard/view-model.js";
import type { NodeViewModel } from "../../../../src/extensions/forgecli/dashboard/view-model.js";
import { DashboardController } from "../../../../src/extensions/forgecli/dashboard/component.js";

describe("buildViewModel", () => {
	let tree: OrchestratorTree;

	beforeEach(() => {
		tree = new OrchestratorTree();
	});

	it("projects an empty tree into an empty VM", () => {
		const vm = buildViewModel(tree);
		expect(vm.roots).toEqual([]);
		expect(vm.nodes.size).toBe(0);
	});

	it("projects a single root node", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const vm = buildViewModel(tree);
		expect(vm.roots).toEqual(["sprint-1"]);
		expect(vm.nodes.size).toBe(1);
		const node = vm.nodes.get("sprint-1")!;
		expect(node.label).toBe("Sprint 1");
		expect(node.kind).toBe("orchestrator");
		expect(node.depth).toBe(0);
		expect(node.status).toBe("running");
		expect(node.parentId).toBeNull();
		expect(node.children).toEqual([]);
	});

	it("projects a parent–child hierarchy with correct depth", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
		tree.startNode("task-1:plan:1", { parentId: "task-1", label: "plan:1", kind: "leaf" });

		const vm = buildViewModel(tree);
		expect(vm.roots).toEqual(["sprint-1"]);
		expect(vm.nodes.get("sprint-1")!.depth).toBe(0);
		expect(vm.nodes.get("task-1")!.depth).toBe(1);
		expect(vm.nodes.get("task-1:plan:1")!.depth).toBe(2);
	});

	it("shallow-copies children array so model mutations don't leak", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });

		const vm = buildViewModel(tree);
		const vmChildren = vm.nodes.get("sprint-1")!.children;
		expect(vmChildren).toEqual(["task-1"]);
		// Mutating the VM copy should not affect the model.
		vmChildren.push("task-2");
		expect(tree.getNode("sprint-1")!.children).toEqual(["task-1"]);
	});

	it("shallow-copies tailBuffer so model mutations don't leak", () => {
		tree.startNode("phase-1", { kind: "leaf" });
		tree.appendTail("phase-1", "line 1");

		const vm = buildViewModel(tree);
		expect(vm.nodes.get("phase-1")!.tailBuffer).toEqual(["line 1"]);
		vm.nodes.get("phase-1")!.tailBuffer.push("line 2");
		expect(tree.getNode("phase-1")!.tailBuffer).toEqual(["line 1"]);
	});

	it("filters out terminal roots when a running root exists", () => {
		// Create a completed sprint.
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.completeNode("sprint-1", "completed");

		// Create a running sprint.
		tree.startNode("sprint-2", { label: "Sprint 2", kind: "orchestrator" });

		const vm = buildViewModel(tree);
		// Only the running sprint should be in the VM (stale root filtered).
		expect(vm.roots).toEqual(["sprint-2"]);
		expect(vm.nodes.has("sprint-1")).toBe(false);
	});

	it("includes all roots when nothing is running", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.completeNode("sprint-1", "completed");
		tree.startNode("sprint-2", { label: "Sprint 2", kind: "orchestrator" });
		tree.completeNode("sprint-2", "completed");

		const vm = buildViewModel(tree);
		// Nothing running — all roots visible.
		expect(vm.roots).toEqual(["sprint-1", "sprint-2"]);
	});

	it("projects usage and metrics as shallow copies", () => {
		tree.startNode("phase-1", { kind: "leaf" });
		tree.setNodeUsage("phase-1", { input: 100, output: 200, cacheRead: 50 });
		tree.bumpNodeTurn("phase-1");

		const vm = buildViewModel(tree);
		const node = vm.nodes.get("phase-1")!;
		expect(node.usage).toEqual({ input: 100, output: 200, cacheRead: 50 });
		expect(node.metrics.turn).toBe(1);

		// Mutating the VM copy should not affect the model.
		node.usage.input = 999;
		expect(tree.getNode("phase-1")!.usage.input).toBe(100);
	});

	it("projects model and provider fields", () => {
		tree.startNode("phase-1", { kind: "leaf" });
		tree.setNodeModel("phase-1", "claude-3.5-sonnet", "anthropic");

		const vm = buildViewModel(tree);
		expect(vm.nodes.get("phase-1")!.model).toBe("claude-3.5-sonnet");
		expect(vm.nodes.get("phase-1")!.provider).toBe("anthropic");
	});
});

describe("DashboardController", () => {
	let tree: OrchestratorTree;

	beforeEach(() => {
		tree = new OrchestratorTree();
	});

	it("getNode reads from VM, not model directly", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const controller = new DashboardController(tree);
		controller.setOnInvalidate(() => {}); // no-op to avoid render errors

		const node = controller.getNode("sprint-1");
		expect(node).toBeDefined();
		expect(node!.label).toBe("Sprint 1");
		expect(node!.depth).toBe(0);
	});

	it("getChildren reads from VM", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });

		const controller = new DashboardController(tree);
		controller.setOnInvalidate(() => {});

		const children = controller.getChildren("sprint-1");
		expect(children).toHaveLength(1);
		expect(children[0]!.label).toBe("Task 1");
	});

	it("getSubtreeProgress reads from VM", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.startNode("task-1:plan:1", { parentId: "sprint-1", label: "plan:1", kind: "leaf" });
		tree.completeNode("task-1:plan:1", "completed");

		const controller = new DashboardController(tree);
		controller.setOnInvalidate(() => {});

		const progress = controller.getSubtreeProgress("sprint-1");
		expect(progress).toEqual({ completed: 1, total: 1 });
	});

	it("rebuilds VM on model events (V2 fix)", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const invalidateCalls: string[] = [];
		const controller = new DashboardController(tree);
		controller.setOnInvalidate(() => { invalidateCalls.push("invalidate"); });

		// Node starts as running.
		expect(controller.getNode("sprint-1")!.status).toBe("running");

		// Complete the node — model emits "change", controller rebuilds VM.
		tree.completeNode("sprint-1", "completed");

		// VM should reflect the completed status.
		expect(controller.getNode("sprint-1")!.status).toBe("completed");
		// Invalidation should have been triggered.
		expect(invalidateCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("getVisibleNodes respects expansion state", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
		tree.startNode("task-1:plan:1", { parentId: "task-1", label: "plan:1", kind: "leaf" });

		const controller = new DashboardController(tree);
		controller.setOnInvalidate(() => {});

		// Without expanding, only the root is visible.
		const visibleBefore = controller.getVisibleNodes();
		expect(visibleBefore).toEqual(["sprint-1"]);

		// Expand the sprint root.
		controller.handleInput("\x1b[C"); // right arrow → activate/expand
		const visibleAfter = controller.getVisibleNodes();
		expect(visibleAfter).toContain("sprint-1");
		expect(visibleAfter).toContain("task-1");
	});

	it("autoExpandNewNode expands parent of new leaf (only visible parents)", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });

		const controller = new DashboardController(tree);
		controller.setOnInvalidate(() => {});

		// Expand the root first so its children are visible.
		controller.handleInput("\x1b[C"); // right → expand sprint

		// Adding a task under the expanded sprint should auto-expand
		// the sprint (its parent is already visible).
		tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });

		// The controller auto-expands because it subscribes to "tree" events.
		const state = controller.getState();
		expect(state.expanded.has("sprint-1")).toBe(true);
	});

	it("dispose unsubscribes from model events", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const controller = new DashboardController(tree);
		let invalidateCount = 0;
		controller.setOnInvalidate(() => { invalidateCount++; });

		tree.completeNode("sprint-1", "completed");
		expect(invalidateCount).toBeGreaterThanOrEqual(1);

		controller.dispose();
		const countBefore = invalidateCount;

		// Events after dispose should not trigger invalidation.
		tree.startNode("sprint-2", { label: "Sprint 2", kind: "orchestrator" });
		expect(invalidateCount).toBe(countBefore);
	});

	it("filters stale roots from getVisibleNodes when running root exists", () => {
		// Create completed sprint.
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		tree.completeNode("sprint-1", "completed");

		// Create running sprint.
		tree.startNode("sprint-2", { label: "Sprint 2", kind: "orchestrator" });

		const controller = new DashboardController(tree);
		controller.setOnInvalidate(() => {});

		// Stale root should be filtered out.
		const visible = controller.getVisibleNodes();
		expect(visible).toContain("sprint-2");
		expect(visible).not.toContain("sprint-1");
	});

	// ── Cancel confirmation flow ────────────────────────────────────────────

	describe("cancel confirmation flow", () => {
		it("x key sets cancelTargetId on a running node", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });

			const controller = new DashboardController(tree);
			controller.setOnInvalidate(() => {});

			// Move cursor to task-1.
			controller.handleInput("\x1b[C"); // right arrow → expand sprint-1
			controller.handleInput("\x1b[B"); // down → move to task-1

			// Press x to start cancel.
			controller.handleInput("x");

			// cancelTargetId should be set, not null.
			expect(controller.getState().cancelTargetId).not.toBeNull();
		});

		it("n dismisses cancel confirm without closing overlay", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });

			const controller = new DashboardController(tree);
			controller.setOnInvalidate(() => {});

			// Move cursor to the running sprint.
			controller.handleInput("\x1b[C"); // right → expand

			// Start cancel.
			controller.handleInput("x");
			expect(controller.getState().cancelTargetId).not.toBeNull();

			// Press 'n' to dismiss the cancel prompt.
			// ESC is handled by the view layer (closes overlay), not the controller.
			controller.handleInput("n");
			expect(controller.getState().cancelTargetId).toBeNull();
		});

		it("y confirms cancel and clears cancelTargetId", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });

			const controller = new DashboardController(tree);
			controller.setOnInvalidate(() => {});

			// Start cancel.
			controller.handleInput("x");
			expect(controller.getState().cancelTargetId).not.toBeNull();

			// Confirm.
			controller.handleInput("y");
			expect(controller.getState().cancelTargetId).toBeNull();
			// The node should now be cancelling in the tree.
			expect(tree.getNode("sprint-1")!.status).toBe("cancelling");
		});
	});
});