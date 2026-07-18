// dashboard/ask-overlay.test.ts — the ask_user overlay path (Plan 16 Slice 3).
//
// A subagent's forge_ask_user, marshalled via AskBroker while the dashboard
// overlay is mounted, must render IN the overlay (pi's editor-slot dialogs
// render beneath a full-terminal overlay) and resolve on input — a dismissal
// resolving { ok: false }, never the default (forge#114, Iron Law 7).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { OrchestratorTree } from "../../../../src/extensions/forgecli/orchestrator-tree.js";
import { DashboardController, DashboardComponent } from "../../../../src/extensions/forgecli/dashboard/component.js";
import { AskBroker } from "../../../../src/extensions/forgecli/ask-broker.js";

// Raw key encodings (pi-tui keys.js): enter=13, backspace=127, arrows CSI.
const ENTER = "\r";
const BACKSPACE = "\x7f";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

const mockTheme: Theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	dim: (t: string) => t,
} as unknown as Theme;

function setup() {
	const tree = new OrchestratorTree();
	tree.startNode("sprint-1", { label: "Sprint 1", kind: "orchestrator" });
	const controller = new DashboardController(tree);
	const mockTui = { requestRender: vi.fn(), terminal: { rows: 24 } } as any;
	const component = new DashboardComponent(controller, mockTui, mockTheme, vi.fn());
	return { tree, controller, component };
}

describe("dashboard ask_user overlay", () => {
	beforeEach(() => AskBroker._resetForTest());
	afterEach(() => AskBroker._resetForTest());

	it("component registers the overlay renderer on construct and clears it on dispose", () => {
		expect(AskBroker.hasOverlayRenderer()).toBe(false);
		const { component } = setup();
		expect(AskBroker.hasOverlayRenderer()).toBe(true);
		component.dispose();
		expect(AskBroker.hasOverlayRenderer()).toBe(false);
	});

	it("confirm: 'y' resolves Y, 'n' resolves N", async () => {
		const { controller, component } = setup();
		const pY = controller.presentAsk({ question: "Proceed?", type: "confirm" });
		expect(controller.getPendingAsk()).not.toBeNull();
		controller.handleInput("y");
		expect(await pY).toEqual({ ok: true, value: "Y" });
		expect(controller.getPendingAsk()).toBeNull();

		const pN = controller.presentAsk({ question: "Proceed?", type: "confirm" });
		controller.handleInput("n");
		expect(await pN).toEqual({ ok: true, value: "N" });
		component.dispose();
	});

	it("choice: seeds cursor at the default option, ↑↓ move, Enter selects", async () => {
		const { controller, component } = setup();
		const p = controller.presentAsk({
			question: "Ratify?",
			type: "choice",
			options: ["Ratify as-is", "Revise", "Abort"],
			default: "Revise", // index 1
		});
		controller.handleInput(DOWN); // 1 → 2 (Abort)
		controller.handleInput(UP); // 2 → 1 (Revise)
		controller.handleInput(UP); // 1 → 0 (Ratify as-is)
		controller.handleInput(ENTER);
		expect(await p).toEqual({ ok: true, value: "Ratify as-is" });
		component.dispose();
	});

	it("text: typing + backspace, Enter submits the buffer", async () => {
		const { controller, component } = setup();
		const p = controller.presentAsk({ question: "Name?", type: "text" });
		for (const ch of "hio") controller.handleInput(ch);
		controller.handleInput(BACKSPACE); // "hi"
		controller.handleInput(ENTER);
		expect(await p).toEqual({ ok: true, value: "hi" });
		component.dispose();
	});

	it("dispose while a prompt is pending resolves it as a non-answer (never the default)", async () => {
		const { component, controller } = setup();
		const p = controller.presentAsk({ question: "Ratify?", type: "choice", options: ["Ratify as-is"], default: "Ratify as-is" });
		component.dispose(); // closes the overlay mid-prompt
		const r = await p;
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/cancelled|closed/i);
	});

	it("a second prompt while one is active is refused immediately (serialisation guard)", async () => {
		const { controller, component } = setup();
		const p1 = controller.presentAsk({ question: "first", type: "confirm" });
		const r2 = await controller.presentAsk({ question: "second", type: "confirm" });
		expect(r2.ok).toBe(false);
		controller.handleInput("y");
		expect(await p1).toEqual({ ok: true, value: "Y" });
		component.dispose();
	});

	it("render() paints the question and options over the dashboard while pending", () => {
		const { controller, component } = setup();
		void controller.presentAsk({ question: "Ratify the token map?", type: "choice", options: ["Ratify as-is", "Revise"] });
		const out = component.render(80).join("\n");
		expect(out).toContain("Ratify the token map?");
		expect(out).toContain("Ratify as-is");
		expect(out).toContain("Revise");
		component.dispose();
	});

	it("end-to-end: AskBroker.ask routes to the overlay and resolves on input", async () => {
		const { controller, component } = setup();
		// No bound UI — the overlay renderer alone must satisfy AskBroker.ask.
		const p = AskBroker.ask({ question: "Proceed?", type: "confirm" });
		// Let the tail chain run doRender → controller.presentAsk.
		await new Promise((r) => setTimeout(r, 0));
		expect(controller.getPendingAsk()).not.toBeNull();
		controller.handleInput("y");
		expect(await p).toEqual({ ok: true, value: "Y" });
		component.dispose();
	});
});
