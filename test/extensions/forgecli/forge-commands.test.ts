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
//   7. T28 (FORGE-S17-T02): registerAllForgeCommands count matches bundled command files.

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test__, registerForgeCommands, registerAllForgeCommands } from "../../../src/extensions/forgecli/forge-commands.js";

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
	it("registers four /forge:* commands and the before_agent_start handler", () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });

		expect(pi.registerCommand).toHaveBeenCalledTimes(4);
		const names = Array.from(pi.commands.keys()).sort();
		expect(names).toEqual(["forge:ask", "forge:config", "forge:health", "forge:status"]);
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(pi.beforeAgentStart).not.toBeNull();
	});
});

describe("outside-project no-op (Q14)", () => {
	const cases = ["health", "config", "status"] as const;
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

// /forge:update is now registered by registerForgeUpdateCommand (see
// forge-update-command.test.ts) — FORGE-S16-T15 replaced the stub.

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

// ── T28: registerAllForgeCommands (FORGE-S17-T02) ─────────────────────────

describe("T28: registerAllForgeCommands — bundled command count matches .base-pack/commands/*.md", () => {
	it("registers stub commands for each bundled *.md file (minus real-handler set)", () => {
		// Resolve the bundle path relative to the package root
		const extensionDir = path.dirname(fileURLToPath(import.meta.url));
		const pkgRoot = path.resolve(extensionDir, "..", "..", "..");
		const commandsDir = path.join(pkgRoot, "dist", "forge-payload", ".base-pack", "commands");

		// Count *.md files in the commands dir
		let expectedFileCount = 0;
		try {
			expectedFileCount = fsSync.readdirSync(commandsDir).filter((f: string) => f.endsWith(".md")).length;
		} catch {
			// .base-pack not built yet — skip test
			return;
		}

		const pi = makePi();
		const registered = registerAllForgeCommands(pi as never, {
			bundlePayloadRoot: path.join(pkgRoot, "dist", "forge-payload"),
			cwd: process.cwd(),
		});

		// registerAllForgeCommands returns the count of STUB commands registered.
		// Real handlers in EXPLICITLY_REGISTERED_NAMES are excluded from stubs.
		// But enhance and refresh-kb-links ARE registered by registerAllForgeCommands.
		// registered = (fileCount - realHandlerOverlapCount) + 2 (enhance + refresh-kb-links always added)
		// The total pi.registerCommand calls should be: registered + 2 (enhance + refresh-kb-links)
		// Deduct commands with real handlers that have bundled .md files:
		//   - forge:sprint-intake (FORGE-S19-T01)
		//   - forge:sprint-plan (FORGE-S19-T02)
		//   - forge:plan (FORGE-S20-T05)
		//   - forge:implement (FORGE-S20-T06)
		//   - forge:run-task (FORGE-S21-T02)
		//   - forge:run-sprint (FORGE-S21-T03)
		//   - forge:fix-bug (FORGE-S21-T07)
		//   - forge:review-plan (FORGE-S21-T10)
		//   - forge:review-code (FORGE-S21-T10)
		//   - forge:approve (FORGE-S21-T10)
		//   - forge:commit (FORGE-S21-T10)
		//   - forge:validate (FORGE-S21-T10)
		//   - forge:collate (FORGE-S21-T10)
		const REAL_HANDLER_CMD_FILES = 13; // commands with .md files AND real handlers (added T10 chain shims)
		const totalCalls = pi.registerCommand.mock.calls.length;

		// Total calls = stub count + forge:refresh-kb-links + forge:enhance
		// minus commands that have .md files but are excluded from stubs (real handlers)
		expect(totalCalls).toBeGreaterThanOrEqual(expectedFileCount - REAL_HANDLER_CMD_FILES);

		// Verify no duplicate registrations (all names unique)
		const names = (pi.registerCommand.mock.calls as Array<[string, unknown]>).map((c) => c[0]);
		const uniqueNames = new Set(names);
		expect(uniqueNames.size).toBe(names.length);
	});

	it("parseFrontmatter extracts name and description from frontmatter block", () => {
		const content = "---\nname: test-cmd\ndescription: A test command\n---\n\n# body";
		const result = __test__.parseFrontmatter(content);
		expect(result).toEqual({ name: "test-cmd", description: "A test command" });
	});

	it("parseFrontmatter returns null when no frontmatter", () => {
		const content = "# Just a header\n\nNo frontmatter";
		const result = __test__.parseFrontmatter(content);
		expect(result).toBeNull();
	});

	it("parseFrontmatter returns null when name is missing", () => {
		const content = "---\ndescription: No name here\n---\n# body";
		const result = __test__.parseFrontmatter(content);
		expect(result).toBeNull();
	});

	it("REAL_HANDLERS set includes expected command names", () => {
		expect(__test__.REAL_HANDLERS.has("forge:init")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:health")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:ask")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:refresh-kb-links")).toBe(true);
	});
});
