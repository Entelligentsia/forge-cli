// report-bug.test.ts — Unit tests for forge:report-bug kickoff shim (FORGE-S23-T11).
//
// Covers:
//   1. parseReportBugArgs — empty, @file, free-form
//   2. resolveBugRepo — env var > config.json > default
//   3. composeReportBugKickoff — repo name in kickoff, symptom passthrough
//   4. Registration — gh auth failure path, command file missing path

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "✓ Logged in", stderr: "", error: undefined })),
}));

import {
	checkGhAuth,
	composeReportBugKickoff,
	type ParsedReportBugArgs,
	parseReportBugArgs,
	registerReportBug,
	resolveBugRepo,
} from "../../../src/extensions/forgecli/report-bug.js";

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

// ── resolveBugRepo ────────────────────────────────────────────────────────

describe("resolveBugRepo", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-bug-repo-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		delete process.env["FORGE_BUG_REPO"];
	});

	it("returns FORGE_BUG_REPO env var when set", () => {
		process.env["FORGE_BUG_REPO"] = "MyOrg/my-fork";
		const result = resolveBugRepo(tmpDir);
		expect(result).toBe("MyOrg/my-fork");
	});

	it("returns config.json bugs.repo when env not set", () => {
		const forgeDir = path.join(tmpDir, ".forge");
		fs.mkdirSync(forgeDir);
		fs.writeFileSync(
			path.join(forgeDir, "config.json"),
			JSON.stringify({ bugs: { repo: "OtherOrg/other-repo" } }),
			"utf8",
		);
		const result = resolveBugRepo(tmpDir);
		expect(result).toBe("OtherOrg/other-repo");
	});

	it("returns default when neither env nor config is set", () => {
		const result = resolveBugRepo(tmpDir);
		expect(result).toBe("Entelligentsia/forge");
	});

	it("env var takes precedence over config.json", () => {
		process.env["FORGE_BUG_REPO"] = "EnvOrg/env-repo";
		const forgeDir = path.join(tmpDir, ".forge");
		fs.mkdirSync(forgeDir);
		fs.writeFileSync(
			path.join(forgeDir, "config.json"),
			JSON.stringify({ bugs: { repo: "ConfigOrg/config-repo" } }),
			"utf8",
		);
		const result = resolveBugRepo(tmpDir);
		expect(result).toBe("EnvOrg/env-repo");
	});
});

// ── parseReportBugArgs ────────────────────────────────────────────────────

describe("parseReportBugArgs", () => {
	it("empty args returns mode='empty'", () => {
		const result = parseReportBugArgs("", "/cwd");
		expect(result.mode).toBe("empty");
		expect(result.symptomText).toBe("");
	});

	it("free-form text returns mode='text'", () => {
		const result = parseReportBugArgs("the wizard crashes", "/cwd");
		expect(result.mode).toBe("text");
		expect(result.symptomText).toBe("the wizard crashes");
	});

	it("@file returns mode='file' with content", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-report-test-"));
		const seedPath = path.join(tmpDir, "bug.md");
		fs.writeFileSync(seedPath, "bug description", "utf8");
		try {
			const result = parseReportBugArgs(`@${seedPath}`, "/cwd");
			expect(result.mode).toBe("file");
			expect(result.symptomText).toBe("bug description");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ── composeReportBugKickoff ───────────────────────────────────────────────

describe("composeReportBugKickoff", () => {
	const baseCommandMd = "# /forge:report-bug\n\nFile a bug.";

	it("includes resolved bug repo in kickoff", () => {
		const parsed: ParsedReportBugArgs = { mode: "empty", symptomText: "", sourceLabel: "" };
		const kickoff = composeReportBugKickoff({
			commandMd: baseCommandMd,
			parsed,
			bugRepo: "MyOrg/my-fork",
			ghAuthOutput: "",
		});
		expect(kickoff).toContain("MyOrg/my-fork");
	});

	it("includes default repo when not overridden", () => {
		const parsed: ParsedReportBugArgs = { mode: "empty", symptomText: "", sourceLabel: "" };
		const kickoff = composeReportBugKickoff({
			commandMd: baseCommandMd,
			parsed,
			bugRepo: "Entelligentsia/forge",
			ghAuthOutput: "",
		});
		expect(kickoff).toContain("Entelligentsia/forge");
	});

	it("includes symptom text when provided", () => {
		const parsed: ParsedReportBugArgs = {
			mode: "text",
			symptomText: "crashes on startup",
			sourceLabel: "(symptom from inline text)",
		};
		const kickoff = composeReportBugKickoff({
			commandMd: baseCommandMd,
			parsed,
			bugRepo: "Entelligentsia/forge",
			ghAuthOutput: "",
		});
		expect(kickoff).toContain("crashes on startup");
	});

	it("includes command body", () => {
		const parsed: ParsedReportBugArgs = { mode: "empty", symptomText: "", sourceLabel: "" };
		const kickoff = composeReportBugKickoff({
			commandMd: baseCommandMd,
			parsed,
			bugRepo: "Entelligentsia/forge",
			ghAuthOutput: "",
		});
		expect(kickoff).toContain("File a bug.");
	});
});

// ── Registration ──────────────────────────────────────────────────────────

describe("registerReportBug", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-bug-reg-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		delete process.env["FORGE_BUG_REPO"];
	});

	it("registers forge:report-bug command", () => {
		const pi = makePi();
		registerReportBug(pi as never, { forgeRoot: tmpDir });
		expect(pi.registerCommand).toHaveBeenCalledWith("forge:report-bug", expect.any(Object));
	});

	it("emits error notify when command file missing (gh auth ok)", async () => {
		// gh auth is mocked to return ok=true at module level
		const pi = makePi();
		registerReportBug(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:report-bug")?.handler;
		await handler!("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("command file not found"), "error");
	});

	it("sends kickoff with default repo when command file exists", async () => {
		const commandsDir = path.join(tmpDir, "commands");
		fs.mkdirSync(commandsDir);
		fs.writeFileSync(path.join(commandsDir, "report-bug.md"), "# /forge:report-bug\n\ncontent", "utf8");

		const pi = makePi();
		registerReportBug(pi as never, { forgeRoot: tmpDir });
		const ctx = makeCtx();
		const handler = pi.commands.get("forge:report-bug")?.handler;
		await handler!("", ctx);

		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Entelligentsia/forge"),
			expect.objectContaining({ deliverAs: "steer" }),
		);
	});
});

// ── checkGhAuth (unit — uses module mock) ─────────────────────────────────

describe("checkGhAuth", () => {
	it("returns ok=true when spawnSync exits 0", () => {
		const result = checkGhAuth();
		expect(result.ok).toBe(true);
	});
});
