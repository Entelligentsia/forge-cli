// Grove consumer of the MCP bridge (FORGE-S34).
//
// Grove (https://github.com/Entelligentsia/grove) is a tree-sitter code-nav
// server with two faces: a `grove` CLI and a `grove serve` MCP server, same
// engine behind both. 4ge is a coding harness, so when grove is available we
// give every session — main thread and subagents — its AST-level tools by
// default, discovered dynamically from `grove serve` (attachMcpServer).
//
// Detection is graceful: if the grove binary isn't present, attachGrove returns
// null and the session proceeds exactly as before. The implicit init path
// (ensureGroveReady with runInit) provisions grammars + grove.lock for a project
// the first time it's needed, without writing any Claude-Code wiring into the
// project (`grove init --as skill`).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { attachMcpServer, type McpAttachment } from "./mcp-bridge.js";

// Default name prefix for grove tools: mcp__grove__outline, mcp__grove__symbols, …
// This is the standard MCP tool-naming convention (mcp__<server>__<tool>) that
// grove's own skill and the CLAUDE.md "code navigation goes through grove"
// INVARIANT already reference — naming the bridged tools this way means that
// existing steering drives the model straight onto the bridge, rather than to a
// `grove` CLI fallback that the skill assumes when MCP tools are absent.
export const GROVE_TOOL_PREFIX = "mcp__grove__";

/**
 * The grove code-navigation steering block — injected ONCE into the system
 * prompt (via project-orientation, which reaches both the main thread and
 * subagents) when grove is attached. This is the "fragment" that replaces
 * grove's CLAUDE.md INVARIANT: the steering lives in the host's system prompt,
 * so the user's project files (CLAUDE.md) stay untouched. Per-tool
 * `promptGuidelines` are deliberately NOT used — pi concatenates them across
 * every active tool with no cross-tool dedup, so a shared block would repeat
 * once per grove tool.
 */
export function buildGroveSteering(toolNames: string[]): string {
	const available = toolNames.length > 0 ? toolNames.join(", ") : "mcp__grove__*";
	return [
		"## Code navigation — use grove",
		"",
		`This project has grove tree-sitter code-navigation tools available: ${available}.`,
		"For any where-is / what-defines / who-calls question, reach for them FIRST —",
		"they return one symbol's exact bytes with a stable id, far cheaper than grep",
		"or whole-file reads. `grep` / `rg` / reading whole files are fallbacks, used",
		"only after grove has been tried and returned insufficient content.",
		"",
		"Procedure: `mcp__grove__outline <file>` for a file's definition skeleton, or",
		"`mcp__grove__symbols` to locate a name by exact match → `mcp__grove__source`",
		"by the returned id for the body; `mcp__grove__callers` / `mcp__grove__definition`",
		"for call sites and go-to-def; `mcp__grove__check` after an edit.",
	].join("\n");
}

/**
 * Resolve a usable grove binary, or null if none works.
 * Precedence: explicit arg → FORGE_GROVE_BIN env → `grove` on PATH.
 * "Usable" means `<bin> --version` exits 0.
 */
export function resolveGroveBin(explicit?: string): string | null {
	const candidates = [explicit, process.env.FORGE_GROVE_BIN, "grove"].filter(
		(c): c is string => typeof c === "string" && c.length > 0,
	);
	for (const candidate of candidates) {
		try {
			const res = spawnSync(candidate, ["--version"], {
				encoding: "utf8",
				timeout: 5000,
			});
			if (res.status === 0) return candidate;
		} catch {
			// try next candidate
		}
	}
	return null;
}

export interface GroveReadiness {
	/** Resolved grove binary, or null when grove is unavailable. */
	bin: string | null;
	/** True when the project has a grove.lock (grammars provisioned). */
	initialized: boolean;
	/** True when this call ran `grove init` to provision the project. */
	ranInit: boolean;
}

export interface EnsureGroveOptions {
	/** Project root grove operates against. */
	cwd: string;
	/** Explicit binary override. */
	bin?: string;
	/**
	 * Implicit init path: when the project has no grove.lock, run
	 * `grove init --as skill` to fetch grammars + write grove.lock. Off by
	 * default — provisioning (a network fetch) is opt-in, "when needed".
	 */
	runInit?: boolean;
	/** Timeout for the init subprocess (default 60s — grammar download). */
	initTimeoutMs?: number;
}

/**
 * Detect grove and, optionally, provision it for a project. Never throws — a
 * missing binary or a failed init returns a readiness object the caller reads.
 */
export function ensureGroveReady(opts: EnsureGroveOptions): GroveReadiness {
	const bin = resolveGroveBin(opts.bin);
	if (!bin) return { bin: null, initialized: false, ranInit: false };

	const lockPath = path.join(opts.cwd, "grove.lock");
	let initialized = existsSync(lockPath);
	let ranInit = false;

	if (!initialized && opts.runInit) {
		// `--as grammars` (grove >= 0.1.8) provisions grammars + grove.lock and
		// writes NO project files beyond the lock — no .mcp.json, no CLAUDE.md.
		// 4ge supplies its own steering via the system prompt (buildGroveSteering),
		// so the user's CLAUDE.md is never touched. On an older grove this exits
		// non-zero (unknown value); ensureGroveReady reports not-provisioned and the
		// bridge still works for already-cached grammars — never a CLAUDE.md write.
		const res = spawnSync(bin, ["init", "--as", "grammars"], {
			cwd: opts.cwd,
			encoding: "utf8",
			timeout: opts.initTimeoutMs ?? 60000,
		});
		ranInit = res.status === 0;
		initialized = existsSync(lockPath);
	}

	return { bin, initialized, ranInit };
}

export interface AttachGroveOptions {
	/** Project root grove operates against (grove resolves paths from here). */
	cwd: string;
	/** Explicit binary override. */
	bin?: string;
	/** Override the tool name prefix (default "mcp__grove__"). */
	namePrefix?: string;
	/** Run the implicit init path if the project isn't provisioned yet. */
	autoInit?: boolean;
	/** Per-call request timeout for grove tools (default 15s). */
	requestTimeoutMs?: number;
}

/**
 * Attach grove to a pi session: detect → (optionally) provision → spawn
 * `grove serve` → discover tools → synthesize pi ToolDefinitions.
 *
 * Returns null — a graceful no-op — when grove is unavailable or the handshake
 * fails. Callers register the returned tools on the host session and inject them
 * into subagent dispatch.
 */
export async function attachGrove(opts: AttachGroveOptions): Promise<McpAttachment | null> {
	const readiness = ensureGroveReady({
		cwd: opts.cwd,
		bin: opts.bin,
		runInit: opts.autoInit === true,
	});
	if (!readiness.bin) return null;

	try {
		// No per-tool promptGuidelines — steering is injected once via
		// buildGroveSteering → project-orientation (reaches main + subagents).
		return await attachMcpServer({
			command: readiness.bin,
			args: ["serve"],
			cwd: opts.cwd,
			namePrefix: opts.namePrefix ?? GROVE_TOOL_PREFIX,
			requestTimeoutMs: opts.requestTimeoutMs,
		});
	} catch {
		// Handshake/discovery failed — degrade silently, session continues.
		return null;
	}
}
