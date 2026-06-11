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
//   7. T28 (FORGE-S17-T02; FORGE-S32-T06): registerAllForgeCommands enumerates the
//      unified commands/ tree and introduces no new auto-stub (no forge:reset).

import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__test__,
	registerAllForgeCommands,
	registerForgeCommands,
} from "../../../src/extensions/forgecli/forge-commands.js";

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
	it("registers forge:health and forge:ask (no redirect/removed-command stubs in v1.0)", () => {
		// Plan 16 Slice 4a: /forge:config is now registered by registerConfigCommand
		// in index.ts, not here. The slot stays in EXPLICITLY_REGISTERED_NAMES so
		// the auto-stub loop does not re-register a fallback.
		// FORGE-S23-T10: /forge:status delegate stub removed — native handler
		// registered via registerStatusCommand in index.ts.
		// FORGE-S26-T10: deprecated rename/removal redirects fully removed — old
		// names are now unknown commands, so registerForgeCommands registers only
		// the two core commands (health + ask). No removed-command stubs remain.
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });

		// 2 real commands (forge:health, forge:ask), no stubs
		expect(pi.registerCommand).toHaveBeenCalledTimes(2);
		const names = Array.from(pi.commands.keys()).sort();
		// Core commands
		expect(names).toContain("forge:ask");
		expect(names).toContain("forge:health");
		// Removed commands get NO stub here (unknown command in v1.0)
		expect(names).not.toContain("forge:materialize");
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(pi.beforeAgentStart).not.toBeNull();
	});
});

describe("outside-project no-op (Q14)", () => {
	// Plan 16 Slice 4a: config dropped from this set — its outside-project
	// behavior is now owned by registerConfigCommand (Slice 4b/4c).
	// FORGE-S23-T10: status dropped — native registerStatusCommand owns outside-project guard.
	const cases = ["health"] as const;
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

// /forge:status ENOENT fallback removed — FORGE-S23-T10 replaced the
// delegateMarkdownCommand stub with a native handler (registerStatusCommand).
// The outside-project guard and active-sprint rendering are tested in
// test/extensions/forgecli/status-command.test.ts.
describe("/forge:status native handler (FORGE-S23-T10)", () => {
	it("forge:status is NOT registered by registerForgeCommands (delegate stub removed)", () => {
		const pi = makePi();
		registerForgeCommands(pi as never, { forgeRoot: "/fake/forge", promptsRoot: "/fake/prompts" });
		// The native handler is registered by registerStatusCommand in index.ts,
		// not by registerForgeCommands. Verify the command is absent here.
		expect(pi.commands.has("forge:status")).toBe(false);
	});
});

// ── T28: registerAllForgeCommands (FORGE-S17-T02) ─────────────────────────

describe("T28: registerAllForgeCommands — unified commands/*.md, no-new-stub surface (FORGE-S32-T06)", () => {
	it("repoints to the unified commands/ tree and registers no new auto-stub (notably no forge:reset)", () => {
		// Resolve the bundle path relative to the package root
		const extensionDir = path.dirname(fileURLToPath(import.meta.url));
		const pkgRoot = path.resolve(extensionDir, "..", "..", "..");
		// FORGE-S32-T06: the former .base-pack/commands/ second tree was collapsed
		// into the unified commands/ tree. registerAllForgeCommands now enumerates
		// dist/forge-payload/commands/ (30 files).
		const commandsDir = path.join(pkgRoot, "dist", "forge-payload", "commands");

		// Count *.md files in the unified commands dir
		let expectedFileCount = 0;
		try {
			expectedFileCount = fsSync.readdirSync(commandsDir).filter((f: string) => f.endsWith(".md")).length;
		} catch {
			// payload not built yet — skip test
			return;
		}

		// The unified tree holds the full /forge:* surface (was 16 plugin + 17
		// base-pack − 3 collisions = 30 files).
		expect(expectedFileCount).toBe(30);

		const pi = makePi();
		const registered = registerAllForgeCommands(pi as never, {
			bundlePayloadRoot: path.join(pkgRoot, "dist", "forge-payload"),
			cwd: process.cwd(),
		});

		// registerAllForgeCommands returns the count of STUB commands registered.
		// Every name in the unified tree maps to EXPLICITLY_REGISTERED_NAMES EXCEPT
		// forge:enhance (which gets an advisory stub). forge:reset was added to
		// EXPLICITLY_REGISTERED_NAMES precisely so the repoint introduces NO new
		// auto-stub — the stub surface is identical to the pre-unification
		// base-pack era (forge:enhance only).
		expect(registered).toBe(1); // only forge:enhance

		const names = (pi.registerCommand.mock.calls as Array<[string, unknown]>).map((c) => c[0]);

		// No-new-stub guarantee (rev #4): forge:reset must NOT be auto-stubbed.
		expect(names).not.toContain("forge:reset");

		// The lone auto-stub is forge:enhance; refresh-kb-links is the real handler
		// registerAllForgeCommands always contributes. totalCalls = 2.
		expect(names).toContain("forge:enhance");
		expect(names).toContain("forge:refresh-kb-links");
		expect(names.length).toBe(2);

		// Verify no duplicate registrations (all names unique)
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

	it("REAL_HANDLERS set includes expected command names (v1.0 surface)", () => {
		expect(__test__.REAL_HANDLERS.has("forge:init")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:health")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:ask")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:refresh-kb-links")).toBe(true);
		// v1.0 new names
		expect(__test__.REAL_HANDLERS.has("forge:new-sprint")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:plan-sprint")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:retro")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:rebuild")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:search")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:repair")).toBe(true);
		expect(__test__.REAL_HANDLERS.has("forge:check-agent")).toBe(true);
		// Deprecated old-name redirects removed — only forge:materialize stub remains
		expect(__test__.REAL_HANDLERS.has("forge:sprint-intake")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:sprint-plan")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:retrospective")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:regenerate")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:store-query")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:store-repair")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:quiz-agent")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:update-tools")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:enhance")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:calibrate")).toBe(false);
		expect(__test__.REAL_HANDLERS.has("forge:migrate")).toBe(false);
		// forge:materialize fully removed in v1.0 — no lingering stub
		expect(__test__.REAL_HANDLERS.has("forge:materialize")).toBe(false);
	});
});
