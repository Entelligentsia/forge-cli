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

/** Default name prefix for grove tools: grove_outline, grove_symbols, … */
export const GROVE_TOOL_PREFIX = "grove_";

/** Steering appended to the system prompt while grove tools are active. */
export const GROVE_PROMPT_GUIDELINES: string[] = [
	"For code navigation (where is X / what does it define / who calls it), prefer the grove_* tools over grep or whole-file reads — they return one symbol's bytes with a stable id.",
	"Typical chain: grove_outline a file, or grove_symbols to locate a name, then grove_source by id; grove_callers / grove_definition for call sites and go-to-def; grove_check after an edit.",
];

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
		// `--as skill` provisions grammars + grove.lock + a CLAUDE.md steering
		// block (NOT .mcp.json — that MCP-server wiring is the Claude-Code surface,
		// irrelevant to 4ge, which gets grove via the in-process bridge instead).
		const res = spawnSync(bin, ["init", "--as", "skill"], {
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
	/** Override the tool name prefix (default "grove_"). */
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
		return await attachMcpServer({
			command: readiness.bin,
			args: ["serve"],
			cwd: opts.cwd,
			namePrefix: opts.namePrefix ?? GROVE_TOOL_PREFIX,
			promptGuidelines: GROVE_PROMPT_GUIDELINES,
			requestTimeoutMs: opts.requestTimeoutMs,
		});
	} catch {
		// Handshake/discovery failed — degrade silently, session continues.
		return null;
	}
}
