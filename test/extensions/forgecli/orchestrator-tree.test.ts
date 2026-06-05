// orchestrator-tree.test.ts — Unit tests for OrchestratorTree.
//
// Exercises the model's CRUD, tree structure, queries, and event emission.
// No external dependencies — pure in-memory logic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrchestratorTree, getOrchestratorTree } from "../../../src/extensions/forgecli/orchestrator-tree.js";

describe("OrchestratorTree", () => {
	let tree: OrchestratorTree;

	beforeEach(() => {
		tree = new OrchestratorTree();
	});

	// ── Node lifecycle ────────────────────────────────────────────────────────

	describe("startNode / completeNode", () => {
		it("creates a root node with kind orchestrator by default", () => {
			const node = tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			expect(node.id).toBe("sprint-1");
			expect(node.label).toBe("Sprint 1");
			expect(node.kind).toBe("orchestrator");
			expect(node.status).toBe("running");
			expect(node.parentId).toBeNull();
			expect(node.children).toEqual([]);
			expect(tree.getRoots().map((r) => r.id)).toEqual(["sprint-1"]);
			expect(tree.getActiveRoots().map((r) => r.id)).toEqual(["sprint-1"]);
		});

		it("creates a leaf node under a parent", () => {
			tree.startNode("task-1", { label: "Task 1", kind: "orchestrator" });
			const phase = tree.startNode("task-1:plan:1", {
				parentId: "task-1",
				label: "plan:1",
				kind: "leaf",
			});
			expect(phase.parentId).toBe("task-1");
			expect(phase.kind).toBe("leaf");
			expect(tree.getNode("task-1")!.children).toContain("task-1:plan:1");
		});

		it("completes a node and sets endedAt", () => {
			const node = tree.startNode("task-1", { label: "Task 1", kind: "orchestrator" });
			expect(node.endedAt).toBeUndefined();
			tree.completeNode("task-1", "completed");
			expect(node.status).toBe("completed");
			expect(node.endedAt).toBeDefined();
		});

		it("does not clobber terminal status on idempotent completeNode", () => {
			tree.startNode("task-1", { label: "Task 1" });
			tree.completeNode("task-1", "completed");
			tree.completeNode("task-1", "failed"); // should be no-op
			expect(tree.getNode("task-1")!.status).toBe("completed");
		});

		it("resumes a node on second startNode call", () => {
			tree.startNode("task-1", { label: "Task 1" });
			tree.completeNode("task-1", "completed");
			const resumed = tree.startNode("task-1", { label: "Task 1" });
			expect(resumed.status).toBe("running");
			expect(resumed.endedAt).toBeUndefined();
		});
	});

	// ── Telemetry ─────────────────────────────────────────────────────────────

	describe("telemetry", () => {
		it("setNodeUsage updates usage", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.setNodeUsage("phase-1", { input: 100, output: 200, cacheRead: 50 });
			const node = tree.getNode("phase-1")!;
			expect(node.usage.input).toBe(100);
			expect(node.usage.output).toBe(200);
		});

		it("setNodeModel updates model/provider", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.setNodeModel("phase-1", "claude-3.5-sonnet", "anthropic");
			expect(tree.getNode("phase-1")!.model).toBe("claude-3.5-sonnet");
			expect(tree.getNode("phase-1")!.provider).toBe("anthropic");
		});

		it("setNodeModel does not emit on duplicate", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			const handler = vi.fn();
			tree.on("change", handler);
			tree.setNodeModel("phase-1", "claude-3.5-sonnet", "anthropic");
			expect(handler).toHaveBeenCalledTimes(1);
			tree.setNodeModel("phase-1", "claude-3.5-sonnet", "anthropic");
			expect(handler).toHaveBeenCalledTimes(1); // no additional emit
		});

		it("bumpNodeTurn increments turn counter", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			expect(tree.getNode("phase-1")!.metrics.turn).toBe(0);
			tree.bumpNodeTurn("phase-1");
			tree.bumpNodeTurn("phase-1");
			expect(tree.getNode("phase-1")!.metrics.turn).toBe(2);
		});

		it("incrementNodeToolCount adds to tool count", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.incrementNodeToolCount("phase-1");
			tree.incrementNodeToolCount("phase-1", 3);
			expect(tree.getNode("phase-1")!.metrics.toolCount).toBe(4);
		});

		it("setNodeIteration sets iteration number", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.setNodeIteration("phase-1", 2);
			expect(tree.getNode("phase-1")!.iteration).toBe(2);
		});

		it("setNodeOutcome sets outcome preview", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.setNodeOutcome("phase-1", "Task completed successfully.");
			expect(tree.getNode("phase-1")!.outcomePreview).toBe("Task completed successfully.");
		});
	});

	// ── Tail buffer ────────────────────────────────────────────────────────────

	describe("tail buffer", () => {
		it("appendTail adds lines", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "line 1");
			tree.appendTail("phase-1", "line 2");
			expect(tree.getNode("phase-1")!.tailBuffer).toEqual(["line 1", "line 2"]);
		});

		it("appendTail with warning increments unreadWarnings", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "err", { warning: true });
			expect(tree.getNode("phase-1")!.unreadWarnings).toBe(1);
		});

		it("markTailRead resets unreadWarnings", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "err", { warning: true });
			tree.markTailRead("phase-1");
			expect(tree.getNode("phase-1")!.unreadWarnings).toBe(0);
		});

		// Single-line invariant (dashboard layout contract): the tail buffer is
		// a buffer of DISPLAY LINES. Row-based pane composition breaks if an
		// entry carries a raw newline — the post-\n content re-renders at
		// terminal column 0, flowing into the left tree pane. The model
		// boundary enforces the invariant so no producer can violate it.
		it("appendTail splits multi-line input into one entry per display line", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "╭ $ bash cat << 'EOF' > /tmp/repro.mjs\n// Minimal…(+2378c)");
			const buf = tree.getNode("phase-1")!.tailBuffer;
			expect(buf).toEqual(["╭ $ bash cat << 'EOF' > /tmp/repro.mjs", "// Minimal…(+2378c)"]);
			for (const entry of buf) {
				expect(entry).not.toMatch(/[\r\n]/);
			}
		});

		it("appendTail handles CRLF and lone CR line breaks", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "a\r\nb\rc");
			expect(tree.getNode("phase-1")!.tailBuffer).toEqual(["a", "b", "c"]);
		});

		it("appendTail expands tabs and strips layout-breaking control chars, preserving ANSI", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "x\ty\x08\x0bz \x1b[31mred\x1b[0m");
			const buf = tree.getNode("phase-1")!.tailBuffer;
			expect(buf).toEqual(["x  yz \x1b[31mred\x1b[0m"]);
		});

		it("appendTail drops blank continuation segments but keeps a fully-empty line", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "head\n\n   \ntail");
			expect(tree.getNode("phase-1")!.tailBuffer).toEqual(["head", "tail"]);
			tree.appendTail("phase-1", "");
			expect(tree.getNode("phase-1")!.tailBuffer).toEqual(["head", "tail", ""]);
		});

		it("appendTail counts a warning once even when the entry splits", () => {
			tree.startNode("phase-1", { kind: "leaf" });
			tree.appendTail("phase-1", "err line 1\nerr line 2\nerr line 3", { warning: true });
			expect(tree.getNode("phase-1")!.unreadWarnings).toBe(1);
		});
	});

	// ── Tree queries ───────────────────────────────────────────────────────────

	describe("tree queries", () => {
		beforeEach(() => {
			// Sprint > Task1 > plan, review
			//         Task2 > plan
			tree.startNode("sprint-1", { label: "wfl:run-sprint", kind: "orchestrator" });
			tree.startNode("task-1", { parentId: "sprint-1", label: "▸ wfl:run-task", kind: "orchestrator" });
			tree.startNode("task-1:plan:1", { parentId: "task-1", label: "plan:1", kind: "leaf" });
			tree.startNode("task-1:review-plan:1", { parentId: "task-1", label: "review-plan:1", kind: "leaf" });
			tree.startNode("task-2", { parentId: "sprint-1", label: "▸ wfl:run-task #2", kind: "orchestrator" });
			tree.startNode("task-2:plan:1", { parentId: "task-2", label: "plan:1", kind: "leaf" });
		});

		it("getChildren returns child nodes", () => {
			const children = tree.getChildren("sprint-1");
			expect(children.map((c) => c.id)).toEqual(["task-1", "task-2"]);
		});

		it("getAncestors walks up to root", () => {
			const ancestors = tree.getAncestors("task-1:plan:1");
			expect(ancestors.map((a) => a.id)).toEqual(["task-1", "sprint-1"]);
		});

		it("getDepth returns correct depth", () => {
			expect(tree.getDepth("sprint-1")).toBe(0);
			expect(tree.getDepth("task-1")).toBe(1);
			expect(tree.getDepth("task-1:plan:1")).toBe(2);
		});

		it("getSubtreeUsage aggregates across subtree", () => {
			tree.setNodeUsage("task-1:plan:1", { input: 100, output: 50, cacheRead: 10 });
			tree.setNodeUsage("task-1:review-plan:1", { input: 200, output: 100, cacheRead: 20 });
			const usage = tree.getSubtreeUsage("task-1");
			expect(usage.input).toBe(300);
			expect(usage.output).toBe(150);
		});

		it("getSubtreeProgress counts completed leaves", () => {
			tree.completeNode("task-1:plan:1", "completed");
			tree.completeNode("task-1:review-plan:1", "completed");
			const progressTask1 = tree.getSubtreeProgress("task-1");
			expect(progressTask1).toEqual({ completed: 2, total: 2 });

			const progressSprint = tree.getSubtreeProgress("sprint-1");
			expect(progressSprint).toEqual({ completed: 2, total: 3 }); // task-2:plan still running
		});
	});

	// ── Events ────────────────────────────────────────────────────────────────

	describe("events", () => {
		it("emits 'change' on startNode", () => {
			const handler = vi.fn();
			tree.on("change", handler);
			tree.startNode("node-1", { label: "N1" });
			expect(handler).toHaveBeenCalledWith("node-1");
		});

		it("emits 'tree' on startNode", () => {
			const handler = vi.fn();
			tree.on("tree", handler);
			tree.startNode("node-1", { label: "N1" });
			expect(handler).toHaveBeenCalledWith("node-1");
		});

		it("emits 'tail' on appendTail", () => {
			tree.startNode("node-1", { label: "N1" });
			const handler = vi.fn();
			tree.on("tail", handler);
			tree.appendTail("node-1", "line");
			expect(handler).toHaveBeenCalledWith("node-1");
		});

		it("emits 'preview' on setTurnPreview", () => {
			tree.startNode("node-1", { label: "N1" });
			const handler = vi.fn();
			tree.on("preview", handler);
			tree.setTurnPreview("node-1", "preview text");
			expect(handler).toHaveBeenCalledWith("node-1");
		});
	});

	// ── Cancellation ────────────────────────────────────────────────────────────

	describe("cancellation", () => {
		it("requestCancel transitions running to cancelling", () => {
			tree.startNode("node-1", { label: "N1" });
			const result = tree.requestCancel("node-1");
			expect(result).toBe(true);
			expect(tree.getNode("node-1")!.status).toBe("cancelling");
		});

		it("requestCancel returns false for non-running nodes", () => {
			tree.startNode("node-1", { label: "N1" });
			tree.completeNode("node-1", "completed");
			expect(tree.requestCancel("node-1")).toBe(false);
		});

		it("getAbortSignal returns abort signal", () => {
			tree.startNode("node-1", { label: "N1" });
			const signal = tree.getAbortSignal("node-1");
			expect(signal).toBeDefined();
			expect(signal!.aborted).toBe(false);
			tree.requestCancel("node-1");
			expect(signal!.aborted).toBe(true);
		});
	});

	// ── Reparenting on resume (Bug fix: stale root placement) ────────────────

	describe("reparenting on resume", () => {
		it("reparents a node when startNode is called with a different parentId", () => {
			// First: create task as a root (standalone run-task)
			tree.startNode("task-1", { label: "Task 1", kind: "orchestrator" });
			expect(tree.getRoots().map((r) => r.id)).toEqual(["task-1"]);
			expect(tree.getNode("task-1")!.parentId).toBeNull();

			// Now: create sprint root
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			expect(tree.getRoots().map((r) => r.id)).toEqual(["task-1", "sprint-1"]);

			// Resume task-1 under sprint-1 (simulates sprint taking over)
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1 under sprint", kind: "orchestrator" });
			expect(tree.getNode("task-1")!.parentId).toBe("sprint-1");
			expect(tree.getRoots().map((r) => r.id)).toEqual(["sprint-1"]);
			expect(tree.getNode("sprint-1")!.children).toContain("task-1");
		});

		it("moves a node from parent back to root when parentId changes to null", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
			expect(tree.getNode("task-1")!.parentId).toBe("sprint-1");

			// Resume as root (simulates standalone re-run)
			tree.startNode("task-1", { label: "Task 1 standalone", kind: "orchestrator" });
			expect(tree.getNode("task-1")!.parentId).toBeNull();
			expect(tree.getRoots().map((r) => r.id)).toEqual(["sprint-1", "task-1"]);
			expect(tree.getNode("sprint-1")!.children).not.toContain("task-1");
		});

		it("does not add duplicate children when reparenting", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
			expect(tree.getNode("sprint-1")!.children).toEqual(["task-1"]);

			// Resume with same parentId — no duplicate
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
			expect(tree.getNode("sprint-1")!.children).toEqual(["task-1"]);
		});
	});

	// ── getActiveRoots ──────────────────────────────────────────────────────────

	describe("getActiveRoots", () => {
		it("returns all roots when nothing is running", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			tree.completeNode("sprint-1", "completed");
			tree.startNode("sprint-2", { label: "Sprint 2", kind: "orchestrator" });
			tree.completeNode("sprint-2", "completed");
			// Nothing running — return all so user can inspect past runs
			expect(tree.getActiveRoots().map((r) => r.id)).toEqual(["sprint-1", "sprint-2"]);
		});

		it("filters out fully-terminal roots when a root is running", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
			tree.completeNode("task-1", "completed");
			tree.completeNode("sprint-1", "completed");

			// Sprint 2 is running — sprint 1 should be filtered out
			tree.startNode("sprint-2", { label: "Sprint 2", kind: "orchestrator" });
			const activeRoots = tree.getActiveRoots().map((r) => r.id);
			expect(activeRoots).toContain("sprint-2");
			expect(activeRoots).not.toContain("sprint-1");
		});

		it("keeps running roots in getActiveRoots", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			const activeRoots = tree.getActiveRoots().map((r) => r.id);
			expect(activeRoots).toEqual(["sprint-1"]);
		});
	});

	// ── Children dedup ─────────────────────────────────────────────────────────

	describe("children dedup", () => {
		it("does not add duplicate children on startNode", () => {
			tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
			expect(tree.getNode("sprint-1")!.children).toEqual(["task-1"]);
			// Second startNode for same id — resume path, no duplicate push
			tree.startNode("task-1", { parentId: "sprint-1", label: "Task 1", kind: "orchestrator" });
			expect(tree.getNode("sprint-1")!.children).toEqual(["task-1"]);
		});
	});

	// ── Singleton ──────────────────────────────────────────────────────────────

	describe("singleton", () => {
		it("getOrchestratorTree returns same instance", () => {
			const a = getOrchestratorTree();
			const b = getOrchestratorTree();
			expect(a).toBe(b);
		});
	});
});