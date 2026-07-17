// Chrome DevTools consumer of the MCP bridge — browser UI verification.
//
// chrome-devtools-mcp (https://github.com/ChromeDevTools/chrome-devtools-mcp,
// Google's official Chrome DevTools MCP server) drives a real Chrome over the
// DevTools Protocol and advertises a browser-automation tool surface —
// navigate_page, take_screenshot, take_snapshot (accessibility DOM), click,
// fill, evaluate_script, list_console_messages, list_network_requests, wait_for,
// … — as MCP tools. Bridging it through the SAME dynamic MCP→pi machinery as
// grove (attachMcpServer) turns that surface into native pi tools with zero
// bespoke browser code: whatever the server advertises this run is what gets
// registered, and it rides getSubagentTools so every orchestrator subagent can
// verify UI too.
//
// Why this exists: an agent implementing a UI change (e.g. a floorplan widget,
// a nav-tree drilldown, a theme pass — the WI-S50-class sprints) currently has
// no way to OBSERVE what it built in a browser. These tools close that loop —
// navigate to the running app, snapshot the DOM / screenshot the viewport, read
// console + network, assert the element rendered.
//
// Cost-aware default: unlike grove (a fast local binary attached by default),
// this bridge spawns a Node MCP server that launches Chrome, so it is OPT-IN via
// FORGE_BROWSER_MCP=1. Detection is graceful everywhere — an unresolvable
// launcher or a failed handshake returns null and the session proceeds exactly
// as before, never a throw.

import { spawnSync } from "node:child_process";
import { attachMcpServer, type McpAttachment } from "./mcp-bridge.js";

// Tool name prefix: mcp__browser__navigate_page, mcp__browser__take_screenshot, …
// Follows the standard MCP tool-naming convention (mcp__<server>__<tool>); the
// bridged tool's own name (navigate_page, take_snapshot) is all-underscore, so
// the full name stays a clean identifier. Steering (buildBrowserSteering)
// references this prefix so the model reaches for the browser surface by name.
export const BROWSER_TOOL_PREFIX = "mcp__browser__";

// Default npm package spec launched via npx when no explicit binary is given.
// Overridable with FORGE_BROWSER_MCP_PACKAGE (e.g. to pin a version or point at
// a fork). `@latest` keeps a warm-cache launch current; a pinned spec is the
// reproducible choice for CI.
export const DEFAULT_BROWSER_MCP_PACKAGE = "chrome-devtools-mcp@latest";

// Per-request timeout for browser tools. Generous because the FIRST call also
// pays for npx fetching the package and chrome-devtools-mcp downloading Chrome
// for Testing on a cold machine (the browser launches lazily on first tool use,
// not at handshake — so `initialize`/`tools/list` themselves are quick once the
// Node package is present). Individual ops (navigate, screenshot) are seconds;
// this bounds the slow outliers (first launch, wait_for). Override per-attach.
export const BROWSER_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Whether the browser bridge is enabled for this session. Opt-in — Chrome is
 * heavier than grove's local binary, so we do NOT attach by default. Enable with
 * FORGE_BROWSER_MCP set to a truthy token (1 / true / on / yes).
 */
export function isBrowserBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.FORGE_BROWSER_MCP ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** A resolved launcher for the browser MCP server: how to spawn it. */
export interface ResolvedBrowserCommand {
	/** Executable to spawn (resolved against PATH by child_process). */
	command: string;
	/** Args that precede the server's own launch flags (e.g. `npx -y <pkg>`). */
	baseArgs: string[];
}

/**
 * Resolve how to launch the browser MCP server, or null when nothing is usable.
 *
 * Precedence:
 *   1. Explicit binary (arg → FORGE_BROWSER_MCP_BIN) — a direct
 *      chrome-devtools-mcp launcher. Trusted as-is (no pre-verify: probing it
 *      could cost a Chrome launch); baseArgs is empty.
 *   2. `npx` on PATH → `npx -y <FORGE_BROWSER_MCP_PACKAGE | chrome-devtools-mcp@latest>`.
 *      "Usable" means `npx --version` exits 0.
 *
 * Returns null when neither is reachable — the caller treats that as a graceful
 * no-op (no browser tools this session), never an error.
 */
export function resolveBrowserMcpCommand(opts?: { bin?: string }): ResolvedBrowserCommand | null {
	const explicit = opts?.bin ?? process.env.FORGE_BROWSER_MCP_BIN;
	if (typeof explicit === "string" && explicit.length > 0) {
		return { command: explicit, baseArgs: [] };
	}
	// npx path — verify the launcher itself is reachable before committing to it.
	try {
		const res = spawnSync("npx", ["--version"], { encoding: "utf8", timeout: 5000 });
		if (res.status !== 0) return null;
	} catch {
		return null;
	}
	const pkg =
		typeof process.env.FORGE_BROWSER_MCP_PACKAGE === "string" &&
		process.env.FORGE_BROWSER_MCP_PACKAGE.length > 0
			? process.env.FORGE_BROWSER_MCP_PACKAGE
			: DEFAULT_BROWSER_MCP_PACKAGE;
	return { command: "npx", baseArgs: ["-y", pkg] };
}

/** Chrome launch shape passed through to chrome-devtools-mcp's CLI flags. */
export interface BrowserLaunchOptions {
	/** Run Chrome headless. Default true (faster, no window for agent runs). */
	headless?: boolean;
	/** Fresh temp user-data-dir cleared on exit. Default true (reproducible). */
	isolated?: boolean;
	/** Release channel: stable | canary | beta | dev. */
	channel?: string;
	/** Path to a specific Chrome/Chromium executable. */
	executablePath?: string;
	/**
	 * Connect to an already-running Chrome's CDP endpoint instead of launching
	 * one. When set, launch flags (headless/isolated/channel/executablePath) do
	 * NOT apply — chrome-devtools-mcp attaches to the existing browser — so only
	 * `--browserUrl` is passed.
	 */
	browserUrl?: string;
	/** Initial viewport as `WIDTHxHEIGHT` (e.g. `1280x800`). */
	viewport?: string;
}

/** Read a boolean launch flag: explicit opt → env token → default. */
function resolveBool(explicit: boolean | undefined, envVal: string | undefined, dflt: boolean): boolean {
	if (explicit !== undefined) return explicit;
	if (envVal === undefined) return dflt;
	const v = envVal.trim().toLowerCase();
	if (v === "0" || v === "false" || v === "off" || v === "no") return false;
	if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
	return dflt;
}

/**
 * Build the chrome-devtools-mcp launch flags from options, with env fallbacks
 * (FORGE_BROWSER_HEADLESS, _ISOLATED, _CHANNEL, _EXECUTABLE, _URL, _VIEWPORT).
 *
 * Connect-mode short-circuit: when a browserUrl is resolved, ONLY `--browserUrl`
 * is emitted — the launch flags are meaningless (and rejected) when attaching to
 * an existing browser.
 */
export function buildBrowserArgs(opts: BrowserLaunchOptions = {}): string[] {
	const browserUrl = opts.browserUrl ?? envStr("FORGE_BROWSER_URL");
	if (browserUrl) return ["--browserUrl", browserUrl];

	const args: string[] = [];
	// chrome-devtools-mcp treats --headless / --isolated as presence flags
	// (default off), so we emit them only when true — matching its docs exactly.
	if (resolveBool(opts.headless, process.env.FORGE_BROWSER_HEADLESS, true)) args.push("--headless");
	if (resolveBool(opts.isolated, process.env.FORGE_BROWSER_ISOLATED, true)) args.push("--isolated");

	const channel = opts.channel ?? envStr("FORGE_BROWSER_CHANNEL");
	if (channel) args.push("--channel", channel);

	const executablePath = opts.executablePath ?? envStr("FORGE_BROWSER_EXECUTABLE");
	if (executablePath) args.push("--executablePath", executablePath);

	const viewport = opts.viewport ?? envStr("FORGE_BROWSER_VIEWPORT");
	if (viewport) args.push("--viewport", viewport);

	return args;
}

/** Trimmed non-empty env string, or undefined. */
function envStr(name: string): string | undefined {
	const v = process.env[name];
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * The browser UI-verification steering block — injected ONCE into the system
 * prompt (via project-orientation → setBrowserSteering), reaching both the main
 * thread and every subagent dispatch. Mirrors grove's steering discipline: no
 * per-tool promptGuidelines (pi would repeat the block once per active tool).
 *
 * Frames the surface as a VERIFICATION loop, not a browsing toy: after a UI
 * change, drive the running app and confirm what rendered — snapshot the DOM,
 * screenshot the viewport, read console/network for errors.
 */
export function buildBrowserSteering(toolNames: string[]): string {
	const available = toolNames.length > 0 ? toolNames.join(", ") : `${BROWSER_TOOL_PREFIX}*`;
	return [
		"## Browser UI verification — use the browser tools",
		"",
		`This session has Chrome DevTools browser tools available: ${available}.`,
		"Use them to VERIFY UI changes end-to-end — do not claim a visual/interaction",
		"change works until you have observed it rendered in the browser.",
		"",
		"Procedure after a UI change:",
		`1. \`${BROWSER_TOOL_PREFIX}navigate_page\` to the running app's URL (start the`,
		"   dev server first if needed; use the project's own run/dev command).",
		`2. \`${BROWSER_TOOL_PREFIX}take_snapshot\` for the accessibility DOM (elements +`,
		"   stable uids to act on) and/or `" + BROWSER_TOOL_PREFIX + "take_screenshot`",
		"   for the rendered pixels — assert the expected element/text is present.",
		`3. \`${BROWSER_TOOL_PREFIX}list_console_messages\` and`,
		`   \`${BROWSER_TOOL_PREFIX}list_network_requests\` — a UI change is not "done"`,
		"   if it logs console errors or 4xx/5xx requests.",
		`4. For interaction changes, act via \`${BROWSER_TOOL_PREFIX}click\` /`,
		`   \`${BROWSER_TOOL_PREFIX}fill\` (target the uid from the snapshot),`,
		`   \`${BROWSER_TOOL_PREFIX}wait_for\`, then re-snapshot to confirm the new state.`,
		"",
		"Reach for these instead of guessing from the code whenever a change has a",
		"visible or interactive surface. Screenshots are also how you show the user",
		"what you verified.",
	].join("\n");
}

/** Options for attaching the browser bridge to a pi session. */
export interface AttachBrowserOptions extends BrowserLaunchOptions {
	/** Working directory for the MCP server child (project root). */
	cwd: string;
	/** Explicit launcher override (else FORGE_BROWSER_MCP_BIN → npx). */
	bin?: string;
	/** Override the tool name prefix (default "mcp__browser__"). */
	namePrefix?: string;
	/** Per-call request timeout (default BROWSER_DEFAULT_TIMEOUT_MS). */
	requestTimeoutMs?: number;
}

/**
 * Attach the Chrome DevTools browser bridge to a pi session: resolve a launcher
 * → spawn the MCP server → discover its tools → synthesize pi ToolDefinitions.
 *
 * Returns null — a graceful no-op — when no launcher is reachable or the
 * handshake/discovery fails (e.g. npx cold-fetch exceeded the timeout, Node
 * version too old, Chrome unavailable). Callers register the returned tools on
 * the host session and inject them into subagent dispatch.
 */
export async function attachBrowser(opts: AttachBrowserOptions): Promise<McpAttachment | null> {
	const resolved = resolveBrowserMcpCommand({ bin: opts.bin });
	if (!resolved) return null;

	const args = [...resolved.baseArgs, ...buildBrowserArgs(opts)];
	try {
		// No per-tool promptGuidelines — steering is injected once via
		// buildBrowserSteering → project-orientation (reaches main + subagents).
		return await attachMcpServer({
			command: resolved.command,
			args,
			cwd: opts.cwd,
			namePrefix: opts.namePrefix ?? BROWSER_TOOL_PREFIX,
			requestTimeoutMs: opts.requestTimeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS,
		});
	} catch {
		// Handshake/discovery failed — degrade silently, session continues.
		return null;
	}
}
