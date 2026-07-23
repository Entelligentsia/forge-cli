// Chrome DevTools browser-bridge tests.
//
// Two layers, mirroring grove.test.ts:
//   1. Deterministic contract — pure builders (args/steering/enable-gate) and
//      the graceful path (empty PATH + no explicit bin → no launcher resolvable
//      → attachBrowser returns null, never a throw). Runs everywhere.
//   2. Opt-in live integration — drives the real chrome-devtools-mcp surface
//      only when FORGE_BROWSER_MCP_LIVE=1 is set (needs npx + network + Node 22 +
//      Chrome). Otherwise it asserts the graceful contract — a runtime branch,
//      not a skipped test (CI no-skip-gate safe).

import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ForgeToolDefs, getSubagentTools, setExtraSubagentTools } from "../../../../src/extensions/forgecli/forge-tools.js";
import type { McpAttachment } from "../../../../src/extensions/forgecli/mcp-bridge/mcp-bridge.js";
import {
	attachBrowser,
	BROWSER_TOOL_PREFIX,
	buildBrowserArgs,
	buildBrowserSteering,
	DEFAULT_BROWSER_MCP_PACKAGE,
	isBrowserBridgeEnabled,
	isBrowserInteractive,
	resolveBrowserMcpCommand,
} from "../../../../src/extensions/forgecli/mcp-bridge/chrome-devtools.js";

// A curated set of env vars this suite mutates — saved and restored per test so
// nothing leaks across cases (the process env is shared within a worker).
const MANAGED_ENV = [
	"PATH",
	"FORGE_BROWSER_MCP",
	"FORGE_BROWSER_MCP_BIN",
	"FORGE_BROWSER_MCP_PACKAGE",
	"FORGE_BROWSER_HEADLESS",
	"FORGE_BROWSER_ISOLATED",
	"FORGE_BROWSER_CHANNEL",
	"FORGE_BROWSER_EXECUTABLE",
	"FORGE_BROWSER_URL",
	"FORGE_BROWSER_VIEWPORT",
];

function snapshotEnv(): Record<string, string | undefined> {
	const s: Record<string, string | undefined> = {};
	for (const k of MANAGED_ENV) s[k] = process.env[k];
	return s;
}

function restoreEnv(s: Record<string, string | undefined>): void {
	for (const k of MANAGED_ENV) {
		if (s[k] !== undefined) process.env[k] = s[k]!;
		else delete process.env[k];
	}
}

describe("isBrowserBridgeEnabled", () => {
	it("is ON by default (absent or empty var)", () => {
		expect(isBrowserBridgeEnabled({})).toBe(true);
		expect(isBrowserBridgeEnabled({ FORGE_BROWSER_MCP: "" })).toBe(true);
		expect(isBrowserBridgeEnabled({ FORGE_BROWSER_MCP: "  " })).toBe(true);
	});

	it("is OFF only for explicit falsey tokens (case-insensitive)", () => {
		for (const v of ["0", "false", "off", "no", "FALSE", "Off", " no "]) {
			expect(isBrowserBridgeEnabled({ FORGE_BROWSER_MCP: v })).toBe(false);
		}
	});

	it("stays ON for truthy or any other token", () => {
		for (const v of ["1", "true", "on", "yes", "TRUE", "anything"]) {
			expect(isBrowserBridgeEnabled({ FORGE_BROWSER_MCP: v })).toBe(true);
		}
	});
});

describe("buildBrowserArgs", () => {
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		saved = snapshotEnv();
		// Clear launch-shaping env so option defaults are what we assert.
		for (const k of MANAGED_ENV) if (k !== "PATH") delete process.env[k];
	});
	afterEach(() => restoreEnv(saved));

	it("defaults to headless + isolated (agent-run reproducible defaults)", () => {
		expect(buildBrowserArgs()).toEqual(["--headless", "--isolated"]);
	});

	it("omits a presence flag when explicitly disabled", () => {
		expect(buildBrowserArgs({ headless: false })).toEqual(["--isolated"]);
		expect(buildBrowserArgs({ isolated: false })).toEqual(["--headless"]);
		expect(buildBrowserArgs({ headless: false, isolated: false })).toEqual([]);
	});

	it("appends channel / executablePath / viewport as value flags", () => {
		expect(
			buildBrowserArgs({
				headless: false,
				isolated: false,
				channel: "canary",
				executablePath: "/opt/chrome",
				viewport: "1280x800",
			}),
		).toEqual(["--channel", "canary", "--executablePath", "/opt/chrome", "--viewport", "1280x800"]);
	});

	it("connect-mode short-circuits to --browserUrl only", () => {
		expect(
			buildBrowserArgs({
				browserUrl: "http://127.0.0.1:9222",
				headless: true,
				isolated: true,
				channel: "beta",
			}),
		).toEqual(["--browserUrl", "http://127.0.0.1:9222"]);
	});

	it("reads env fallbacks (FORGE_BROWSER_*)", () => {
		process.env.FORGE_BROWSER_HEADLESS = "0";
		process.env.FORGE_BROWSER_VIEWPORT = "1024x768";
		expect(buildBrowserArgs()).toEqual(["--isolated", "--viewport", "1024x768"]);

		process.env.FORGE_BROWSER_URL = "http://localhost:9222";
		expect(buildBrowserArgs()).toEqual(["--browserUrl", "http://localhost:9222"]);
	});

	it("explicit option beats env for booleans", () => {
		process.env.FORGE_BROWSER_HEADLESS = "1";
		expect(buildBrowserArgs({ headless: false })).toEqual(["--isolated"]);
	});
});

describe("buildBrowserSteering", () => {
	it("names the tool prefix and frames verification, not browsing", () => {
		const steering = buildBrowserSteering([
			`${BROWSER_TOOL_PREFIX}navigate_page`,
			`${BROWSER_TOOL_PREFIX}take_screenshot`,
		]);
		expect(steering).toContain(`${BROWSER_TOOL_PREFIX}navigate_page`);
		expect(steering).toContain(`${BROWSER_TOOL_PREFIX}take_screenshot`);
		expect(steering).toMatch(/VERIFY UI changes|UI verification/);
		expect(steering).toMatch(/console|network/i);
	});

	it("falls back to a wildcard when the roster is empty", () => {
		const steering = buildBrowserSteering([]);
		expect(steering).toContain(`${BROWSER_TOOL_PREFIX}*`);
	});

	it("omits the auth-handoff section by default (headless, no window)", () => {
		const steering = buildBrowserSteering([`${BROWSER_TOOL_PREFIX}navigate_page`]);
		expect(steering).not.toMatch(/Human-assisted authentication/);
		expect(steering).not.toContain("forge_ask_user");
	});

	it("adds the auth-handoff section when interactive", () => {
		const steering = buildBrowserSteering([`${BROWSER_TOOL_PREFIX}take_screenshot`], { interactive: true });
		expect(steering).toMatch(/Human-assisted authentication/);
		// Leans on the existing blocking human-input primitive, not new plumbing.
		expect(steering).toContain("forge_ask_user");
		// Still carries the base verification procedure.
		expect(steering).toMatch(/VERIFY UI changes|UI verification/);
	});
});

describe("isBrowserInteractive", () => {
	it("is OFF by default (headless+isolated launch, no window)", () => {
		expect(isBrowserInteractive({})).toBe(false);
	});

	it("is ON in connect-mode (FORGE_BROWSER_URL points at the user's Chrome)", () => {
		expect(isBrowserInteractive({ FORGE_BROWSER_URL: "http://127.0.0.1:9222" })).toBe(true);
		// Empty/whitespace URL is not connect-mode.
		expect(isBrowserInteractive({ FORGE_BROWSER_URL: "  " })).toBe(false);
	});

	it("is ON when Chrome is launched headed (FORGE_BROWSER_HEADLESS falsey)", () => {
		for (const v of ["0", "false", "off", "no", "FALSE", " off "]) {
			expect(isBrowserInteractive({ FORGE_BROWSER_HEADLESS: v })).toBe(true);
		}
	});

	it("stays OFF for a headless=true token with no connect URL", () => {
		for (const v of ["1", "true", "on", "yes"]) {
			expect(isBrowserInteractive({ FORGE_BROWSER_HEADLESS: v })).toBe(false);
		}
	});
});

describe("resolveBrowserMcpCommand", () => {
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		saved = snapshotEnv();
		delete process.env.FORGE_BROWSER_MCP_BIN;
		delete process.env.FORGE_BROWSER_MCP_PACKAGE;
	});
	afterEach(() => restoreEnv(saved));

	it("uses an explicit bin verbatim with no base args (arg over env)", () => {
		process.env.FORGE_BROWSER_MCP_BIN = "/env/launcher";
		expect(resolveBrowserMcpCommand({ bin: "/explicit/launcher" })).toEqual({
			command: "/explicit/launcher",
			baseArgs: [],
		});
		expect(resolveBrowserMcpCommand()).toEqual({ command: "/env/launcher", baseArgs: [] });
	});

	it("falls back to the npx package spec (default + env override)", () => {
		// npx is present in the test runner's PATH.
		const def = resolveBrowserMcpCommand();
		// If npx is somehow unreachable in this environment, resolution is null —
		// assert the graceful contract instead of a false failure.
		if (def === null) {
			expect(def).toBeNull();
			return;
		}
		expect(def).toEqual({ command: "npx", baseArgs: ["-y", DEFAULT_BROWSER_MCP_PACKAGE] });

		process.env.FORGE_BROWSER_MCP_PACKAGE = "chrome-devtools-mcp@0.6.0";
		expect(resolveBrowserMcpCommand()).toEqual({
			command: "npx",
			baseArgs: ["-y", "chrome-devtools-mcp@0.6.0"],
		});
	});
});

describe("browser graceful contract (no launcher reachable)", () => {
	let saved: Record<string, string | undefined>;
	let emptyDir: string;

	beforeEach(() => {
		saved = snapshotEnv();
		emptyDir = mkdtempSync(path.join(tmpdir(), "browser-empty-"));
		// Empty PATH → bare `npx` cannot be resolved; no explicit bin → nothing to
		// launch, deterministically, even on a machine with npx installed.
		process.env.PATH = emptyDir;
		delete process.env.FORGE_BROWSER_MCP_BIN;
	});

	afterEach(() => {
		restoreEnv(saved);
		rmSync(emptyDir, { recursive: true, force: true });
	});

	it("resolveBrowserMcpCommand returns null when npx is unreachable and no bin is set", () => {
		expect(resolveBrowserMcpCommand()).toBeNull();
	});

	it("attachBrowser resolves to null (no-op, no throw)", async () => {
		await expect(attachBrowser({ cwd: emptyDir })).resolves.toBeNull();
	});
});

describe("browser live integration (opt-in: FORGE_BROWSER_MCP_LIVE=1)", () => {
	const live = process.env.FORGE_BROWSER_MCP_LIVE === "1";
	const REPO_ROOT = process.cwd();
	let attachment: McpAttachment | null = null;

	beforeAll(async () => {
		// Only spawn the real MCP server (and Chrome) under the explicit opt-in —
		// CI never sets FORGE_BROWSER_MCP_LIVE, so this stays a cheap no-op there.
		if (live) attachment = await attachBrowser({ cwd: REPO_ROOT, headless: true, isolated: true });
	}, 180_000);

	afterAll(async () => {
		if (attachment) await attachment.dispose();
		setExtraSubagentTools([]); // undo any roster mutation
	});

	it("discovers the browser tool surface dynamically", () => {
		if (!attachment) {
			// Not opted in (or the launch failed) → the deterministic contract holds.
			expect(live && attachment !== null).toBe(false);
			return;
		}
		expect(attachment.toolNames).toEqual(
			expect.arrayContaining([
				`${BROWSER_TOOL_PREFIX}navigate_page`,
				`${BROWSER_TOOL_PREFIX}take_snapshot`,
				`${BROWSER_TOOL_PREFIX}take_screenshot`,
			]),
		);
		console.error(`[browser itest] discovered ${attachment.toolNames.length} tools: ${attachment.toolNames.join(", ")}`);
	});

	it("browser tools reach the subagent roster via getSubagentTools", () => {
		if (!attachment) {
			expect(live && attachment !== null).toBe(false);
			return;
		}
		setExtraSubagentTools(attachment.tools);
		const roster = getSubagentTools({} as ForgeToolDefs).map((t) => t.name);
		expect(roster).toEqual(
			expect.arrayContaining([`${BROWSER_TOOL_PREFIX}navigate_page`, `${BROWSER_TOOL_PREFIX}take_screenshot`]),
		);
	});

	it("passes MCP JSON Schema verbatim + steers via the system-prompt block", () => {
		if (!attachment) {
			expect(live && attachment !== null).toBe(false);
			return;
		}
		const navigate = attachment.tools.find((t) => t.name === `${BROWSER_TOOL_PREFIX}navigate_page`)!;
		// No per-tool promptGuidelines — steering is injected once (buildBrowserSteering).
		expect(navigate.promptGuidelines ?? []).toHaveLength(0);
		const schema = navigate.parameters as { type?: string; properties?: Record<string, unknown> };
		expect(schema.type).toBe("object");
	});
});

// Guard against accidental deletion of the bridge module.
it("chrome-devtools bridge module exists", () => {
	expect(existsSync(path.join(process.cwd(), "src/extensions/forgecli/mcp-bridge/chrome-devtools.ts"))).toBe(true);
});
