// Unit tests for forge-commands module — FORGE-S16-T04.
//
// Coverage:
//   1. Registration — all 5 commands + before_agent_start handler registered.
//   2. Outside-project no-op — health/config/update/status emit warning notify.
//   3. Inside-project delegation — health reads commands/health.md and sends body.
//   4. /forge:ask Tomoshibi gate — handler sets pending; before_agent_start
//      returns { systemPrompt }; second invocation returns undefined.
//   5. /forge:update stub — emits info notify, does not delegate.
//   6. /forge:status ENOENT fallback — emits fallback notify when status.md absent.

import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test__, registerForgeCommands } from "../../../src/extensions/forgecli/forge-commands.js";

type Handler = (args: string, ctx: FakeCtx) => Promise<void>;
type BeforeAgentStartHandler = () => Promise<{ systemPrompt?: string } | undefined>;

interface FakeCtx {
	ui: {
		notify: ReturnType<typeof vi.fn>;
	};
	sendUserMessage: ReturnType<typeof vi.fn>;
}

interface FakePi {
	registerCommand: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	commands: Map<string, Handler>;
	beforeAgentStart: BeforeAgentStartHandler | null;
}

function makePi(): FakePi {
	const pi: FakePi = {
		registerCommand: vi.fn(),
		on: vi.fn(),
		sendUserMessage: vi.fn(),
		commands: new Map(),
		beforeAgentStart: null,
	};
	pi.registerCommand.mockImplementation((name: string, opts: { handler: Handler }) => {
		pi.commands.set(name, opts.handler);
	});
	pi.on.mockImplementation((event: string, handler: BeforeAgentStartHandler) => {
		if (event === "before_agent_start") pi.beforeAgentStart = handler;
	});
	return pi;
}

function makeCtx(): FakeCtx {
	return {
		ui: { notify: vi.fn() },
		sendUserMessage: vi.fn(),
	};
}

beforeEach(() => {
	__test__.resetTomoshibiState();
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerForgeCommands", () => {
	it("registers all five /forge:* commands and the before_agent_start handler", () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });

		expect(pi.registerCommand).toHaveBeenCalledTimes(5);
		const names = Array.from(pi.commands.keys()).sort();
		expect(names).toEqual(["forge:ask", "forge:config", "forge:health", "forge:status", "forge:update"]);
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(pi.beforeAgentStart).not.toBeNull();
	});
});

describe("outside-project no-op (Q14)", () => {
	const cases = ["health", "config", "update", "status"] as const;
	for (const cmd of cases) {
		it(`/forge:${cmd} emits warning notify and skips delegation when forgeRoot is null`, async () => {
			const pi = makePi();
			registerForgeCommands(pi as never, { forgeRoot: null, promptsRoot: "/fake/prompts" });
			const ctx = makeCtx();
			const handler = pi.commands.get(`forge:${cmd}`);
			expect(handler).toBeDefined();
			await handler!("", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				`forge:${cmd} — no Forge project at cwd; run /forge:init to bootstrap`,
				"warning",
			);
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});
	}
});

describe("inside-project delegation", () => {
	it("/forge:health reads commands/health.md and sends body as user message", async () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });
		const ctx = makeCtx();
		const body = "# /forge:health\n\nDo health checks.";
		const readSpy = vi.spyOn(fs, "readFile").mockResolvedValue(body);

		const handler = pi.commands.get("forge:health");
		await handler!("--path /tmp/proj", ctx);

		expect(readSpy).toHaveBeenCalledWith("/fake/forge/commands/health.md", "utf8");
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const sent = pi.sendUserMessage.mock.calls[0]?.[0] as string;
		expect(sent).toContain("/forge:health --path /tmp/proj");
		expect(sent).toContain(body);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("/forge:ask Tomoshibi injection", () => {
	it("sets the gate, sends user message, and injects systemPrompt on next agent_start", async () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });
		const ctx = makeCtx();
		const tomoshibi = "# Tomoshibi\n\nYou are Forge's concierge.";
		const readSpy = vi.spyOn(fs, "readFile").mockResolvedValue(tomoshibi);

		// First invocation: set the gate
		const ask = pi.commands.get("forge:ask");
		await ask!("active sprint?", ctx);
		expect(__test__.getTomoshibiPending()).toBe(true);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("active sprint?");

		// before_agent_start fires: returns systemPrompt and clears the gate
		const result = await pi.beforeAgentStart!();
		expect(readSpy).toHaveBeenCalledWith("/fake/prompts/tomoshibi.md", "utf8");
		expect(result).toEqual({ systemPrompt: tomoshibi });
		expect(__test__.getTomoshibiPending()).toBe(false);

		// Second before_agent_start (no /forge:ask): no-op
		const second = await pi.beforeAgentStart!();
		expect(second).toBeUndefined();
	});

	it("emits a fallback question when args are blank", async () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });
		const ctx = makeCtx();
		const ask = pi.commands.get("forge:ask");
		await ask!("", ctx);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const sent = pi.sendUserMessage.mock.calls[0]?.[0] as string;
		expect(sent.toLowerCase()).toContain("capabilities");
	});

	it("appends the no-config hint when /forge:ask runs outside a Forge project", async () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: null, promptsRoot: "/fake/prompts" });
		const ctx = makeCtx();
		const ask = pi.commands.get("forge:ask");
		await ask!("what is forge?", ctx);
		const sent = pi.sendUserMessage.mock.calls[0]?.[0] as string;
		expect(sent).toContain("what is forge?");
		expect(sent).toContain("no .forge/ at cwd");
	});
});

describe("/forge:update stub (T15 will replace)", () => {
	it("emits an info notify and does not delegate or trigger an agent turn", async () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:update");
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [msg, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(msg).toContain("FORGE-S16-T15");
		expect(level).toBe("info");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("/forge:status ENOENT fallback", () => {
	it("emits the fallback notify when commands/status.md does not exist", async () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });
		const ctx = makeCtx();
		const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		vi.spyOn(fs, "readFile").mockRejectedValue(enoent);

		const handler = pi.commands.get("forge:status");
		await handler!("", ctx);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [msg, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(msg).toContain("ships with the next forge plugin release");
		expect(level).toBe("info");
	});
});
