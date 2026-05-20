// quiz-agent.test.ts — Unit tests for forge:quiz-agent kickoff shim (FORGE-S23-T11).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	parseQuizAgentArgs,
	composeQuizAgentKickoff,
	registerQuizAgent,
	type ParsedQuizAgentArgs,
} from "../../../src/extensions/forgecli/quiz-agent.js";

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

describe("parseQuizAgentArgs", () => {
	it("empty args returns mode='empty'", () => {
		const result = parseQuizAgentArgs("", "/cwd");
		expect(result.mode).toBe("empty");
		expect(result.topicSeed).toBe("");
	});

	it("free-form text returns mode='text'", () => {
		const result = parseQuizAgentArgs("entity model", "/cwd");
		expect(result.mode).toBe("text");
		expect(result.topicSeed).toBe("entity model");
	});

	it("@file returns mode='file' with file content", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-test-"));
		const seedPath = path.join(tmpDir, "topic.txt");
		fs.writeFileSync(seedPath, "sprint conventions", "utf8");
		try {
			const result = parseQuizAgentArgs(`@${seedPath}`, "/cwd");
			expect(result.mode).toBe("file");
			expect(result.topicSeed).toBe("sprint conventions");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("composeQuizAgentKickoff", () => {
	const baseCommandMd = "# /forge:quiz-agent\n\nQuiz content.";

	it("includes command body", () => {
		const parsed: ParsedQuizAgentArgs = { mode: "empty", topicSeed: "", sourceLabel: "" };
		const kickoff = composeQuizAgentKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("Quiz content.");
	});

	it("includes dispatch instruction", () => {
		const parsed: ParsedQuizAgentArgs = { mode: "empty", topicSeed: "", sourceLabel: "" };
		const kickoff = composeQuizAgentKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("quiz-agent workflow");
	});

	it("includes topic seed when provided", () => {
		const parsed: ParsedQuizAgentArgs = {
			mode: "text",
			topicSeed: "architecture",
			sourceLabel: "(topic from inline text)",
		};
		const kickoff = composeQuizAgentKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("architecture");
	});

	it("shows 'no topic' section when empty", () => {
		const parsed: ParsedQuizAgentArgs = { mode: "empty", topicSeed: "", sourceLabel: "" };
		const kickoff = composeQuizAgentKickoff({ commandMd: baseCommandMd, parsed });
		expect(kickoff).toContain("no topic");
	});
});

describe("registerQuizAgent", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-reg-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("registers forge:quiz-agent command", () => {
		const pi = makePi();
		registerQuizAgent(pi as never, { forgeRoot: tmpDir });
		expect(pi.registerCommand).toHaveBeenCalledWith("forge:quiz-agent", expect.any(Object));
	});

	it("emits error notify when command file missing", async () => {
		const pi = makePi();
		registerQuizAgent(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:quiz-agent")?.handler;
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("command file not found"),
			"error",
		);
	});

	it("sends kickoff when command file exists", async () => {
		const commandsDir = path.join(tmpDir, "commands");
		fs.mkdirSync(commandsDir);
		fs.writeFileSync(path.join(commandsDir, "quiz-agent.md"), "# /forge:quiz-agent\n\ncontent", "utf8");

		const pi = makePi();
		registerQuizAgent(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:quiz-agent")?.handler;
		await handler!("entity model", ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("entity model"),
			expect.objectContaining({ deliverAs: "steer" }),
		);
	});
});
