// forge init — deterministic Claude Code project bootstrap (FORGE-S31-T02).
//
// `4ge init claude [dir]` scaffolds a Claude Code project from the bundled
// forge-payload in seconds: zero LLM tokens, zero network, pure fs.
//
// Structural convention: follows runDoctor / runUpdate / runConfig.
//   - parseInitArgs(args): pure arg parser
//   - runInit(args): async entry point, returns exit code
//
// Iron-Law boundary (IL6): no shell-string interpolation. If shell-outs are
// ever added they MUST use argv-array spawn, not execSync with a string.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapClaudeProject } from "../extensions/forgecli/claude-bootstrap/bootstrap.js";

// ── Payload root resolution (same logic as forge-init.ts) ─────────────────────

const _BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
// dist/bin/init.js → dist/ → <pkg-root>/
const _DIST_DIR = path.resolve(_BIN_DIR, "..");
const _PKG_ROOT = path.resolve(_DIST_DIR, "..");

function getBundledPayloadRoot(): string {
	return path.join(_PKG_ROOT, "dist", "forge-payload");
}

// ── Arg parser ─────────────────────────────────────────────────────────────────

export interface InitArgs {
	platform: "claude";
	dir: string;
}

export interface InitArgsError {
	error: string;
}

/**
 * Parse subcommand args for `forge init`.
 *
 * Expected forms:
 *   forge init claude           → dir = process.cwd()
 *   forge init claude <dir>     → dir = <dir>
 *   forge init                  → error: platform required
 *   forge init <other>          → error: unknown platform
 */
export function parseInitArgs(args: readonly string[]): InitArgs | InitArgsError {
	if (args.length === 0) {
		return {
			error:
				"forge init: platform argument required.\n" +
				"Usage: forge init claude [dir]\n" +
				"  claude    Bootstrap a Claude Code (.claude/) project",
		};
	}

	const platform = args[0];
	if (platform !== "claude") {
		return {
			error:
				`forge init: unknown platform '${platform}'.\n` +
				"Supported platforms: claude\n" +
				"Usage: forge init claude [dir]",
		};
	}

	// Optional dir arg — defaults to cwd
	const dir = args[1] ? path.resolve(args[1]) : process.cwd();

	return { platform: "claude", dir };
}

/**
 * Entry point invoked from bin/forge.ts.
 *
 * Returns exit code: 0 on success, 1 on bootstrap error.
 */
export async function runInit(args: readonly string[]): Promise<number> {
	const parsed = parseInitArgs(args);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		return 1;
	}

	const { dir } = parsed;
	const payloadRoot = getBundledPayloadRoot();

	process.stdout.write(`forge init claude — bootstrapping ${dir}\n`);

	let result;
	try {
		result = bootstrapClaudeProject({ dir, payloadRoot });
	} catch (err: unknown) {
		const e = err as { message?: string };
		process.stderr.write(
			`forge init: bootstrap failed: ${e.message ?? String(err)}\n`,
		);
		return 1;
	}

	if (!result.ok) {
		for (const w of result.warnings) {
			process.stderr.write(`  ✗ ${w}\n`);
		}
		process.stderr.write("forge init: bootstrap failed — see warnings above.\n");
		return 1;
	}

	// Print success summary
	if (result.created.length > 0) {
		process.stdout.write(`\nCreated (${result.created.length}):\n`);
		for (const p of result.created) {
			process.stdout.write(`  + ${p}\n`);
		}
	}
	if (result.skipped.length > 0) {
		process.stdout.write(`\nAlready present (${result.skipped.length}):\n`);
		process.stdout.write(`  ○ ${result.skipped.length} paths verified unchanged\n`);
	}
	if (result.warnings.length > 0) {
		process.stdout.write(`\nWarnings:\n`);
		for (const w of result.warnings) {
			process.stdout.write(`  △ ${w}\n`);
		}
	}

	// Hand-off message (FORGE-S31-T03): names /forge:init, lists 7 hooks, mentions one-time approval prompt.
	// Prepend preflight warning if Claude Code was not found.
	const claudeUnavailableWarning = result.preflight.claudeAvailable
		? ""
		: "  Warning: Claude Code not found on PATH — install before opening this project.\n\n";

	process.stdout.write(
		`\n✓ forge init complete — project bootstrapped in ${dir}\n` +
			`\nNext step:\n` +
			`${claudeUnavailableWarning}` +
			`  Open Claude Code in ${dir} and run: /forge:init\n` +
			`\nWhat to expect:\n` +
			`  Claude Code will ask you to approve 7 project hooks (one-time prompt).\n` +
			`  Approve them — they are scoped to this project only.\n` +
			`\n  Hooks registered:\n` +
			`    • check-update       (SessionStart)\n` +
			`    • preflight-session  (SessionStart)\n` +
			`    • validate-write     (PreToolUse — Write/Edit/MultiEdit)\n` +
			`    • triage-error       (PostToolUse — Bash)\n` +
			`    • query-logger       (PostToolUse — Bash)\n` +
			`    • post-init          (PostToolUse — Bash)\n` +
			`    • post-sprint        (PostToolUse — Bash)\n` +
			`\n  After approval, /forge:init runs discovery, KB generation,\n` +
			`  and project configuration. Zero tokens until you open Claude Code.\n`,
	);

	return 0;
}
