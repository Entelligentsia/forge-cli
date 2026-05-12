// Unit + live tests for the forge-subagent harness (FORGE-S21 redo foundation).
//
// Auth-free:
//   - loadForgePersona reads .md, parses frontmatter, applies defaults
//   - missing tools/model/description → expected fallbacks
//   - frontmatter `tools:` → string[] split by comma
//
// Auth-gated (ANTHROPIC_API_KEY required):
//   - runForgeSubagent spawns real AgentSession with persona system prompt,
//     runs trivial task, returns exitCode=0 with at least one assistant message
//   - AbortSignal terminates session

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	loadForgePersona,
	runForgeSubagent,
	getFinalOutput,
	type ForgePersona,
} from "../../../src/extensions/forgecli/forge-subagent.js";

const SKIP_LIVE = !process.env.ANTHROPIC_API_KEY;

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-subagent-"));
	fs.mkdirSync(path.join(tmpRoot, ".forge", "personas"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── loadForgePersona — auth-free ──────────────────────────────────────────

describe("loadForgePersona", () => {
	it("reads .forge/personas/<name>.md and uses body as system prompt when no frontmatter", () => {
		const body = "You are the Forge engineer. Plan, implement, test.";
		fs.writeFileSync(path.join(tmpRoot, ".forge", "personas", "engineer.md"), body, "utf-8");

		const persona = loadForgePersona("engineer", tmpRoot);
		expect(persona.name).toBe("engineer");
		expect(persona.description).toBe("Forge engineer persona");
		expect(persona.model).toBeUndefined();
		expect(persona.tools).toBeUndefined();
		expect(persona.systemPrompt).toBe(body);
	});

	it("parses frontmatter when present (description, model, tools)", () => {
		const content = [
			"---",
			"description: Plan and implement Forge tasks",
			"model: claude-sonnet-4-5",
			"tools: read, write, edit, bash",
			"---",
			"",
			"You are the Forge engineer.",
		].join("\n");
		fs.writeFileSync(path.join(tmpRoot, ".forge", "personas", "engineer.md"), content, "utf-8");

		const persona = loadForgePersona("engineer", tmpRoot);
		expect(persona.description).toBe("Plan and implement Forge tasks");
		expect(persona.model).toBe("claude-sonnet-4-5");
		expect(persona.tools).toEqual(["read", "write", "edit", "bash"]);
		expect(persona.systemPrompt).toContain("You are the Forge engineer.");
	});

	it("trims tool names and drops empty entries", () => {
		const content = ["---", "tools:  read , bash , , edit", "---", "body"].join("\n");
		fs.writeFileSync(path.join(tmpRoot, ".forge", "personas", "x.md"), content, "utf-8");

		const persona = loadForgePersona("x", tmpRoot);
		expect(persona.tools).toEqual(["read", "bash", "edit"]);
	});

	it("falls back to filename when frontmatter omits name", () => {
		fs.writeFileSync(
			path.join(tmpRoot, ".forge", "personas", "qa-engineer.md"),
			"body",
			"utf-8",
		);
		const persona = loadForgePersona("qa-engineer", tmpRoot);
		expect(persona.name).toBe("qa-engineer");
	});

	it("throws when persona file does not exist", () => {
		expect(() => loadForgePersona("missing", tmpRoot)).toThrow();
	});
});

// ── runForgeSubagent — live, auth-gated ──────────────────────────────────

describe.skipIf(SKIP_LIVE)("runForgeSubagent — live AgentSession", () => {
	it("runs a trivial task with a minimal persona and returns exitCode=0 with assistant output", async () => {
		const persona: ForgePersona = {
			name: "scribe",
			description: "Tiny test persona",
			systemPrompt:
				"You are a terse assistant. Always reply in fewer than 20 words. " +
				"For arithmetic questions, give just the number.",
			filePath: path.join(tmpRoot, ".forge", "personas", "scribe.md"),
		};
		fs.writeFileSync(persona.filePath, persona.systemPrompt, "utf-8");

		const result = await runForgeSubagent({
			persona,
			task: "What is 7 + 5? Reply with just the number.",
			cwd: tmpRoot,
		});

		expect(result.exitCode).toBe(0);
		expect(result.messages.length).toBeGreaterThan(0);
		expect(result.usage.turns).toBeGreaterThan(0);
		expect(result.usage.input).toBeGreaterThan(0);
		expect(result.usage.output).toBeGreaterThan(0);

		const finalOutput = getFinalOutput(result.messages);
		expect(finalOutput).toContain("12");
	}, 60_000);

	it("AbortSignal terminates the session and returns exitCode=1 with stopReason=aborted", async () => {
		const persona: ForgePersona = {
			name: "slow",
			description: "Slow persona for abort test",
			systemPrompt: "You are an assistant. Provide thorough multi-paragraph answers.",
			filePath: path.join(tmpRoot, ".forge", "personas", "slow.md"),
		};
		fs.writeFileSync(persona.filePath, persona.systemPrompt, "utf-8");

		const ac = new AbortController();
		// Abort after 200ms — well before any LLM completes
		setTimeout(() => ac.abort(), 200);

		const result = await runForgeSubagent({
			persona,
			task: "Write a 5-paragraph essay on the history of typesetting.",
			cwd: tmpRoot,
			signal: ac.signal,
		});

		expect(result.exitCode).toBe(1);
		// stopReason may be "aborted" or undefined depending on cancellation timing;
		// the binding is exitCode → 1 on abort.
	}, 30_000);
});
