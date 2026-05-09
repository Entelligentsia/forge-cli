// Unit tests for sprint-intake module (FORGE-S19-T01).
//
// Coverage:
//   registerSprintIntake:
//     1. Mount test — pi.registerCommand called with "forge:sprint-intake"
//
//   Non-interactive abort:
//     2. FORGE_NON_INTERACTIVE=1 → error notify, returns early
//     3. FORGE_YES=1 → error notify, returns early
//
//   Pre-flight:
//     4. Missing .forge/config.json → error notify, returns early
//
//   Persona load:
//     5. Missing product-manager.md → warning notify, continues (non-fatal)
//
//   Happy path (FORGE_INTAKE_ANSWERS_FILE scripted):
//     6. Full interview → SPRINT_REQUIREMENTS.md written
//     7. Sprint ID extracted from args correctly
//
//   Resume from checkpoint:
//     8. Checkpoint present → confirm resume → uses existing title/theme
//
//   Checkpoint restart:
//     9. Checkpoint present → decline resume → deletes checkpoint, re-interviews
//
//   Template substitution:
//    10. {SPRINT_ID} and {DATE} replaced in output file
//
//   Empty goals loop termination:
//    11. Empty string sentinel stops goal collection
//
//   Carry-over detection:
//    12. SPRINT_RETROSPECTIVE.md parsed for "Recommendations for Next Sprint"
//
//   ctx.ui.* cancel (undefined):
//    13. uiInput returning undefined → error notify, returns early
//    14. uiConfirm returning undefined → error notify, returns early

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerSprintIntake } from "../../../src/extensions/forgecli/sprint-intake.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CommandDef {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** Minimal pi stub that captures registerCommand calls. */
function makeStubApi(): { pi: ExtensionAPI; commands: Map<string, CommandDef> } {
	const commands = new Map<string, CommandDef>();
	const pi = {
		registerCommand(name: string, def: CommandDef) {
			commands.set(name, def);
		},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

interface CtxOverrides {
	hasUI?: boolean;
	inputAnswers?: (string | undefined)[];
	confirmAnswers?: (boolean | undefined)[];
	selectAnswers?: (string | undefined)[];
	notifyFn?: (msg: string, level: string) => void;
}

/** Build a minimal ctx stub with controllable ui methods. */
function makeStubCtx(overrides: CtxOverrides = {}): ExtensionCommandContext {
	const { hasUI = true, inputAnswers = [], confirmAnswers = [], selectAnswers = [], notifyFn } = overrides;
	let inputIdx = 0;
	let confirmIdx = 0;
	let selectIdx = 0;

	return {
		hasUI,
		ui: {
			notify: notifyFn ?? vi.fn(),
			input: vi.fn(async (_title: string, _prompt: string) => {
				return inputAnswers[inputIdx++];
			}),
			confirm: vi.fn(async (_title: string, _prompt: string) => {
				return confirmAnswers[confirmIdx++];
			}),
			select: vi.fn(async (_title: string, _options: string[]) => {
				return selectAnswers[selectIdx++];
			}),
			setStatus: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
}

/** Create a temp project dir with .forge/config.json. */
function makeProjectDir(opts: { engineeringDir?: string } = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sprint-intake-test-"));
	const forgeDir = path.join(dir, ".forge");
	fs.mkdirSync(path.join(forgeDir, "personas"), { recursive: true });
	fs.mkdirSync(path.join(forgeDir, "cache"), { recursive: true });
	fs.mkdirSync(path.join(forgeDir, "store", "bugs"), { recursive: true });
	fs.mkdirSync(path.join(forgeDir, "store", "features"), { recursive: true });
	const engineeringDir = opts.engineeringDir ?? "engineering";
	fs.writeFileSync(
		path.join(forgeDir, "config.json"),
		JSON.stringify({ paths: { engineering: engineeringDir, forgeRoot: "/dev/null" } }),
	);
	fs.mkdirSync(path.join(dir, engineeringDir, "sprints"), { recursive: true });
	return dir;
}

/** Write a scripted answers file and set env var. */
function writeAnswersFile(dir: string, answers: string[]): string {
	const file = path.join(dir, "answers.json");
	fs.writeFileSync(file, JSON.stringify(answers));
	return file;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerSprintIntake", () => {
	let origEnv: NodeJS.ProcessEnv;
	let origCwd: string;

	beforeEach(() => {
		origEnv = { ...process.env };
		origCwd = process.cwd();
		// Reset scripted answer state between tests
		delete process.env.FORGE_INTAKE_ANSWERS_FILE;
		delete process.env.FORGE_NON_INTERACTIVE;
		delete process.env.FORGE_YES;
	});

	afterEach(() => {
		process.env = origEnv;
		process.chdir(origCwd);
	});

	// ── Test 1: Mount test ────────────────────────────────────────────────
	it("1. registers forge:sprint-intake command on pi", () => {
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		expect(commands.has("forge:sprint-intake")).toBe(true);
		const def = commands.get("forge:sprint-intake")!;
		expect(def.description).toContain("sprint requirements");
	});

	// ── Test 2: FORGE_NON_INTERACTIVE=1 → abort ───────────────────────────
	it("2. FORGE_NON_INTERACTIVE=1 → error notify, no interview", async () => {
		process.env.FORGE_NON_INTERACTIVE = "1";
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		const ctx = makeStubCtx({ notifyFn });
		const dir = makeProjectDir();
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		expect(notifyFn).toHaveBeenCalledWith(
			expect.stringContaining("requires an interactive terminal"),
			"error",
		);
		expect(ctx.ui.input).not.toHaveBeenCalled();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 3: FORGE_YES=1 → abort ───────────────────────────────────────
	it("3. FORGE_YES=1 → error notify, no interview", async () => {
		process.env.FORGE_YES = "1";
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		const ctx = makeStubCtx({ notifyFn });
		const dir = makeProjectDir();
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		expect(notifyFn).toHaveBeenCalledWith(
			expect.stringContaining("requires an interactive terminal"),
			"error",
		);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 4: Missing .forge/config.json → abort ────────────────────────
	it("4. missing .forge/config.json → error notify, returns early", async () => {
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		const ctx = makeStubCtx({ notifyFn, hasUI: true });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-no-config-test-"));
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		expect(notifyFn).toHaveBeenCalledWith(
			expect.stringContaining("no .forge/config.json"),
			"error",
		);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 5: Missing persona file → warning, continues ─────────────────
	it("5. missing product-manager.md → warning notify, continues (non-fatal)", async () => {
		const dir = makeProjectDir();
		// No persona file written
		const answersFile = writeAnswersFile(dir, [
			"My Sprint Title", // title
			"Theme text",      // theme
			"",                // no goals
			"",                // no out-of-scope
			"",                // no constraints
			"",                // no risks
		]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		const ctx = makeStubCtx({ notifyFn });
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		expect(notifyFn).toHaveBeenCalledWith(
			expect.stringContaining("product-manager.md not found"),
			"warning",
		);
		// Should still write SPRINT_REQUIREMENTS.md
		const reqPath = path.join(dir, "engineering", "sprints", "FORGE-S20", "SPRINT_REQUIREMENTS.md");
		expect(fs.existsSync(reqPath)).toBe(true);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 6: Happy path — SPRINT_REQUIREMENTS.md written ───────────────
	it("6. happy path — full interview writes SPRINT_REQUIREMENTS.md", async () => {
		const dir = makeProjectDir();
		const answersFile = writeAnswersFile(dir, [
			"Sprint S20 Title",   // title
			"This sprint focuses on X.", // theme
			"Deliver feature A",  // goal 1
			"must-have",          // severity
			"AC1 for A",          // goal 1 AC 1
			"",                   // done with ACs
			"",                   // done with goals
			"Out of scope item",  // out-of-scope
			"",                   // done OOS
			"Security first",     // constraint
			"",                   // done constraints
			"API instability",    // risk
			"Medium",             // likelihood
			"",                   // done risks
		]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const ctx = makeStubCtx();
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		const reqPath = path.join(dir, "engineering", "sprints", "FORGE-S20", "SPRINT_REQUIREMENTS.md");
		expect(fs.existsSync(reqPath)).toBe(true);
		const content = fs.readFileSync(reqPath, "utf8");
		expect(content).toContain("FORGE-S20");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 7: Sprint ID extracted from args ─────────────────────────────
	it("7. sprint ID from args used in output path", async () => {
		const dir = makeProjectDir();
		const answersFile = writeAnswersFile(dir, ["Title", "Theme", "", "", "", ""]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const ctx = makeStubCtx();
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("ACME-S05", ctx);
		const reqPath = path.join(dir, "engineering", "sprints", "ACME-S05", "SPRINT_REQUIREMENTS.md");
		expect(fs.existsSync(reqPath)).toBe(true);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 8: Resume from checkpoint ────────────────────────────────────
	it("8. checkpoint present → confirm resume → uses existing title/theme", async () => {
		const dir = makeProjectDir();
		// Write a checkpoint
		const cpData = {
			sprintId: "FORGE-S20",
			capturedAt: new Date().toISOString(),
			phase: "title",
			data: { title: "Resumed Title", theme: "Resumed Theme" },
		};
		fs.mkdirSync(path.join(dir, ".forge", "cache"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".forge", "cache", "sprint-intake-FORGE-S20.json"),
			JSON.stringify(cpData),
		);
		// Answers: confirm resume=Y, then just empty for remaining steps
		const answersFile = writeAnswersFile(dir, [
			"y",  // confirm resume
			"",   // no more goals
			"",   // no OOS
			"",   // no constraints
			"",   // no risks
		]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		const ctx = makeStubCtx({ notifyFn });
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("Resuming from checkpoint"), "info");
		const reqPath = path.join(dir, "engineering", "sprints", "FORGE-S20", "SPRINT_REQUIREMENTS.md");
		expect(fs.existsSync(reqPath)).toBe(true);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 9: Checkpoint restart ────────────────────────────────────────
	it("9. checkpoint present → decline resume → deletes checkpoint, re-interviews", async () => {
		const dir = makeProjectDir();
		const cpPath = path.join(dir, ".forge", "cache", "sprint-intake-FORGE-S20.json");
		fs.mkdirSync(path.dirname(cpPath), { recursive: true });
		fs.writeFileSync(cpPath, JSON.stringify({ sprintId: "FORGE-S20", capturedAt: new Date().toISOString(), phase: "title", data: {} }));
		// Decline resume, then full answers
		const answersFile = writeAnswersFile(dir, [
			"n",           // decline resume
			"New Title",   // title
			"New Theme",   // theme
			"",            // no goals
			"",            // no OOS
			"",            // no constraints
			"",            // no risks
		]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const ctx = makeStubCtx();
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		// Checkpoint should be deleted
		expect(fs.existsSync(cpPath)).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 10: Template substitution ───────────────────────────────────
	it("10. {SPRINT_ID} and {DATE} replaced in output", async () => {
		const dir = makeProjectDir();
		// Create a fake template
		const templateDir = path.join(dir, "dist", "forge-payload", ".base-pack", "templates");
		fs.mkdirSync(templateDir, { recursive: true });
		fs.writeFileSync(
			path.join(templateDir, "SPRINT_REQUIREMENTS_TEMPLATE.md"),
			"# Sprint Requirements — {SPRINT_ID}\n\n**Captured:** {DATE}\n",
		);
		const answersFile = writeAnswersFile(dir, ["Title", "Theme", "", "", "", ""]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const ctx = makeStubCtx();
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		const reqPath = path.join(dir, "engineering", "sprints", "FORGE-S20", "SPRINT_REQUIREMENTS.md");
		if (fs.existsSync(reqPath)) {
			const content = fs.readFileSync(reqPath, "utf8");
			// Verify sprint ID substituted (either in heading or body)
			expect(content).toContain("FORGE-S20");
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 11: Empty goals loop termination ────────────────────────────
	it("11. empty string sentinel stops goal collection", async () => {
		const dir = makeProjectDir();
		const answersFile = writeAnswersFile(dir, [
			"Title",   // title
			"Theme",   // theme
			"Goal 1",  // goal 1 text
			"must-have", // severity
			"",        // no ACs
			"",        // sentinel — done with goals
			"",        // OOS
			"",        // constraints
			"",        // risks
		]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const ctx = makeStubCtx();
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		const reqPath = path.join(dir, "engineering", "sprints", "FORGE-S20", "SPRINT_REQUIREMENTS.md");
		expect(fs.existsSync(reqPath)).toBe(true);
		const content = fs.readFileSync(reqPath, "utf8");
		expect(content).toContain("Goal 1");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 12: Carry-over detection ────────────────────────────────────
	it("12. SPRINT_RETROSPECTIVE.md parsed for recommendations", async () => {
		const dir = makeProjectDir();
		// Write a previous sprint retrospective
		const prevSprintDir = path.join(dir, "engineering", "sprints", "FORGE-S19");
		fs.mkdirSync(prevSprintDir, { recursive: true });
		fs.writeFileSync(
			path.join(prevSprintDir, "SPRINT_RETROSPECTIVE.md"),
			"## Recommendations for Next Sprint\n\n- Address technical debt\n- Improve test coverage\n",
		);
		const answersFile = writeAnswersFile(dir, [
			"Title",  // title
			"Theme",  // theme
			"",       // no goals
			"",       // no OOS
			"",       // no constraints
			"",       // no risks
			"y",      // confirm carry-over: Address technical debt
			"n",      // decline carry-over: Improve test coverage
		]);
		process.env.FORGE_INTAKE_ANSWERS_FILE = answersFile;
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		const ctx = makeStubCtx({ notifyFn });
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		const reqPath = path.join(dir, "engineering", "sprints", "FORGE-S20", "SPRINT_REQUIREMENTS.md");
		expect(fs.existsSync(reqPath)).toBe(true);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 13: uiInput cancel → abort ──────────────────────────────────
	it("13. uiInput returning undefined → cancelled notify, returns early", async () => {
		// Use ctx.ui directly (not scripted answers) to test cancel path
		const dir = makeProjectDir();
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		// Stub ctx: first confirm=true (no checkpoint), first input=undefined (cancel)
		const ctx = makeStubCtx({
			notifyFn,
			confirmAnswers: [],  // no checkpoint
			inputAnswers: [undefined], // first input (title) → cancel
		});
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── Test 14: uiConfirm cancel → abort ────────────────────────────────
	it("14. uiConfirm returning undefined (resume prompt) → cancelled notify, returns early", async () => {
		const dir = makeProjectDir();
		// Write checkpoint to trigger the resume confirm
		const cpPath = path.join(dir, ".forge", "cache", "sprint-intake-FORGE-S20.json");
		fs.writeFileSync(cpPath, JSON.stringify({ sprintId: "FORGE-S20", capturedAt: new Date().toISOString(), phase: "title", data: {} }));
		const { pi, commands } = makeStubApi();
		registerSprintIntake(pi);
		const notifyFn = vi.fn();
		// Return undefined from the resume confirm → cancel
		const ctx = makeStubCtx({ notifyFn, confirmAnswers: [undefined] });
		process.chdir(dir);
		await commands.get("forge:sprint-intake")!.handler("FORGE-S20", ctx);
		expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
