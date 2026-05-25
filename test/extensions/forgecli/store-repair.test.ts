// store-repair.test.ts — Unit tests for forge:store-repair kickoff shim (FORGE-S23-T11).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	composeStoreRepairKickoff,
	type ParsedStoreRepairArgs,
	parseStoreRepairArgs,
	registerStoreRepair,
} from "../../../src/extensions/forgecli/store-repair.js";

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

describe("parseStoreRepairArgs", () => {
	it("empty args returns dryRun=false", () => {
		const result = parseStoreRepairArgs("", "/cwd");
		expect(result.dryRun).toBe(false);
		expect(result.seed).toBe("");
	});

	it("--dry-run flag sets dryRun=true", () => {
		const result = parseStoreRepairArgs("--dry-run", "/cwd");
		expect(result.dryRun).toBe(true);
	});

	it("seed text captured after --dry-run", () => {
		const result = parseStoreRepairArgs("--dry-run extra context", "/cwd");
		expect(result.dryRun).toBe(true);
		expect(result.seed).toBe("extra context");
	});

	it("@file seed is read", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-repair-test-"));
		const seedPath = path.join(tmpDir, "ctx.txt");
		fs.writeFileSync(seedPath, "known corruption context", "utf8");
		try {
			const result = parseStoreRepairArgs(`@${seedPath}`, "/cwd");
			expect(result.seed).toBe("known corruption context");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("composeStoreRepairKickoff", () => {
	const baseCommandMd = "# /forge:store-repair\n\nRepair content.";

	it("includes command body", () => {
		const parsed: ParsedStoreRepairArgs = { dryRun: false, seed: "", sourceLabel: "" };
		const kickoff = composeStoreRepairKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("Repair content.");
	});

	it("includes dry-run instruction when dryRun=true", () => {
		const parsed: ParsedStoreRepairArgs = { dryRun: true, seed: "", sourceLabel: "" };
		const kickoff = composeStoreRepairKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("dry-run");
		expect(kickoff).toContain("without writing");
	});

	it("shows full repair mode when dryRun=false", () => {
		const parsed: ParsedStoreRepairArgs = { dryRun: false, seed: "", sourceLabel: "" };
		const kickoff = composeStoreRepairKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("Full repair mode");
	});

	it("includes seed when provided", () => {
		const parsed: ParsedStoreRepairArgs = {
			dryRun: false,
			seed: "known issue with sprint record",
			sourceLabel: "(seed from inline text)",
		};
		const kickoff = composeStoreRepairKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("known issue with sprint record");
	});
});

describe("registerStoreRepair", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-repair-reg-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("registers forge:store-repair command", () => {
		const pi = makePi();
		registerStoreRepair(pi as never, { forgeRoot: tmpDir });
		expect(pi.registerCommand).toHaveBeenCalledWith("forge:store-repair", expect.any(Object));
	});

	it("emits error notify when command file missing", async () => {
		const pi = makePi();
		registerStoreRepair(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:store-repair")?.handler;
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("command file not found"), "error");
	});

	it("sends kickoff with dry-run instruction when --dry-run provided", async () => {
		const commandsDir = path.join(tmpDir, "commands");
		fs.mkdirSync(commandsDir);
		fs.writeFileSync(path.join(commandsDir, "store-repair.md"), "# /forge:store-repair\n\ncontent", "utf8");

		const pi = makePi();
		registerStoreRepair(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:store-repair")?.handler;
		await handler!("--dry-run", ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("dry-run"),
			expect.objectContaining({ deliverAs: "steer" }),
		);
	});
});
