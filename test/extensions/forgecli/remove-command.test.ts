// remove-command.test.ts — Unit tests for forge:remove kickoff shim (FORGE-S23-T11).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	parseRemoveArgs,
	composeRemoveKickoff,
	registerRemoveCommand,
	type ParsedRemoveArgs,
} from "../../../src/extensions/forgecli/remove-command.js";

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

describe("parseRemoveArgs", () => {
	it("empty args returns apply=false", () => {
		const result = parseRemoveArgs("", "/cwd");
		expect(result.apply).toBe(false);
		expect(result.seed).toBe("");
	});

	it("--apply flag sets apply=true", () => {
		const result = parseRemoveArgs("--apply", "/cwd");
		expect(result.apply).toBe(true);
	});

	it("--apply with seed captures both", () => {
		const result = parseRemoveArgs("--apply keep-kb", "/cwd");
		expect(result.apply).toBe(true);
		expect(result.seed).toBe("keep-kb");
	});

	it("@file seed is read", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remove-test-"));
		const seedPath = path.join(tmpDir, "seed.txt");
		fs.writeFileSync(seedPath, "keep engineering/", "utf8");
		try {
			const result = parseRemoveArgs(`@${seedPath}`, "/cwd");
			expect(result.seed).toBe("keep engineering/");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("composeRemoveKickoff", () => {
	const baseCommandMd = "# /forge:remove\n\nRemove Forge artifacts.";

	it("includes command body", () => {
		const parsed: ParsedRemoveArgs = { apply: false, seed: "", sourceLabel: "" };
		const kickoff = composeRemoveKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("Remove Forge artifacts.");
	});

	it("includes --apply instruction when apply=true", () => {
		const parsed: ParsedRemoveArgs = { apply: true, seed: "", sourceLabel: "" };
		const kickoff = composeRemoveKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("--apply");
		expect(kickoff).toContain("without asking for per-bucket confirmation");
	});

	it("shows interactive mode when apply=false", () => {
		const parsed: ParsedRemoveArgs = { apply: false, seed: "", sourceLabel: "" };
		const kickoff = composeRemoveKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("Interactive mode");
	});

	it("includes seed when provided", () => {
		const parsed: ParsedRemoveArgs = {
			apply: false,
			seed: "keep the KB",
			sourceLabel: "(seed from inline text)",
		};
		const kickoff = composeRemoveKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("keep the KB");
	});
});

describe("registerRemoveCommand", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remove-reg-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("registers forge:remove command", () => {
		const pi = makePi();
		registerRemoveCommand(pi as never, { forgeRoot: tmpDir });
		expect(pi.registerCommand).toHaveBeenCalledWith("forge:remove", expect.any(Object));
	});

	it("emits error notify when command file missing", async () => {
		const pi = makePi();
		registerRemoveCommand(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:remove")?.handler;
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("command file not found"),
			"error",
		);
	});

	it("sends kickoff with --apply instruction when --apply provided", async () => {
		const commandsDir = path.join(tmpDir, "commands");
		fs.mkdirSync(commandsDir);
		fs.writeFileSync(path.join(commandsDir, "remove.md"), "# /forge:remove\n\ncontent", "utf8");

		const pi = makePi();
		registerRemoveCommand(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:remove")?.handler;
		await handler!("--apply", ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("without asking for per-bucket confirmation"),
			expect.objectContaining({ deliverAs: "steer" }),
		);
	});
});
