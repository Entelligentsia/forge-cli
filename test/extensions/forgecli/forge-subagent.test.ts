// Unit tests for the forge-subagent harness (FORGE-S21 redo foundation).
//
// Auth-free:
//   - loadForgePersona reads .md, parses frontmatter, applies defaults
//   - missing tools/model/description → expected fallbacks
//   - frontmatter `tools:` → string[] split by comma
//
// NO live-provider tests. Unit tests must never call a live LLM provider —
// no API spend, no network dependency, no provider bias. (The previous
// live block, gated on ANTHROPIC_API_KEY, silently routed to Anthropic
// because a bare runForgeSubagent without modelRegistry falls back to
// "first provider with valid API key" — see RunSubagentOptions.modelRegistry
// doc in forge-subagent.ts. A local-Ollama replacement was attempted and
// dropped: ollama 0.20.x hangs on stream:true + tools, which pi always
// sends.) Live coverage of runForgeSubagent belongs in the e2e smoke
// driver, not in vitest.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadForgePersona } from "../../../src/extensions/forgecli/forge-subagent.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-subagent-"));
	fs.mkdirSync(path.join(tmpRoot, ".forge", "personas"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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
		fs.writeFileSync(path.join(tmpRoot, ".forge", "personas", "qa-engineer.md"), "body", "utf-8");
		const persona = loadForgePersona("qa-engineer", tmpRoot);
		expect(persona.name).toBe("qa-engineer");
	});

	it("throws when persona file does not exist", () => {
		expect(() => loadForgePersona("missing", tmpRoot)).toThrow();
	});
});
