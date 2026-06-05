// Read-only dashboard tests — replay mode guard (transcript-replay feature).
//
// Coverage:
//   - readOnly controller: `x` never enters cancel mode (cancelTargetId stays
//     null) even on a "running" node
//   - isReadOnly() flag
//   - footer hint drops `x cancel` and marks replay (read-only)
//   - default (live) controller still enters cancel mode — guard is scoped

import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DashboardComponent, DashboardController } from "../../../src/extensions/forgecli/dashboard/component.js";
import { OrchestratorTree } from "../../../src/extensions/forgecli/orchestrator-tree.js";

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

function buildTree(opts: { running?: boolean } = {}): OrchestratorTree {
	const tree = new OrchestratorTree();
	tree.startNode("RUN-1", { kind: "orchestrator", label: "RUN-1" });
	tree.startNode("RUN-1:plan:1", { parentId: "RUN-1", kind: "leaf", label: "plan#1" });
	if (!opts.running) {
		tree.completeNode("RUN-1:plan:1", "completed");
		tree.completeNode("RUN-1", "completed");
	}
	return tree;
}

function buildComponent(controller: DashboardController): DashboardComponent {
	const tui = { requestRender: () => undefined, terminal: { rows: 40 } } as never;
	return new DashboardComponent(controller, tui, mockTheme, () => undefined);
}

describe("read-only dashboard (replay)", () => {
	it("x is a no-op in readOnly mode — cancelTargetId stays null", () => {
		const controller = new DashboardController(buildTree({ running: true }), undefined, { readOnly: true });
		expect(controller.isReadOnly()).toBe(true);
		controller.handleInput("x");
		expect(controller.getState().cancelTargetId).toBeNull();
		controller.dispose();
	});

	it("x still works on a live controller — guard is scoped to readOnly", () => {
		const controller = new DashboardController(buildTree({ running: true }));
		expect(controller.isReadOnly()).toBe(false);
		controller.handleInput("x");
		expect(controller.getState().cancelTargetId).not.toBeNull();
		controller.dispose();
	});

	it("footer marks replay (read-only) and drops x cancel", () => {
		const controller = new DashboardController(buildTree(), undefined, { readOnly: true });
		const component = buildComponent(controller);
		const joined = component.render(120).join("\n");
		expect(joined).toContain("replay (read-only)");
		expect(joined).not.toContain("x cancel");
		component.dispose();
	});

	it("live footer keeps x cancel", () => {
		const controller = new DashboardController(buildTree());
		const component = buildComponent(controller);
		const joined = component.render(120).join("\n");
		expect(joined).toContain("x cancel");
		expect(joined).not.toContain("replay (read-only)");
		component.dispose();
	});
});
