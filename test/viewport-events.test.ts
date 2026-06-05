// Unit tests for attachViewportObserver + SessionRegistry.getAggregateUsage.
//
// Verifies the contract that every orchestrator (run-task, fix-bug,
// run-sprint) uses to bubble per-subagent usage up to the registry, where
// the chip strip surfaces the aggregate Σ meter.

import { describe, expect, it } from "vitest";

import { getOrchestratorTree } from "../src/extensions/forgecli/orchestrator-tree.js";
import { SessionRegistry } from "../src/extensions/forgecli/session-registry.js";
import { attachViewportObserver } from "../src/extensions/forgecli/viewport/events.js";

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
		observer.onEvent({
			type: "turn_end",
			message: makeAssistantMessage({ input: 2000, output: 100, cacheRead: 500 }),
		});

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
		observer.onEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			isError: false,
			result: { stdout: "a\nb\n" },
		});
		observer.onEvent({
			type: "tool_execution_end",
			toolCallId: "c2",
			toolName: "bash",
			isError: false,
			result: { stdout: "/" },
		});
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
		// Bracket-led flush-left layout: compact [T<turn>:HH:MM:SS] stamp on the
		// first line only; continuation lines carry NO left margin so the full
		// pane width holds log content.
		expect(turnLines[0]).toMatch(/^╭ \[T1:\d{2}:\d{2}:\d{2}\] \$ bash/);
		expect(turnLines[1]).toMatch(/^│ \$ bash/);
		expect(turnLines[2]).toMatch(/^│ ← bash ok/);
		expect(turnLines[3]).toMatch(/^│ ← bash ok/);
		expect(turnLines[4]).toMatch(/^│ ✱ First reconnaissance/);
		expect(turnLines[5]).toMatch(/^│ » "Now I'll start the plan\."/);
		expect(turnLines[6]).toMatch(/^╰ ⇉ batched 2 tool calls/);
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
			message: makeAssistantMessage({
				input: 1000,
				output: 50,
				text: "doing the plan",
				thinking: "weighing options",
			}),
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
		observer.onEvent({
			type: "tool_execution_start",
			toolCallId: "c",
			toolName: "bash",
			args: { command: "rm -rf /tmp/x" },
		});
		const phase = registry.getSession("T1")?.phases.find((p) => p.role === "plan");
		expect(phase?.unreadWarnings ?? 0).toBeGreaterThan(0);
	});
});

describe("attachViewportObserver — node-per-dispatch telemetry routing", () => {
	// Dashboard MVC contract: each leaf node renders once per dispatch, and
	// the telemetry of THAT dispatch attaches to THAT node. The CART-BUG-003
	// regression: a leaked `running` review-plan:1 node absorbed review-plan:2's
	// live telemetry because resolveNodeId() scanned for the first running
	// role-prefix match instead of using the dispatch node the orchestrator
	// already knows.

	function makeAssistant(input: number, output: number, text: string): any {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input, output, cacheRead: 0 },
		};
	}

	it("routes telemetry to the explicit nodeId even when an older running same-role node exists", () => {
		const tree = getOrchestratorTree();
		const sessionId = "VPN-BUG-001";
		tree.startNode(sessionId, { kind: "orchestrator", label: sessionId });
		// Iteration 1 leaked as running (the defect being defended against).
		tree.startNode(`${sessionId}:review-plan:1`, { parentId: sessionId, label: "review-plan:1" });
		// Iteration 2 is the actual dispatch.
		tree.startNode(`${sessionId}:review-plan:2`, { parentId: sessionId, label: "review-plan:2" });

		const registry = new SessionRegistry();
		registry.startSession(sessionId);
		registry.startPhase(sessionId, "review-plan", 0);
		const observer = attachViewportObserver({
			registry,
			sessionId,
			phaseRole: "review-plan",
			nodeId: `${sessionId}:review-plan:2`,
		});

		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/x" } });
		observer.onEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false, result: "" });
		observer.onEvent({ type: "turn_end", message: makeAssistant(1000, 50, "reviewing the revised plan") });

		const stale = tree.getNode(`${sessionId}:review-plan:1`)!;
		const target = tree.getNode(`${sessionId}:review-plan:2`)!;

		// All live telemetry lands on the dispatch node…
		expect(target.metrics.turn).toBe(1);
		expect(target.metrics.toolCount).toBe(1);
		expect(target.usage).toEqual({ input: 1000, output: 50, cacheRead: 0 });
		expect(target.tailBuffer.length).toBeGreaterThan(0);
		expect(target.lastTurnPreview).toBe("reviewing the revised plan");

		// …and NONE leaks onto the stale running sibling.
		expect(stale.metrics.turn).toBe(0);
		expect(stale.metrics.toolCount).toBe(0);
		expect(stale.usage).toEqual({ input: 0, output: 0, cacheRead: 0 });
		expect(stale.tailBuffer.length).toBe(0);
		expect(stale.lastTurnPreview).toBeUndefined();
	});

	it("routes to the explicit nodeId even after the node reaches a terminal state (late events)", () => {
		const tree = getOrchestratorTree();
		const sessionId = "VPN-BUG-002";
		tree.startNode(sessionId, { kind: "orchestrator", label: sessionId });
		tree.startNode(`${sessionId}:implement:1`, { parentId: sessionId, label: "implement:1" });

		const registry = new SessionRegistry();
		registry.startSession(sessionId);
		registry.startPhase(sessionId, "implement", 0);
		const observer = attachViewportObserver({
			registry,
			sessionId,
			phaseRole: "implement",
			nodeId: `${sessionId}:implement:1`,
		});

		tree.completeNode(`${sessionId}:implement:1`, "completed");
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "turn_end", message: makeAssistant(10, 5, "tail flush") });

		// Attribution stays with the dispatch node — never re-resolved by scan.
		expect(tree.getNode(`${sessionId}:implement:1`)!.metrics.turn).toBe(1);
	});

	it("falls back to the role-prefix scan when nodeId is not provided (legacy callers)", () => {
		const tree = getOrchestratorTree();
		const sessionId = "VPN-BUG-003";
		tree.startNode(sessionId, { kind: "orchestrator", label: sessionId });
		tree.startNode(`${sessionId}:plan:1`, { parentId: sessionId, label: "plan:1" });

		const registry = new SessionRegistry();
		registry.startSession(sessionId);
		registry.startPhase(sessionId, "plan", 0);
		const observer = attachViewportObserver({ registry, sessionId, phaseRole: "plan" });

		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "turn_end", message: makeAssistant(100, 10, "planning") });

		expect(tree.getNode(`${sessionId}:plan:1`)!.metrics.turn).toBe(1);
	});
});

describe("attachViewportObserver — verbatim log entries (view owns display)", () => {
	// Producers play no display role: the activity-log entry carries the FULL
	// tool argument content (heredocs, multi-line scripts) and the full error
	// text, verbatim. Clamping / wrapping / newline handling happen in the
	// views (dashboard: toDisplayLines + wrapLine + ctrl+o clamp toggle).

	it("heredoc bash command stores the full command in the log entry, untruncated", () => {
		const tree = getOrchestratorTree();
		const sessionId = "VPN-HEREDOC-1";
		tree.startNode(sessionId, { kind: "orchestrator", label: sessionId });
		tree.startNode(`${sessionId}:triage:1`, { parentId: sessionId, label: "triage:1" });

		const registry = new SessionRegistry();
		registry.startSession(sessionId);
		registry.startPhase(sessionId, "triage", 0);
		const observer = attachViewportObserver({
			registry,
			sessionId,
			phaseRole: "triage",
			nodeId: `${sessionId}:triage:1`,
		});

		const heredoc = `cat << 'EOF' > /tmp/triage-repro.mjs\n// Minimal reproduction of the exportMarkdown filter defect\nimport { exportMarkdown } from "./src/store/graph.js";\nEOF`;
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: heredoc } });
		observer.onEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			isError: true,
			result: { content: [{ type: "text", text: "Graph nodes: ['Alpha']\n\nnode:internal/modules/esm/resolve error" }] },
		});

		const treeBuf = tree.getNode(`${sessionId}:triage:1`)!.tailBuffer;
		const cmdEntry = treeBuf.find((l) => l.includes("$ bash"));
		expect(cmdEntry, "tool-start entry must exist").toBeDefined();
		// Full content, verbatim — no 60-char hint truncation, newlines intact.
		expect(cmdEntry).toContain(heredoc);

		const errEntry = treeBuf.find((l) => l.includes("⚠ bash failed"));
		expect(errEntry, "tool-failure entry must exist").toBeDefined();
		// Full error text — not clipped to a 160-char first line.
		expect(errEntry).toContain("node:internal/modules/esm/resolve error");

		// Registry sink stores the same verbatim entries.
		const regCmd = registry.getTailLines(sessionId, "triage").find((l) => l.includes("$ bash"));
		expect(regCmd).toContain(heredoc);
	});

	it("status-line hint (lastTool) stays short even when the command is huge", () => {
		const registry = new SessionRegistry();
		registry.startSession("VPN-HEREDOC-2");
		registry.startPhase("VPN-HEREDOC-2", "triage", 0);
		const observer = attachViewportObserver({ registry, sessionId: "VPN-HEREDOC-2", phaseRole: "triage" });
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: `echo start\n${"y".repeat(500)}` },
		});
		// setStatus is a single-line UI surface — the hint contract (≤60c + marker) holds.
		expect(observer.state.lastTool.length).toBeLessThan(90);
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
