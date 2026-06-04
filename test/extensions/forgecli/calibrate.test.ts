// Unit + integration tests for the /forge:calibrate orchestrator handler (FORGE-S23-T08).
//
// AC#7: unit tests for drift-detection; integration test for 4-phase flow
// with mocked subagent.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock must reference only module-level constants (hoisting constraint).
vi.mock("../../../src/extensions/forgecli/forge-subagent.js", () => ({
	loadForgePersona: vi.fn((name: string, cwd: string) => ({
		name,
		description: `Mock ${name}`,
		systemPrompt: "You are mock.",
		filePath: `${cwd}/.forge/personas/${name}.md`,
	})),
	runForgeSubagent: vi.fn().mockResolvedValue({
		exitCode: 0,
		messages: [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: '```json\n{"target":"personas:engineer","type":"regenerate","rationale":"Stack drift"}\n```',
					},
				],
			},
		],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 15, turns: 1 },
		stopReason: "end_turn",
	}),
	getFinalOutput: vi.fn((messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>) => {
		const last = messages.at(-1);
		if (!last) return "";
		const part = last.content.find((p) => p.type === "text");
		return part?.text ?? "";
	}),
}));

vi.mock("../../../src/extensions/forgecli/forge-init/forge-init.js", () => ({
	getBundledPayloadRoot: vi.fn(() => "/mock-bundle-root"),
	getBundledToolsRoot: vi.fn(() => "/mock-bundle-root/tools"),
	resolveBundleToolsRoot: vi.fn(() => "/mock-bundle-root/tools"),
	isPiRuntime: vi.fn(() => true),
}));

import {
	categorizeDrift,
	computeCurrentHash,
	extractPatchProposals,
	parseCalibrateFlags,
	registerCalibrate,
} from "../../../src/extensions/forgecli/orchestrators/calibrate.js";
import { __test__ as forgeCommandsTest } from "../../../src/extensions/forgecli/forge-commands.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-calibrate-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.clearAllMocks();
});

// ── Scaffold helper ──────────────────────────────────────────────────────

interface ScaffoldOpts {
	masterIndexContent?: string;
	baselineHash?: string | null;
	baselineLastCalibrated?: string;
	baselineSprintsCovered?: string[];
	omitBaseline?: boolean;
	omitMasterIndex?: boolean;
	sprints?: Array<{ sprintId: string; status: string }>;
}

function scaffoldProject(opts: ScaffoldOpts = {}): string {
	const proj = path.join(tmpRoot, "proj");
	fs.mkdirSync(path.join(proj, ".forge", "workflows"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "personas"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "skills"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "store", "sprints"), { recursive: true });
	fs.mkdirSync(path.join(proj, "engineering"), { recursive: true });

	const masterContent = opts.masterIndexContent ?? "# MASTER_INDEX\n\nstack: nodejs\n";
	const cfg: Record<string, unknown> = {
		version: "1",
		project: { name: "test-proj", prefix: "TEST" },
		paths: {
			engineering: "engineering",
			forgeRoot: "/nonexistent/forge-payload",
		},
	};

	if (!opts.omitBaseline) {
		const lines = masterContent.split("\n").filter((l) => l.trim() && !l.trim().startsWith("<!--"));
		const defaultHash = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");

		cfg.calibrationBaseline = {
			lastCalibrated: opts.baselineLastCalibrated ?? "2026-01-01T00:00:00Z",
			version: "0.43.0",
			masterIndexHash: opts.baselineHash !== undefined ? opts.baselineHash : defaultHash,
			sprintsCovered: opts.baselineSprintsCovered ?? [],
		};
	}

	fs.writeFileSync(path.join(proj, ".forge", "config.json"), JSON.stringify(cfg, null, 2), "utf8");

	if (!opts.omitMasterIndex) {
		fs.writeFileSync(path.join(proj, "engineering", "MASTER_INDEX.md"), masterContent, "utf8");
	}

	if (opts.sprints) {
		for (const sprint of opts.sprints) {
			fs.writeFileSync(
				path.join(proj, ".forge", "store", "sprints", `${sprint.sprintId}.json`),
				JSON.stringify(sprint, null, 2),
				"utf8",
			);
		}
	}

	return proj;
}

// ── parseCalibrateFlags ───────────────────────────────────────────────────

describe("parseCalibrateFlags", () => {
	it("returns null path for empty args", () => {
		expect(parseCalibrateFlags("")).toEqual({ path: null });
		expect(parseCalibrateFlags("   ")).toEqual({ path: null });
	});

	it("parses --path with absolute directory", () => {
		expect(parseCalibrateFlags("--path /some/project")).toEqual({ path: "/some/project" });
	});

	it("parses --path with relative directory", () => {
		expect(parseCalibrateFlags("--path ./my-project")).toEqual({ path: "./my-project" });
	});

	it("ignores unknown flags gracefully", () => {
		expect(parseCalibrateFlags("--unknown-flag")).toEqual({ path: null });
	});

	it("handles --path as last arg without value", () => {
		expect(parseCalibrateFlags("--path")).toEqual({ path: null });
	});
});

// ── computeCurrentHash ────────────────────────────────────────────────────

describe("computeCurrentHash", () => {
	it("returns null when MASTER_INDEX.md does not exist", () => {
		const proj = scaffoldProject({ omitMasterIndex: true });
		expect(computeCurrentHash(proj, "engineering")).toBeNull();
	});

	it("strips blank lines and HTML comment lines from hash input", () => {
		const proj = path.join(tmpRoot, "hash-test");
		fs.mkdirSync(path.join(proj, "engineering"), { recursive: true });

		const content = "# Title\n\n<!-- a comment -->\nreal content\n\n";
		fs.writeFileSync(path.join(proj, "engineering", "MASTER_INDEX.md"), content, "utf8");

		const filtered = ["# Title", "real content"].join("\n");
		const expected = crypto.createHash("sha256").update(filtered).digest("hex");

		expect(computeCurrentHash(proj, "engineering")).toBe(expected);
	});

	it("returns deterministic SHA-256 hex string for same content", () => {
		const proj = scaffoldProject();
		const h1 = computeCurrentHash(proj, "engineering");
		const h2 = computeCurrentHash(proj, "engineering");
		expect(h1).toBe(h2);
		expect(typeof h1).toBe("string");
		expect(h1).toHaveLength(64);
	});
});

// ── categorizeDrift ───────────────────────────────────────────────────────

describe("categorizeDrift", () => {
	it("returns at least one category (generic technical fallback) for any hash mismatch", () => {
		const proj = scaffoldProject({
			masterIndexContent: "# MASTER_INDEX\n\nabc123\n",
		});
		const categories = categorizeDrift(proj, "engineering", { sprintsCovered: [] });
		expect(categories.length).toBeGreaterThanOrEqual(1);
	});

	it("returns technical category when index has stack/architecture keywords", () => {
		const proj = scaffoldProject({
			masterIndexContent: "# MASTER_INDEX\n\nstack: nodejs\narchitecture: REST\n",
		});
		const categories = categorizeDrift(proj, "engineering", { sprintsCovered: [] });
		const techCat = categories.find((c) => c.category === "technical");
		expect(techCat).toBeDefined();
		expect(techCat!.targets).toContain("personas:engineer");
		expect(techCat!.targets).toContain("skills:engineer-skills");
	});

	it("returns retrospective category when new completed sprints exist", () => {
		const proj = scaffoldProject({
			masterIndexContent: "# MASTER_INDEX\n\nstack: nodejs\n",
			sprints: [
				{ sprintId: "TEST-S01", status: "done" },
				{ sprintId: "TEST-S02", status: "done" },
			],
		});
		const categories = categorizeDrift(proj, "engineering", { sprintsCovered: [] });
		const retroCat = categories.find((c) => c.category === "retrospective");
		expect(retroCat).toBeDefined();
		expect(retroCat!.evidence).toMatch(/new completed sprint/);
	});

	it("omits retrospective category when all sprints are already covered", () => {
		const proj = scaffoldProject({
			masterIndexContent: "# MASTER_INDEX\n\nabc only\n",
			sprints: [{ sprintId: "TEST-S01", status: "done" }],
		});
		const categories = categorizeDrift(proj, "engineering", {
			sprintsCovered: ["TEST-S01"],
		});
		const retroCat = categories.find((c) => c.category === "retrospective");
		expect(retroCat).toBeUndefined();
	});
});

// ── extractPatchProposals ─────────────────────────────────────────────────

describe("extractPatchProposals", () => {
	it("returns empty array for text with no json blocks", () => {
		expect(extractPatchProposals("No JSON here.")).toEqual([]);
	});

	it("extracts valid patch proposals from json blocks", () => {
		const text = [
			"Analysis complete.",
			"",
			"```json",
			'{"target":"personas:engineer","type":"regenerate","rationale":"Stack changes"}',
			"```",
			"",
			"```json",
			'{"target":"skills:engineer-skills","type":"regenerate","rationale":"Architecture drift"}',
			"```",
		].join("\n");

		const proposals = extractPatchProposals(text);
		expect(proposals).toHaveLength(2);
		expect(proposals[0]).toEqual({
			target: "personas:engineer",
			type: "regenerate",
			rationale: "Stack changes",
		});
		expect(proposals[1]).toEqual({
			target: "skills:engineer-skills",
			type: "regenerate",
			rationale: "Architecture drift",
		});
	});

	it("skips malformed json blocks silently", () => {
		const text = "```json\n{ invalid json \n```";
		expect(extractPatchProposals(text)).toEqual([]);
	});

	it("skips blocks missing required fields", () => {
		const text = '```json\n{ "target": "foo" }\n```';
		expect(extractPatchProposals(text)).toEqual([]);
	});
});

// ── EXPLICITLY_REGISTERED_NAMES guard ────────────────────────────────────

describe("EXPLICITLY_REGISTERED_NAMES", () => {
	it("does NOT register forge:calibrate as a command in v1.0 (removed FORGE-S26-T10; handler reused by /forge:health --fix)", () => {
		expect(forgeCommandsTest.EXPLICITLY_REGISTERED_NAMES.has("forge:calibrate")).toBe(false);
	});
});

// ── 4-phase integration test ──────────────────────────────────────────────

describe("registerCalibrate — 4-phase integration (non-interactive, mocked subagent)", () => {
	it("detects drift, calls architect subagent, applies patches, updates baseline and history", async () => {
		// Scaffold a project with stale baseline hash (forces drift detection)
		const proj = scaffoldProject({
			baselineHash: "0000000000000000000000000000000000000000000000000000000000000000",
			masterIndexContent: "# MASTER_INDEX\n\nstack: nodejs\narchitecture: REST\n",
			baselineSprintsCovered: [],
			sprints: [{ sprintId: "TEST-S01", status: "done" }],
		});

		// Set non-interactive mode
		const oldForgeYes = process.env.FORGE_YES;
		process.env.FORGE_YES = "1";

		try {
			const notifyCalls: Array<[string, string]> = [];
			const ctx = {
				signal: undefined,
				waitForIdle: vi.fn().mockResolvedValue(undefined),
				ui: {
					notify: vi.fn((msg: string, level: string) => {
						notifyCalls.push([msg, level]);
					}),
					confirm: vi.fn().mockResolvedValue(true),
					setStatus: vi.fn(),
				},
			} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;

			type CommandHandler = (
				args: string,
				ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
			) => Promise<void>;
			const registeredCommands: Array<{ name: string; handler: CommandHandler }> = [];
			const pi = {
				registerCommand: vi.fn((name: string, opts: { handler: CommandHandler }) => {
					registeredCommands.push({ name, handler: opts.handler });
				}),
				sendUserMessage: vi.fn().mockResolvedValue(undefined),
			} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

			registerCalibrate(pi);

			const calibrateCmd = registeredCommands.find((c) => c.name === "forge:calibrate");
			expect(calibrateCmd).toBeDefined();

			// Override process.cwd for the handler
			const origCwd = process.cwd;
			process.cwd = () => proj;
			try {
				await calibrateCmd!.handler("", ctx);
			} finally {
				process.cwd = origCwd;
			}

			// Verify calibrationBaseline was updated (hash no longer all-zeros)
			const updatedCfg = JSON.parse(fs.readFileSync(path.join(proj, ".forge", "config.json"), "utf8")) as {
				calibrationBaseline?: { masterIndexHash?: string };
				calibrationHistory?: unknown[];
			};

			expect(updatedCfg.calibrationBaseline?.masterIndexHash).not.toBe(
				"0000000000000000000000000000000000000000000000000000000000000000",
			);
			expect(updatedCfg.calibrationBaseline?.masterIndexHash).toBeDefined();

			// Verify calibrationHistory has one entry
			expect(Array.isArray(updatedCfg.calibrationHistory)).toBe(true);
			expect(updatedCfg.calibrationHistory!.length).toBe(1);

			// Verify the completion summary was notified
			const completionNotify = notifyCalls.find(([msg]) => msg.includes("Calibration Complete"));
			expect(completionNotify).toBeDefined();
		} finally {
			process.env.FORGE_YES = oldForgeYes;
		}
	});
});

// ── N-H-A regression: isNonInteractive imported from run-task (FORGE-S25-T18) ──

describe("regression: isNonInteractive from run-task.ts", () => {
	it("FORGE_YES=1 triggers non-interactive mode via the shared isNonInteractive()", async () => {
		// Before T18, calibrate.ts defined its own isNonInteractive(). After T18 it
		// imports the shared one from run-task.ts. This test verifies the shared
		// function behaves correctly when activated by FORGE_YES=1.
		const { isNonInteractive } = await import("../../../src/extensions/forgecli/orchestrators/run-task.js");

		const old = process.env.FORGE_YES;
		try {
			process.env.FORGE_YES = "1";
			expect(isNonInteractive()).toBe(true);

			process.env.FORGE_YES = "0";
			expect(isNonInteractive()).toBe(false);

			delete process.env.FORGE_YES;
			expect(isNonInteractive()).toBe(false);
		} finally {
			if (old === undefined) {
				delete process.env.FORGE_YES;
			} else {
				process.env.FORGE_YES = old;
			}
		}
	});

	it("FORGE_NON_INTERACTIVE=1 triggers non-interactive mode via the shared isNonInteractive()", async () => {
		const { isNonInteractive } = await import("../../../src/extensions/forgecli/orchestrators/run-task.js");

		const old = process.env.FORGE_NON_INTERACTIVE;
		try {
			process.env.FORGE_NON_INTERACTIVE = "1";
			expect(isNonInteractive()).toBe(true);

			process.env.FORGE_NON_INTERACTIVE = "0";
			expect(isNonInteractive()).toBe(false);
		} finally {
			if (old === undefined) {
				delete process.env.FORGE_NON_INTERACTIVE;
			} else {
				process.env.FORGE_NON_INTERACTIVE = old;
			}
		}
	});
});
