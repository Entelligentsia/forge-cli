// Unit tests for attachViewportObserver + SessionRegistry.getAggregateUsage.
//
// Verifies the contract that every orchestrator (run-task, fix-bug,
// run-sprint) uses to bubble per-subagent usage up to the registry, where
// the chip strip surfaces the aggregate Σ meter.

import { describe, expect, it } from "vitest";

import { SessionRegistry } from "../src/extensions/forgecli/session-registry.js";
import { attachViewportObserver } from "../src/extensions/forgecli/viewport-events.js";

function makeAssistantMessage(opts: {
	input: number;
	output: number;
	cacheRead?: number;
	text?: string;
	thinking?: string;
}): any {
	const content: any[] = [];
	if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
	if (opts.text) content.push({ type: "text", text: opts.text });
	return {
		role: "assistant",
		content,
		usage: { input: opts.input, output: opts.output, cacheRead: opts.cacheRead ?? 0 },
	};
}

describe("attachViewportObserver", () => {
	function bootstrap() {
		const registry = new SessionRegistry();
		registry.startSession("T1");
		registry.startPhase("T1", "plan", 0);
		const observer = attachViewportObserver({
			registry,
			sessionId: "T1",
			phaseRole: "plan",
			beginHeader: "─── phase 1/7 plan begin · T1 ───",
		});
		return { registry, observer };
	}

	it("emits begin header into tail buffer", () => {
		const { registry } = bootstrap();
		const lines = registry.getTailLines("T1", "plan");
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("─── phase 1/7 plan begin · T1 ───");
	});

	it("accumulates usage across turn_end events and pushes to registry", () => {
		const { registry, observer } = bootstrap();

		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "turn_end", message: makeAssistantMessage({ input: 1000, output: 50 }) });
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "turn_end", message: makeAssistantMessage({ input: 2000, output: 100, cacheRead: 500 }) });

		expect(observer.state.turn).toBe(2);
		expect(observer.state.cumUsage).toEqual({ input: 3000, output: 150, cacheRead: 500 });

		const phase = registry.getSession("T1")?.phases.find((p) => p.role === "plan");
		expect(phase?.usage).toEqual({ input: 3000, output: 150, cacheRead: 500 });
	});

	it("renders a turn block with ╭ / │ / ╰ connectors", () => {
		const { registry, observer } = bootstrap();
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		observer.onEvent({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "pwd" } });
		observer.onEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: { stdout: "a\nb\n" } });
		observer.onEvent({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", isError: false, result: { stdout: "/" } });
		observer.onEvent({
			type: "turn_end",
			message: makeAssistantMessage({
				input: 1000,
				output: 50,
				thinking: "First reconnaissance",
				text: "Now I'll start the plan.",
			}),
		});

		const lines = registry.getTailLines("T1", "plan");
		// 1 header + 4 tool lines + 3 closing lines (thinking, preview, batch)
		expect(lines.length).toBe(8);
		const turnLines = lines.slice(1); // drop header
		expect(turnLines[0]).toMatch(/ ╭ \$ bash/);
		expect(turnLines[1]).toMatch(/ │ \$ bash/);
		expect(turnLines[2]).toMatch(/ │ ← bash ok/);
		expect(turnLines[3]).toMatch(/ │ ← bash ok/);
		expect(turnLines[4]).toMatch(/ │ ✱ First reconnaissance/);
		expect(turnLines[5]).toMatch(/ │ » "Now I'll start the plan\."/);
		expect(turnLines[6]).toMatch(/ ╰ ⇉ batched 2 tool calls/);
	});

	it("calls afterEach once per handled event", () => {
		const registry = new SessionRegistry();
		registry.startSession("T2");
		registry.startPhase("T2", "implement", 0);
		let calls = 0;
		const observer = attachViewportObserver({
			registry,
			sessionId: "T2",
			phaseRole: "implement",
			afterEach: () => calls++,
		});
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { path: "/x" } });
		observer.onEvent({ type: "tool_execution_end", toolCallId: "c", toolName: "read", isError: false, result: "" });
		expect(calls).toBe(3);
	});

	it("emits a global turn event on every turn_end with attribution", () => {
		const { registry, observer } = bootstrap();
		const events: any[] = [];
		registry.on("turn", (e) => events.push(e));

		observer.onEvent({ type: "turn_start" });
		observer.onEvent({
			type: "turn_end",
			message: makeAssistantMessage({ input: 1000, output: 50, text: "doing the plan", thinking: "weighing options" }),
		});

		expect(events.length).toBe(1);
		expect(events[0]).toMatchObject({
			sessionId: "T1",
			phaseRole: "plan",
			displayRole: "plan",
			turn: 1,
			preview: "doing the plan",
			thinking: "weighing options",
			deltaUsage: { input: 1000, output: 50, cacheRead: 0 },
			cumUsage: { input: 1000, output: 50, cacheRead: 0 },
		});
		expect(typeof events[0].timestamp).toBe("number");

		// Second turn — deltaUsage is per-turn, cumUsage accumulates.
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({
			type: "turn_end",
			message: makeAssistantMessage({ input: 500, output: 25, text: "step 2" }),
		});
		expect(events[1].deltaUsage).toEqual({ input: 500, output: 25, cacheRead: 0 });
		expect(events[1].cumUsage).toEqual({ input: 1500, output: 75, cacheRead: 0 });
	});

	it("honours displayRole when provided", () => {
		const registry = new SessionRegistry();
		registry.startSession("S1:ceremony");
		registry.startPhase("S1:ceremony", "ceremony", 0);
		const observer = attachViewportObserver({
			registry,
			sessionId: "S1:ceremony",
			phaseRole: "ceremony",
			displayRole: "sprint-architect",
		});
		const events: any[] = [];
		registry.on("turn", (e) => events.push(e));

		observer.onEvent({ type: "turn_start" });
		observer.onEvent({
			type: "turn_end",
			message: makeAssistantMessage({ input: 100, output: 10, text: "hi" }),
		});
		expect(events[0].displayRole).toBe("sprint-architect");
	});

	it("flags risky bash commands with warning", () => {
		const { registry, observer } = bootstrap();
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "rm -rf /tmp/x" } });
		const phase = registry.getSession("T1")?.phases.find((p) => p.role === "plan");
		expect(phase?.unreadWarnings ?? 0).toBeGreaterThan(0);
	});
});

describe("SessionRegistry.getAggregateUsage", () => {
	it("returns zeros when no sessions", () => {
		const reg = new SessionRegistry();
		expect(reg.getAggregateUsage()).toEqual({ input: 0, output: 0, cacheRead: 0 });
	});

	it("sums phase.usage across all sessions and phases", () => {
		const reg = new SessionRegistry();
		reg.startSession("A");
		reg.startPhase("A", "plan", 0);
		reg.setPhaseUsage("A", "plan", { input: 1000, output: 50, cacheRead: 200 });
		reg.startPhase("A", "implement", 1);
		reg.setPhaseUsage("A", "implement", { input: 5000, output: 300, cacheRead: 1000 });

		reg.startSession("B");
		reg.startPhase("B", "plan", 0);
		reg.setPhaseUsage("B", "plan", { input: 2000, output: 100, cacheRead: 0 });

		expect(reg.getAggregateUsage()).toEqual({ input: 8000, output: 450, cacheRead: 1200 });
	});

	it("ignores phases with no usage data", () => {
		const reg = new SessionRegistry();
		reg.startSession("A");
		reg.startPhase("A", "plan", 0);
		// no setPhaseUsage call
		expect(reg.getAggregateUsage()).toEqual({ input: 0, output: 0, cacheRead: 0 });
	});

	it("recordTurnEvent appends to the ring buffer and emits 'turn'", () => {
		const reg = new SessionRegistry();
		let fired = 0;
		reg.on("turn", () => fired++);
		reg.recordTurnEvent({
			sessionId: "A",
			phaseRole: "plan",
			displayRole: "plan",
			turn: 1,
			preview: "a",
			thinking: "",
			deltaUsage: { input: 100, output: 10, cacheRead: 0 },
			cumUsage: { input: 100, output: 10, cacheRead: 0 },
			timestamp: 1,
		});
		reg.recordTurnEvent({
			sessionId: "B",
			phaseRole: "implement",
			displayRole: "implement",
			turn: 1,
			preview: "b",
			thinking: "",
			deltaUsage: { input: 200, output: 20, cacheRead: 0 },
			cumUsage: { input: 200, output: 20, cacheRead: 0 },
			timestamp: 2,
		});
		expect(fired).toBe(2);

		// Latest = newest; recent = newest first.
		expect(reg.getLatestTurnEvent()?.sessionId).toBe("B");
		const recent = reg.getRecentTurnEvents(10);
		expect(recent[0].sessionId).toBe("B");
		expect(recent[1].sessionId).toBe("A");
	});

	it("ring buffer caps at MAX_TURN_LOG (50)", () => {
		const reg = new SessionRegistry();
		for (let i = 0; i < 75; i++) {
			reg.recordTurnEvent({
				sessionId: `S${i}`,
				phaseRole: "plan",
				displayRole: "plan",
				turn: 1,
				preview: "",
				thinking: "",
				deltaUsage: { input: 1, output: 1, cacheRead: 0 },
				cumUsage: { input: 1, output: 1, cacheRead: 0 },
				timestamp: i,
			});
		}
		const recent = reg.getRecentTurnEvents(100);
		expect(recent.length).toBe(50);
		// Newest (i=74) should be first.
		expect(recent[0].sessionId).toBe("S74");
		expect(recent[49].sessionId).toBe("S25");
	});

	it("emits both tail and change events on setPhaseUsage", () => {
		const reg = new SessionRegistry();
		reg.startSession("A");
		reg.startPhase("A", "plan", 0);
		let tail = 0;
		let change = 0;
		reg.on("tail", () => tail++);
		reg.on("change", () => change++);
		reg.setPhaseUsage("A", "plan", { input: 1, output: 2, cacheRead: 3 });
		expect(tail).toBe(1);
		expect(change).toBe(1);
	});
});
