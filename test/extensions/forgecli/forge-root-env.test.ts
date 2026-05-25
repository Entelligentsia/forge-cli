// forge-root-env.test.ts — forge-cli#28.
//
// Asserts the contract: when forge-cli activates inside a Forge project,
// process.env.FORGE_ROOT is set to the absolute path resolved from
// .forge/config.json's paths.forgeRoot. This unblocks kickoff handlers
// (e.g. /forge:enhance) whose workflow bodies use $FORGE_ROOT/... in
// bash command literals.
//
// Subagent dispatch path (runForgeSubagent) already sets this; this test
// covers the main-thread / kickoff handler path that was previously missing.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist a Proxy-backed mock pi that accepts every method call as a no-op,
// recording on() handlers for assertion. Using a Proxy avoids having to mirror
// pi-coding-agent's full surface (registerCommand, registerTool, registerMessageRenderer,
// registerStatusBarItem, etc.) — activate() touches many APIs and we only care
// about the FORGE_ROOT side effect here.
const { mockPi } = vi.hoisted(() => {
	const handlers: Array<{ event: string; handler: unknown }> = [];
	const target = {
		handlers,
		on: (event: string, handler: unknown) => {
			handlers.push({ event, handler });
		},
	};
	const proxy = new Proxy(target, {
		get(t, prop) {
			if (prop in t) return (t as Record<string | symbol, unknown>)[prop];
			// Any unmocked method: return a no-op that accepts and discards args.
			return () => undefined;
		},
	});
	return { mockPi: proxy };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createAgentSession: vi.fn(async () => ({ session: {} })),
		AuthStorage: { create: () => ({}) },
		ModelRegistry: { create: () => ({}) },
		SessionManager: { inMemory: () => ({}) },
		DefaultResourceLoader: class {
			async reload() {}
		},
		getAgentDir: () => "/tmp/agent-dir",
	};
});

// Import after the mock is registered.
const { default: forgecli } = await import("../../../src/extensions/forgecli/index.js");

describe("forge-cli#28 — process.env.FORGE_ROOT injection on activate", () => {
	let tmp: string;
	let originalCwd: string;
	let originalForgeRoot: string | undefined;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalForgeRoot = process.env.FORGE_ROOT;
		delete process.env.FORGE_ROOT;

		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-env-test-"));
		fs.mkdirSync(path.join(tmp, ".forge"), { recursive: true });

		// Reset the captured handlers between tests.
		mockPi.handlers.length = 0;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalForgeRoot === undefined) delete process.env.FORGE_ROOT;
		else process.env.FORGE_ROOT = originalForgeRoot;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("sets FORGE_ROOT in env when activating inside a Forge project", async () => {
		// Arrange: a Forge project with an absolute forgeRoot
		const payloadDir = path.join(tmp, "bundled-payload");
		fs.mkdirSync(payloadDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".forge", "config.json"),
			JSON.stringify({
				paths: { forgeRoot: payloadDir },
			}),
			"utf8",
		);
		process.chdir(tmp);

		// Act
		await forgecli(mockPi as never);

		// Assert
		expect(process.env.FORGE_ROOT).toBe(payloadDir);
	});

	it("does NOT set FORGE_ROOT when no .forge/config.json is found", async () => {
		// Arrange: empty dir (no Forge project)
		process.chdir(tmp);
		fs.rmSync(path.join(tmp, ".forge"), { recursive: true });

		// Act
		await forgecli(mockPi as never);

		// Assert
		expect(process.env.FORGE_ROOT).toBeUndefined();
	});

	it("resolves a relative forgeRoot to an absolute path", async () => {
		// Arrange: relative forgeRoot pointing at ./bundled
		fs.mkdirSync(path.join(tmp, "bundled"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".forge", "config.json"),
			JSON.stringify({
				paths: { forgeRoot: "./bundled" },
			}),
			"utf8",
		);
		process.chdir(tmp);

		// Act
		await forgecli(mockPi as never);

		// Assert — should be absolute
		expect(process.env.FORGE_ROOT).toBeDefined();
		expect(path.isAbsolute(process.env.FORGE_ROOT!)).toBe(true);
		expect(process.env.FORGE_ROOT).toBe(path.join(tmp, "bundled"));
	});

	it("registers a before_agent_start handler that prepends orientation", async () => {
		// Sanity check that the orientation wiring co-located with env injection
		// still fires (regression guard for the new code path).
		const payloadDir = path.join(tmp, "p");
		fs.mkdirSync(payloadDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".forge", "config.json"),
			JSON.stringify({ paths: { forgeRoot: payloadDir } }),
			"utf8",
		);
		process.chdir(tmp);

		await forgecli(mockPi as never);

		const beforeStartHandlers = mockPi.handlers.filter((h) => h.event === "before_agent_start");
		expect(beforeStartHandlers.length).toBeGreaterThanOrEqual(1);
	});
});
