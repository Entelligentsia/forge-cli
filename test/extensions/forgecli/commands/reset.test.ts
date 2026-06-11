// reset.test.ts — Unit tests for forge:reset kickoff shim (FEAT-009 component C).
//
// Covers:
//   1. composeResetKickoff — output shape, $ARGUMENTS substitution, resolved
//      FORGE_ROOT injection, command-body inclusion, forge-cli cache note.
//   2. Registration — real handler registered; missing command file → error
//      notify; no forgeRoot → warning notify; happy path → sendKickoff (steer).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeResetKickoff, registerReset } from "../../../../src/extensions/forgecli/commands/reset.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makePi() {
	const commands = new Map<string, { handler: (a: string, ctx: unknown) => Promise<void> }>();
	return {
		registerCommand: vi.fn((name: string, def: { handler: (a: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def);
		}),
		sendUserMessage: vi.fn(),
		commands,
	};
}

function makeCtx() {
	return { ui: { notify: vi.fn() } };
}

const COMMAND_MD = [
	"---",
	"name: reset",
	"description: Rewind a halted task/bug/sprint.",
	"---",
	"# /forge:reset",
	"From $ARGUMENTS, determine the entity and target phase.",
	"Run `node \"$FORGE_ROOT/tools/reset-plan.cjs\" --entity <kind> --id <id> --to <phase> --json`.",
].join("\n");

// ── composeResetKickoff ─────────────────────────────────────────────────────

describe("composeResetKickoff", () => {
	it("substitutes $ARGUMENTS with the request text in the command body", () => {
		const out = composeResetKickoff({
			commandMd: COMMAND_MD,
			forgeRoot: "/proj/.forge/forge",
			request: "put FORGE-S32-T07 back to review-code",
		});
		expect(out).not.toContain("$ARGUMENTS");
		expect(out).toContain("put FORGE-S32-T07 back to review-code");
	});

	it("injects the resolved FORGE_ROOT and instructs against re-resolving it", () => {
		const out = composeResetKickoff({
			commandMd: COMMAND_MD,
			forgeRoot: "/proj/.forge/forge",
			request: "reset FORGE-S32-T07 to implement",
		});
		expect(out).toContain("`/proj/.forge/forge`");
		expect(out).toMatch(/READ-ONLY planner/);
	});

	it("includes the command body and the forge-cli resume-cache lockstep note", () => {
		const out = composeResetKickoff({
			commandMd: COMMAND_MD,
			forgeRoot: "/proj/.forge/forge",
			request: "reset X to plan",
		});
		expect(out).toContain("reset-plan.cjs");
		expect(out).toContain("4ge reset");
		expect(out).toContain("store side only");
		expect(out).toContain("## Command");
	});

	it("handles an empty request by prompting the LLM to ask the user", () => {
		const out = composeResetKickoff({ commandMd: COMMAND_MD, forgeRoot: "/r", request: "" });
		expect(out).toContain("ask the user");
	});
});

// ── registerReset ───────────────────────────────────────────────────────────

describe("registerReset", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reset-cmd-"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("registers the forge:reset command name", () => {
		const pi = makePi();
		registerReset(pi as never, { forgeRoot: tmp });
		expect(pi.registerCommand).toHaveBeenCalledWith("forge:reset", expect.anything());
		expect(pi.commands.has("forge:reset")).toBe(true);
	});

	it("warns and returns when no Forge project (forgeRoot null) — no kickoff", async () => {
		const pi = makePi();
		registerReset(pi as never, { forgeRoot: null });
		const ctx = makeCtx();
		await pi.commands.get("forge:reset")!.handler("reset X to plan", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no Forge project"), "warning");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("errors and returns when the command file is missing — no kickoff", async () => {
		const pi = makePi();
		registerReset(pi as never, { forgeRoot: tmp }); // tmp has no commands/reset.md
		const ctx = makeCtx();
		await pi.commands.get("forge:reset")!.handler("reset X to plan", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("command file not found"), "error");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("steers a kickoff (deliverAs: steer) on the happy path", async () => {
		const pi = makePi();
		fs.mkdirSync(path.join(tmp, "commands"), { recursive: true });
		fs.writeFileSync(path.join(tmp, "commands", "reset.md"), COMMAND_MD, "utf8");
		registerReset(pi as never, { forgeRoot: tmp });
		const ctx = makeCtx();

		await pi.commands.get("forge:reset")!.handler("put FORGE-S32-T07 back to review-code", ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [text, opts] = pi.sendUserMessage.mock.calls[0]!;
		expect(opts).toEqual({ deliverAs: "steer" });
		expect(text).toContain("put FORGE-S32-T07 back to review-code");
		expect(text).toContain(tmp); // resolved FORGE_ROOT injected
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
