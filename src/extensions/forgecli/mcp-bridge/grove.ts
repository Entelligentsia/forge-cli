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
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { attachMcpServer, type McpAttachment } from "./mcp-bridge.js";

// Default name prefix for grove tools: mcp__grove__outline, mcp__grove__symbols, …
// This is the standard MCP tool-naming convention (mcp__<server>__<tool>) that
// grove's own skill and the CLAUDE.md "code navigation goes through grove"
// INVARIANT already reference — naming the bridged tools this way means that
// existing steering drives the model straight onto the bridge, rather than to a
// `grove` CLI fallback that the skill assumes when MCP tools are absent.
export const GROVE_TOOL_PREFIX = "mcp__grove__";

// The single delegating tool grove exposes in explore-mode (`grove serve
// --explore`). When it appears in the discovered roster, the project is running
// grove's local-LLM delegation surface and the outer model gets ONE locator tool
// instead of the 7 structural tools.
export const GROVE_EXPLORE_TOOL = `${GROVE_TOOL_PREFIX}explore`;

// Idle (per-progress) timeout for explore-mode calls. The delegated local-LLM
// loop runs multiple turns; grove emits `notifications/progress` per turn, which
// the transport uses to reset this timer. So this bounds the gap BETWEEN progress
// events (a single hung turn), not the whole call — generous enough for a slow
// local model, still short enough to catch a genuinely dead provider.
const GROVE_EXPLORE_IDLE_TIMEOUT_MS = 120_000;

/**
 * True when the project is configured for grove's delegated local-LLM mode
 * (`mode: "mcp-llm"` in `.grove/config.json`). This mirrors grove's own surface
 * decision (`active_mode` in grove's `core/src/config.rs`, reached by
 * `determine_surface` in grove's `cli/src/mcp.rs`): the declared `mode` in
 * `.grove/config.json` is the single source of truth.
 *
 * Resolution (matches grove's `ModeChoice::None` branch):
 * 1. `.grove/config.json` present → explore iff `mode === "mcp-llm"`. A stale
 *    legacy `.grove/explore.json` sitting alongside it is IGNORED — grove no
 *    longer sniffs `explore.json` once `config.json` exists (GROVE-S03-T03), so
 *    a project that declares `mode: "mcp"` but keeps an old `explore.json` is
 *    served the standard structural surface, not explore-mode.
 * 2. `.grove/config.json` absent but legacy `.grove/explore.json` present →
 *    true. grove auto-migrates `explore.json` → `config.json` (mode=mcp-llm) on
 *    first load, so this transient pre-migration state still means explore.
 * 3. Neither file → false.
 *
 * A malformed/unreadable `config.json` degrades to false (structural surface),
 * matching grove's own fallback. Provisioning stays the user's job (grove's
 * interactive `init --as mcp-llm` TUI writes `config.json`); forge-cli only
 * detects it.
 */
export function isGroveExploreProject(cwd: string): boolean {
	const configPath = path.join(cwd, ".grove", "config.json");
	if (existsSync(configPath)) {
		try {
			const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { mode?: unknown };
			return cfg?.mode === "mcp-llm";
		} catch {
			// Malformed config.json — degrade to the standard structural surface,
			// same as grove's active_mode fallback when load fails.
			return false;
		}
	}
	// Legacy fallback: a pre-config.json project with explore.json gets
	// auto-migrated by grove to mode=mcp-llm on first load.
	return existsSync(path.join(cwd, ".grove", "explore.json"));
}

/**
 * Decide whether to attach grove in explore-mode for this session.
 *
 * - An explicit `explore` override (from AttachGroveOptions) always wins.
 * - `FORGE_GROVE_NO_EXPLORE=1` forces the standard structural surface even in a
 *   provisioned explore project (escape hatch, mirrors FORGE_GROVE_NO_AUTOINIT).
 * - Otherwise: explore-mode iff the project declares it (see
 *   [`isGroveExploreProject`] — `mode: "mcp-llm"` in `.grove/config.json`, with
 *   a legacy `.grove/explore.json` fallback).
 *
 * Note this only decides which surface to *ask* grove for. Grove's own health
 * probe has the final say: `serve --explore` with a down local LLM transparently
 * falls back to the 7 structural tools, and the bridge registers whatever grove
 * actually advertised — so a stale/unavailable explore config still degrades
 * cleanly with no extra logic here.
 */
export function shouldUseExplore(cwd: string, explicit?: boolean): boolean {
	if (explicit !== undefined) return explicit;
	if (process.env.FORGE_GROVE_NO_EXPLORE === "1") return false;
	return isGroveExploreProject(cwd);
}

/**
 * The grove code-navigation steering block — injected ONCE into the system
 * prompt (via project-orientation, which reaches both the main thread and
 * subagents) when grove is attached. This is the "fragment" that replaces
 * grove's CLAUDE.md INVARIANT: the steering lives in the host's system prompt,
 * so the user's project files (CLAUDE.md) stay untouched. Per-tool
 * `promptGuidelines` are deliberately NOT used — pi concatenates them across
 * every active tool with no cross-tool dedup, so a shared block would repeat
 * once per grove tool.
 *
 * The block branches on the ACTUAL discovered roster, not on the requested mode:
 * if grove served its explore-mode surface (`mcp__grove__explore` present) the
 * locator steering is emitted; otherwise the structural procedure. Because grove
 * falls back to the 7 structural tools when the local LLM is down, keying off the
 * real roster keeps the steering honest even when explore was requested but
 * couldn't be served.
 */
export function buildGroveSteering(toolNames: string[]): string {
	if (toolNames.includes(GROVE_EXPLORE_TOOL)) {
		return buildGroveExploreSteering();
	}
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
 * Steering for grove's delegated explore-mode surface: a single `explore` tool
 * backed by a local LLM. It is a code LOCATOR — ask ONE narrow where-is question,
 * get `file:line` citations back — not a broad task runner. Framed to match
 * grove's own locator instructions so the model engages it rather than bypassing
 * it with a broad grep.
 */
function buildGroveExploreSteering(): string {
	return [
		"## Code navigation — use grove explore",
		"",
		`This project runs grove in explore-mode: a single \`${GROVE_EXPLORE_TOOL}\` tool,`,
		"backed by a local LLM, is your code-navigation surface. It is a LOCATOR — it",
		"finds WHERE code lives and returns `file:line` citations, not a whole answer.",
		"",
		"For any where-is / what-defines / who-calls question, reach for it FIRST.",
		"Ask ONE narrow, single-focus question per call (e.g. \"where is the API-key",
		"health check defined\"), not a broad multi-part task. Best flow: a few narrow",
		`\`${GROVE_EXPLORE_TOOL}\` calls to locate the pieces → \`read\` those exact`,
		"`file:line` spans → synthesize. `grep` / `rg` / reading whole files blind are",
		"fallbacks, used only after explore has been tried and returned insufficient",
		"content.",
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
	/**
	 * Force explore-mode (`grove serve --explore`) on/off. Undefined (default)
	 * auto-detects via `shouldUseExplore`: explore-mode iff the project has
	 * `.grove/explore.json` and FORGE_GROVE_NO_EXPLORE isn't set.
	 */
	explore?: boolean;
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

	// A `--as mcp-llm` project asked for grove's delegated local-LLM surface;
	// mirror grove's own decision and spawn `serve --explore`. Grove health-probes
	// the local backend and falls back to the 7 structural tools if it's down, so
	// this is safe even when the configured LLM isn't currently running.
	const explore = shouldUseExplore(opts.cwd, opts.explore);
	const args = explore ? ["serve", "--explore"] : ["serve"];
	// Explore delegates to a local LLM over many turns; give it a wide idle window
	// (reset per progress notification). Structural calls keep the default.
	const requestTimeoutMs =
		opts.requestTimeoutMs ?? (explore ? GROVE_EXPLORE_IDLE_TIMEOUT_MS : undefined);

	try {
		// No per-tool promptGuidelines — steering is injected once via
		// buildGroveSteering → project-orientation (reaches main + subagents).
		return await attachMcpServer({
			command: readiness.bin,
			args,
			cwd: opts.cwd,
			namePrefix: opts.namePrefix ?? GROVE_TOOL_PREFIX,
			requestTimeoutMs,
		});
	} catch {
		// Handshake/discovery failed — degrade silently, session continues.
		return null;
	}
}
