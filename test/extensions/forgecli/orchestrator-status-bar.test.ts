// orchestrator-status-bar.test.ts — Unit tests for OrchestratorStatusBar.
//
// Verifies IL7 (timer unmount-safety) and IL1 (spinner theming).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OrchestratorStatusBar } from "../../../src/extensions/forgecli/tui/orchestrator-status-bar.js";
import { OrchestratorTree } from "../../../src/extensions/forgecli/orchestrator-tree.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Mock theme: strips all ANSI codes so assertions match plain text.
const mockTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

// ── Timer unmount-safety (IL7) ──────────────────────────────────────────────

describe("OrchestratorStatusBar timer unmount-safety", () => {
	let tree: OrchestratorTree;

	beforeEach(() => {
		tree = new OrchestratorTree();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not call invalidationCb after dispose", () => {
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const bar = new OrchestratorStatusBar(tree, mockTheme);
		const invalidateSpy = vi.fn();
		bar.setInvalidationCallback(invalidateSpy);

		// Advance past the spinner interval — invalidation should fire.
		vi.advanceTimersByTime(200);
		expect(invalidateSpy).toHaveBeenCalled();
		invalidateSpy.mockClear();

		// Dispose the bar.
		bar.dispose();

		// Advance past another interval — no invalidation should fire.
		vi.advanceTimersByTime(2000);
		expect(invalidateSpy).not.toHaveBeenCalled();
	});

	it("restarts spinner timer when roots become active after initial idle", () => {
		// Simulate the real bug: bar is constructed before any roots exist,
		// then roots are added via tree events. The timer should restart.
		vi.useFakeTimers();
		const tree = new OrchestratorTree();
		const bar = new OrchestratorStatusBar(tree, mockTheme);
		const invalidateSpy = vi.fn();
		bar.setInvalidationCallback(invalidateSpy);

		// No roots yet — timer should NOT be running (anyActive check in ensureSpinnerTimer).
		vi.advanceTimersByTime(500);
		expect(invalidateSpy).not.toHaveBeenCalled(); // no invalidation

		// Now add a running root — tree emits "change", which calls ensureSpinnerTimer.
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });

		// The onChange callback should have restarted the timer.
		vi.advanceTimersByTime(200);
		expect(invalidateSpy).toHaveBeenCalled();

		// Verify the spinner index advances.
		const idx0 = (bar as any).spinnerIdx;
		vi.advanceTimersByTime(200);
		const idx1 = (bar as any).spinnerIdx;
		expect(idx1).not.toBe(idx0); // spinner is animating

		bar.dispose();
		vi.useRealTimers();
	});
});

// ── Dispose idempotence ─────────────────────────────────────────────────────

describe("OrchestratorStatusBar dispose", () => {
	it("can be called multiple times without error", () => {
		const tree = new OrchestratorTree();
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const bar = new OrchestratorStatusBar(tree, mockTheme);
		bar.setInvalidationCallback(vi.fn());

		bar.dispose();
		// Second dispose should not throw.
		expect(() => bar.dispose()).not.toThrow();
	});

	it("does not call invalidationCb from tree events after dispose", () => {
		const tree = new OrchestratorTree();
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const bar = new OrchestratorStatusBar(tree, mockTheme);
		const invalidateSpy = vi.fn();
		bar.setInvalidationCallback(invalidateSpy);

		bar.dispose();

		// Model events after dispose should not trigger invalidation.
		tree.completeNode("sprint-1", "completed");
		expect(invalidateSpy).not.toHaveBeenCalled();
	});
});

// ── Spinner theming (IL1) ───────────────────────────────────────────────────

describe("OrchestratorStatusBar spinner theming", () => {
	it("renders spinner characters through theme.fg with accent colour", () => {
		vi.useFakeTimers();
		const tree = new OrchestratorTree();
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });

		let lastSpinnerColor = "";
		const spyTheme: Theme = {
			...mockTheme,
			fg: (color: string, text: string) => {
				// Track the colour used for spinner characters.
				if (["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].includes(text)) {
					lastSpinnerColor = color;
				}
				return text;
			},
		} as unknown as Theme;

		const bar = new OrchestratorStatusBar(tree, spyTheme);
		bar.setInvalidationCallback(vi.fn());

		// Advance to trigger at least one spinner tick.
		vi.advanceTimersByTime(150);

		// Render the bar.
		const lines = bar.render(120);
		expect(lines.length).toBeGreaterThan(0);

		// The spinner character should have been themed with "accent" colour.
		expect(lastSpinnerColor).toBe("accent");

		bar.dispose();
		vi.useRealTimers();
	});
});

// ── Render output ───────────────────────────────────────────────────────────

describe("OrchestratorStatusBar render", () => {
	it("returns empty array when no roots are active", () => {
		const tree = new OrchestratorTree();
		const bar = new OrchestratorStatusBar(tree, mockTheme);
		bar.setInvalidationCallback(vi.fn());

		const lines = bar.render(120);
		expect(lines).toEqual([]);

		bar.dispose();
	});

	it("renders a non-empty line when a root is active", () => {
		const tree = new OrchestratorTree();
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
		const bar = new OrchestratorStatusBar(tree, mockTheme);
		bar.setInvalidationCallback(vi.fn());

		const lines = bar.render(120);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]!).toContain("[Sprint 1]");

		bar.dispose();
	});

	it("shows outline ○ when inactive and filled ● when active, coloured by status", () => {
		const tree = new OrchestratorTree();
		tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });

		const calls: Array<{ color: string; text: string }> = [];
		const spyTheme: Theme = {
			...mockTheme,
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
		} as unknown as Theme;

		const bar = new OrchestratorStatusBar(tree, spyTheme);
		bar.setInvalidationCallback(vi.fn());

		// Running (inactive): ○ with accent colour
		bar.render(120);
		const inactiveRunning = calls.find((c) => c.text === "○");
		expect(inactiveRunning).toBeDefined();
		expect(inactiveRunning!.color).toBe("accent");
		calls.length = 0;

		// Running (active): ● with accent colour
		bar.setActive(true);
		bar.render(120);
		const activeRunning = calls.find((c) => c.text === "●");
		expect(activeRunning).toBeDefined();
		expect(activeRunning!.color).toBe("accent");
		calls.length = 0;

		// Completed (inactive): ○ with success (green) colour
		bar.setActive(false);
		tree.completeNode("sprint-1", "completed");
		bar.render(120);
		const inactiveCompleted = calls.find((c) => c.text === "○");
		expect(inactiveCompleted).toBeDefined();
		expect(inactiveCompleted!.color).toBe("success");
		calls.length = 0;

		// Completed (active): ● with success colour
		bar.setActive(true);
		bar.render(120);
		const activeCompleted = calls.find((c) => c.text === "●");
		expect(activeCompleted).toBeDefined();
		expect(activeCompleted!.color).toBe("success");

		bar.dispose();
	});
});