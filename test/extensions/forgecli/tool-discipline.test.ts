// tool-discipline.test.ts
// Tests for forge tool discipline injection (FORGE-S26-T16).
// Verifies that registerForgeToolDiscipline reads the canonical fragment when
// available, and falls back to the hardcoded FORGE_TOOL_DISCIPLINE constant
// when the fragment is missing.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORGE_TOOL_DISCIPLINE } from "../../../src/extensions/forgecli/forge-tools.js";

// ── Sentinel string ──────────────────────────────────────────────────────────
// A distinctive phrase that exists in both the fragment file and the hardcoded
// constant. Used to verify read correctness.
const SENTINEL = "forge_store";

// ── Helpers ──────────────────────────────────────────────────────────────────

type PiEventHandler = (event: { systemPrompt?: string }) => Promise<{ systemPrompt: string }>;

function makePiMock() {
	let capturedHandler: PiEventHandler | null = null;
	const piMock = {
		registerTool: vi.fn(),
		on: vi.fn().mockImplementation((_event: string, handler: PiEventHandler) => {
			capturedHandler = handler;
		}),
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	return { piMock, getHandler: () => capturedHandler };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FORGE_TOOL_DISCIPLINE constant", () => {
	it("contains the forge_store sentinel string", () => {
		expect(FORGE_TOOL_DISCIPLINE).toContain(SENTINEL);
	});
});

describe("registerForgeToolDiscipline — fragment file present", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-discipline-test-"));
		// Create meta/fragments/tool-discipline.md under tmpDir as if it were toolDir
		// toolDir/../meta/fragments/tool-discipline.md means:
		// if toolDir = tmpDir/tools, then fragment = tmpDir/meta/fragments/tool-discipline.md
		const toolDir = path.join(tmpDir, "tools");
		const fragmentDir = path.join(tmpDir, "meta", "fragments");
		fs.mkdirSync(toolDir, { recursive: true });
		fs.mkdirSync(fragmentDir, { recursive: true });
		fs.writeFileSync(
			path.join(fragmentDir, "tool-discipline.md"),
			"## Forge Tool Discipline\n\nCanonical fragment sentinel: forge_store is the correct way.\n",
			"utf8",
		);
	});

	afterEach(() => {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads from fragment file when it exists", async () => {
		const { registerForgeTools } = await import("../../../src/extensions/forgecli/forge-tools.js");

		const { piMock, getHandler } = makePiMock();

		// registerForgeTools needs a forge path. We use toolDir as the forgeRoot
		// so resolveToolDir(forgeRoot) points to toolDir.
		// resolveToolDir checks if path.join(forgeRoot, "tools") is a directory.
		// We'll pass tmpDir as forgeRoot so toolDir = tmpDir/tools.
		registerForgeTools(piMock, tmpDir, "/fake/project");

		const handler = getHandler();
		expect(handler).not.toBeNull();

		const result = await handler!({ systemPrompt: "" });
		expect(result.systemPrompt).toContain(SENTINEL);
		expect(result.systemPrompt).toContain("Canonical fragment sentinel");
	});
});

describe("registerForgeToolDiscipline — fragment file missing (fallback)", () => {
	it("falls back to hardcoded FORGE_TOOL_DISCIPLINE when fragment is missing", async () => {
		const { registerForgeTools } = await import("../../../src/extensions/forgecli/forge-tools.js");

		const { piMock, getHandler } = makePiMock();

		// Use a path that has no meta/fragments/tool-discipline.md
		const fakeForgePath = "/non-existent/forge/path";
		registerForgeTools(piMock, fakeForgePath, "/fake/project");

		const handler = getHandler();
		expect(handler).not.toBeNull();

		const result = await handler!({ systemPrompt: "" });
		// The fallback text should contain the sentinel
		expect(result.systemPrompt).toContain(SENTINEL);
		// And must exactly match the fallback constant (string equality for the injected portion)
		expect(result.systemPrompt).toContain(FORGE_TOOL_DISCIPLINE.trim());
	});
});
