// add-task.test.ts — Unit tests for forge:add-task kickoff shim (FORGE-S23-T11).
//
// Covers:
//   1. parseAddTaskArgs — empty, @file, free-form, flag shortcuts
//   2. composeAddTaskKickoff — output shape, flag passthrough, command body inclusion
//   3. Registration — handler emits error notify when command file missing

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	composeAddTaskKickoff,
	type ParsedAddTaskArgs,
	parseAddTaskArgs,
	registerAddTask,
} from "../../../src/extensions/forgecli/commands/add-task.js";

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

// ── parseAddTaskArgs ──────────────────────────────────────────────────────

describe("parseAddTaskArgs", () => {
	it("empty args returns all null shortcuts", () => {
		const result = parseAddTaskArgs("", "/cwd");
		expect(result.sprintId).toBeNull();
		expect(result.title).toBeNull();
		expect(result.estimate).toBeNull();
		expect(result.pipeline).toBeNull();
		expect(result.seed).toBe("");
	});

	it("parses --sprint flag", () => {
		const result = parseAddTaskArgs("--sprint FORGE-S23", "/cwd");
		expect(result.sprintId).toBe("FORGE-S23");
	});

	it("parses --title flag", () => {
		const result = parseAddTaskArgs("--title MyTitle", "/cwd");
		expect(result.title).toBe("MyTitle");
	});

	it("parses --estimate flag", () => {
		const result = parseAddTaskArgs("--estimate L", "/cwd");
		expect(result.estimate).toBe("L");
	});

	it("parses --pipeline flag", () => {
		const result = parseAddTaskArgs("--pipeline hotfix", "/cwd");
		expect(result.pipeline).toBe("hotfix");
	});

	it("parses multiple flags together", () => {
		const result = parseAddTaskArgs("--sprint FORGE-S23 --title Foo --estimate M", "/cwd");
		expect(result.sprintId).toBe("FORGE-S23");
		expect(result.title).toBe("Foo");
		expect(result.estimate).toBe("M");
	});

	it("reads @file seed", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-task-test-"));
		const seedPath = path.join(tmpDir, "seed.md");
		fs.writeFileSync(seedPath, "seed content", "utf8");
		try {
			const result = parseAddTaskArgs(`@${seedPath}`, "/cwd");
			expect(result.seed).toBe("seed content");
			expect(result.sourceLabel).toContain("seed.md");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("treats remaining text as free-form seed", () => {
		const result = parseAddTaskArgs("--sprint FORGE-S23 some extra context", "/cwd");
		expect(result.seed).toBe("some extra context");
	});
});

// ── composeAddTaskKickoff ─────────────────────────────────────────────────

describe("composeAddTaskKickoff", () => {
	const baseCommandMd = "# /forge:add-task\n\n## Step 1\n\nDo things.";

	it("includes command file body", () => {
		const parsed: ParsedAddTaskArgs = {
			sprintId: null,
			title: null,
			estimate: null,
			pipeline: null,
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddTaskKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("# /forge:add-task");
		expect(kickoff).toContain("## Step 1");
	});

	it("includes sprint shortcut when provided", () => {
		const parsed: ParsedAddTaskArgs = {
			sprintId: "FORGE-S23",
			title: null,
			estimate: null,
			pipeline: null,
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddTaskKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("--sprint FORGE-S23");
	});

	it("includes title shortcut when provided", () => {
		const parsed: ParsedAddTaskArgs = {
			sprintId: null,
			title: "My Task",
			estimate: null,
			pipeline: null,
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddTaskKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain('"My Task"');
	});

	it("includes estimate shortcut when provided", () => {
		const parsed: ParsedAddTaskArgs = {
			sprintId: null,
			title: null,
			estimate: "L",
			pipeline: null,
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddTaskKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("--estimate L");
	});

	it("mentions next-ID computation from sprint record", () => {
		const parsed: ParsedAddTaskArgs = {
			sprintId: null,
			title: null,
			estimate: null,
			pipeline: null,
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddTaskKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("next task ID");
	});

	it("includes seed when provided", () => {
		const parsed: ParsedAddTaskArgs = {
			sprintId: null,
			title: null,
			estimate: null,
			pipeline: null,
			seed: "extra context here",
			sourceLabel: "(seed from inline text)",
		};
		const kickoff = composeAddTaskKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("extra context here");
	});
});

// ── Registration — missing command file ───────────────────────────────────

describe("registerAddTask", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-task-reg-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("registers forge:add-task command", () => {
		const pi = makePi();
		registerAddTask(pi as never, { forgeRoot: tmpDir });
		expect(pi.registerCommand).toHaveBeenCalledWith("forge:add-task", expect.any(Object));
	});

	it("emits error notify when command file is missing", async () => {
		const pi = makePi();
		registerAddTask(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:add-task")?.handler;
		expect(handler).toBeDefined();
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("command file not found"), "error");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("emits warning notify when forgeRoot is null", async () => {
		const pi = makePi();
		registerAddTask(pi as never, { forgeRoot: null });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:add-task")?.handler;
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no Forge project"), "warning");
	});

	it("sends kickoff when command file exists", async () => {
		// Create a fake commands directory with the command file
		const commandsDir = path.join(tmpDir, "commands");
		fs.mkdirSync(commandsDir);
		fs.writeFileSync(path.join(commandsDir, "add-task.md"), "# /forge:add-task\n\n## Step 1", "utf8");

		const pi = makePi();
		registerAddTask(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:add-task")?.handler;
		await handler!("--sprint FORGE-S23", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("FORGE-S23"),
			expect.objectContaining({ deliverAs: "steer" }),
		);
	});
});
