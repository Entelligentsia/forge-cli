// add-pipeline.test.ts — Unit tests for forge:add-pipeline kickoff shim (FORGE-S23-T11).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	composeAddPipelineKickoff,
	type ParsedAddPipelineArgs,
	parseAddPipelineArgs,
	registerAddPipeline,
} from "../../../src/extensions/forgecli/commands/add-pipeline.js";

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

describe("parseAddPipelineArgs", () => {
	it("empty args defaults to mode='add'", () => {
		const result = parseAddPipelineArgs("", "/cwd");
		expect(result.mode).toBe("add");
		expect(result.pipelineName).toBeNull();
	});

	it("--add flag sets mode to 'add'", () => {
		const result = parseAddPipelineArgs("--add", "/cwd");
		expect(result.mode).toBe("add");
	});

	it("--edit flag sets mode to 'edit'", () => {
		const result = parseAddPipelineArgs("--edit", "/cwd");
		expect(result.mode).toBe("edit");
	});

	it("--view flag sets mode to 'view'", () => {
		const result = parseAddPipelineArgs("--view", "/cwd");
		expect(result.mode).toBe("view");
	});

	it("--list flag sets mode to 'view'", () => {
		const result = parseAddPipelineArgs("--list", "/cwd");
		expect(result.mode).toBe("view");
	});

	it("--remove flag sets mode to 'remove'", () => {
		const result = parseAddPipelineArgs("--remove", "/cwd");
		expect(result.mode).toBe("remove");
	});

	it("--name flag captures pipeline name", () => {
		const result = parseAddPipelineArgs("--name hotfix", "/cwd");
		expect(result.pipelineName).toBe("hotfix");
	});

	it("bare word sets pipeline name", () => {
		const result = parseAddPipelineArgs("hotfix", "/cwd");
		expect(result.pipelineName).toBe("hotfix");
	});
});

describe("composeAddPipelineKickoff", () => {
	const baseCommandMd = "# /forge:add-pipeline\n\nPipeline manager content.";

	it("includes mode label in kickoff", () => {
		const parsed: ParsedAddPipelineArgs = {
			mode: "view",
			pipelineName: null,
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddPipelineKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("View configured pipelines");
	});

	it("includes pipeline name when provided", () => {
		const parsed: ParsedAddPipelineArgs = {
			mode: "add",
			pipelineName: "hotfix",
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddPipelineKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("`hotfix`");
	});

	it("includes command body", () => {
		const parsed: ParsedAddPipelineArgs = {
			mode: "add",
			pipelineName: null,
			seed: "",
			sourceLabel: "",
		};
		const kickoff = composeAddPipelineKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("Pipeline manager content.");
	});
});

describe("registerAddPipeline", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-pipeline-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("registers forge:add-pipeline command", () => {
		const pi = makePi();
		registerAddPipeline(pi as never, { forgeRoot: tmpDir });
		expect(pi.registerCommand).toHaveBeenCalledWith("forge:add-pipeline", expect.any(Object));
	});

	it("emits error notify when command file missing", async () => {
		const pi = makePi();
		registerAddPipeline(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:add-pipeline")?.handler;
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("command file not found"), "error");
	});

	it("sends kickoff with mode label when command file exists", async () => {
		const commandsDir = path.join(tmpDir, "commands");
		fs.mkdirSync(commandsDir);
		fs.writeFileSync(path.join(commandsDir, "add-pipeline.md"), "# /forge:add-pipeline\n\nbody", "utf8");

		const pi = makePi();
		registerAddPipeline(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:add-pipeline")?.handler;
		await handler!("--view", ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("View configured pipelines"),
			expect.objectContaining({ deliverAs: "steer" }),
		);
	});
});
