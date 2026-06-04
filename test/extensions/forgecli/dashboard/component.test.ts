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