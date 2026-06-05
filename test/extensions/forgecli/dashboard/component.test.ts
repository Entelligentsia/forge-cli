// dashboard/component.test.ts — Unit tests for DashboardComponent and DashboardController.
//
// Verifies IL3 (Focusable), IL7 (timer unmount-safety), and spinner theming (IL1).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OrchestratorTree } from "../../../../src/extensions/forgecli/orchestrator-tree.js";
import { DashboardController, DashboardComponent } from "../../../../src/extensions/forgecli/dashboard/component.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Mock theme: strips all ANSI codes so assertions match plain text.
const mockTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

// ── Focusable conformance (IL3) ─────────────────────────────────────────────

describe("DashboardComponent Focusable conformance", () => {
	it("implements Focusable with focused: boolean = false", () => {
		// DashboardComponent must implement Focusable so that pi-tui routes
		// arrow keys and escape to the overlay. (Iron Law 3, config-TUI commit 07e886f.)
		const tree = new OrchestratorTree();
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const controller = new DashboardController(tree);

		// Create component without a real TUI — we just need to verify the interface.
		const mockTui = { requestRender: vi.fn(), terminal: { rows: 24 } } as any;
		const mockDone = vi.fn();
		const component = new DashboardComponent(controller, mockTui, mockTheme, mockDone);

		// IL3: component must have focused: boolean = false.
		expect(component.focused).toBe(false);
		expect(typeof component.focused).toBe("boolean");
		expect("focused" in component).toBe(true);

		// pi-tui sets focused to true when the overlay is active.
		component.focused = true;
		expect(component.focused).toBe(true);

		controller.dispose();
	});
});

// ── Row integrity: no rendered row may contain a raw newline ────────────────

describe("DashboardComponent row integrity (single-line invariant, layer 2)", () => {
	it("render() emits no row containing \\n or \\r even when node data is multi-line", () => {
		// Layer 1 (appendTail) normally guarantees single-line tail entries;
		// this exercises the view-layer guard (IL2-analog second layer) by
		// force-feeding multi-line strings past the model boundary.
		const tree = new OrchestratorTree();
		tree.startNode("BUG-1", { label: "fix-bug BUG-1", kind: "orchestrator" });
		tree.startNode("BUG-1:triage:1", {
			parentId: "BUG-1",
			label: "triage:1",
			kind: "leaf",
			promptPreview: "first prompt line\nsecond prompt line",
		});
		const node = tree.getNode("BUG-1:triage:1")!;
		// Simulate legacy/foreign data that bypassed appendTail.
		node.tailBuffer.push("[triage 06:44:22 t18] ╭ $ bash cat << 'EOF' > /tmp/repro.mjs\n// Minimal…(+2378c)");
		node.tailBuffer.push("short\nbroken");
		node.outcomePreview = "outcome line 1\noutcome line 2";

		const controller = new DashboardController(tree);
		const mockTui = { requestRender: vi.fn(), terminal: { rows: 24 } } as any;
		const component = new DashboardComponent(controller, mockTui, mockTheme, vi.fn());

		// Select the leaf so the detail panel renders its tail buffer.
		controller.getState().cursorId = "BUG-1:triage:1";

		for (const width of [80, 120, 200]) {
			const rows = component.render(width);
			for (const row of rows) {
				expect(row, `row must not contain a raw line break: ${JSON.stringify(row)}`).not.toMatch(/[\r\n]/);
			}
		}

		controller.dispose();
	});
});

// ── Timer unmount-safety (IL7) ──────────────────────────────────────────────

describe("DashboardController timer unmount-safety", () => {
	let tree: OrchestratorTree;

	beforeEach(() => {
		tree = new OrchestratorTree();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not call onInvalidate after dispose (controller)", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const invalidateSpy = vi.fn();
		const controller = new DashboardController(tree);
		controller.setOnInvalidate(invalidateSpy);

		// Advance past the refresh interval — invalidation should fire.
		vi.advanceTimersByTime(1100);
		expect(invalidateSpy).toHaveBeenCalled();
		invalidateSpy.mockClear();

		// Dispose the controller.
		controller.dispose();

		// Advance past another refresh interval — no invalidation should fire.
		vi.advanceTimersByTime(1100);
		expect(invalidateSpy).not.toHaveBeenCalled();
	});

	it("stops the refresh timer when no running nodes remain (controller)", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const invalidateSpy = vi.fn();
		const controller = new DashboardController(tree);
		controller.setOnInvalidate(invalidateSpy);

		// Verify timer is running.
		vi.advanceTimersByTime(1100);
		expect(invalidateSpy).toHaveBeenCalled();
		invalidateSpy.mockClear();

		// Complete all nodes — controller should stop the timer after one final render.
		tree.completeNode("sprint-1", "completed");
		vi.advanceTimersByTime(1100);
		// At least one invalidation from the "no running nodes" check.
		expect(invalidateSpy).toHaveBeenCalled();
		invalidateSpy.mockClear();

		// After timer stops, further advances should not trigger invalidation.
		vi.advanceTimersByTime(5000);
		expect(invalidateSpy).not.toHaveBeenCalled();

		controller.dispose();
	});
});

// ── Dispose idempotence ─────────────────────────────────────────────────────

describe("DashboardController dispose", () => {
	it("can be called multiple times without error", () => {
		const tree = new OrchestratorTree();
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const controller = new DashboardController(tree);

		controller.dispose();
		// Second dispose should not throw.
		expect(() => controller.dispose()).not.toThrow();
	});
});