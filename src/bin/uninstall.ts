// forge uninstall — deterministic reverse of `4ge init claude` (counterpart to init.ts).
//
// `4ge uninstall claude [dir] [--purge] [--yes]` removes the Forge scaffold a
// prior `4ge init claude` placed in a project. By default it preserves user
// data (.forge/config.json, .forge/store/**, the KB folder); --purge also
// removes the config + store. A [y/N] confirmation guards the destructive op
// unless --yes / -y or FORGE_NON_INTERACTIVE=1.
//
// Structural convention mirrors init.ts / update-cli.ts:
//   - parseUninstallArgs(args): pure arg parser
//   - runUninstall(args): async entry point, returns exit code
//
// Iron-Law boundary (IL6): no shell-string interpolation; pure fs in the core.

import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { uninstallClaudeProject } from "../extensions/forgecli/claude-bootstrap/uninstall.js";

// ── Payload root resolution (same logic as init.ts) ───────────────────────────

const _BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const _DIST_DIR = path.resolve(_BIN_DIR, "..");
const _PKG_ROOT = path.resolve(_DIST_DIR, "..");

function getBundledPayloadRoot(): string {
	return path.join(_PKG_ROOT, "dist", "forge-payload");
}

// ── Arg parser ────────────────────────────────────────────────────────────────

export interface UninstallArgs {
	platform: "claude";
	dir: string;
	purge: boolean;
	yes: boolean;
}

export interface UninstallArgsError {
	error: string;
}

/**
 * Parse subcommand args for `forge uninstall`.
 *
 * Expected forms:
 *   forge uninstall claude                 → dir = cwd
 *   forge uninstall claude <dir>           → dir = <dir>
 *   forge uninstall claude [dir] --purge   → also remove config + store
 *   forge uninstall claude [dir] --yes|-y  → skip the [y/N] confirm
 */
export function parseUninstallArgs(args: readonly string[]): UninstallArgs | UninstallArgsError {
	if (args.length === 0) {
		return {
			error:
				"forge uninstall: platform argument required.\n" +
				"Usage: forge uninstall claude [dir] [--purge] [--yes]\n" +
				"  claude    Remove the Forge scaffold from a Claude Code (.claude/) project",
		};
	}

	const platform = args[0];
	if (platform !== "claude") {
		return {
			error:
				`forge uninstall: unknown platform '${platform}'.\n` +
				"Supported platforms: claude\n" +
				"Usage: forge uninstall claude [dir] [--purge] [--yes]",
		};
	}

	let dir: string | undefined;
	let purge = false;
	let yes = false;

	for (const t of args.slice(1)) {
		if (t === "--purge") {
			purge = true;
		} else if (t === "--yes" || t === "-y") {
			yes = true;
		} else if (t.startsWith("-")) {
			return {
				error: `forge uninstall: unknown option ${t}. Valid options: --purge, --yes`,
			};
		} else if (dir === undefined) {
			dir = path.resolve(t);
		} else {
			return { error: `forge uninstall: unexpected extra argument '${t}'.` };
		}
	}

	return { platform: "claude", dir: dir ?? process.cwd(), purge, yes };
}

// ── Confirmation prompt (mirrors update-cli.ts) ───────────────────────────────

async function askConfirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise<boolean>((resolve) => {
		rl.question(`${question} [y/N] `, (answer) => {
			rl.close();
			resolve(/^y(es)?$/i.test(answer.trim()));
		});
	});
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runUninstall(args: readonly string[]): Promise<number> {
	const parsed = parseUninstallArgs(args);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		return 1;
	}

	const { dir, purge, yes } = parsed;
	const payloadRoot = getBundledPayloadRoot();

	// Confirmation gate (skipped by --yes / -y / FORGE_NON_INTERACTIVE=1).
	const autoYes = yes || process.env.FORGE_NON_INTERACTIVE === "1";
	if (!autoYes) {
		const scope = purge
			? "the Forge scaffold AND your .forge/config.json + .forge/store/** (sprints, tasks, bugs, events)"
			: "the Forge scaffold (config.json, store, and the KB folder are preserved)";
		process.stdout.write(`forge uninstall claude — this will remove ${scope} from:\n  ${dir}\n`);
		const proceed = await askConfirm("Proceed?");
		if (!proceed) {
			process.stdout.write("forge uninstall: aborted — nothing was removed.\n");
			return 0;
		}
	}

	let result;
	try {
		result = uninstallClaudeProject({ dir, payloadRoot, purge });
	} catch (err: unknown) {
		const e = err as { message?: string };
		process.stderr.write(`forge uninstall: failed: ${e.message ?? String(err)}\n`);
		return 1;
	}

	if (!result.bootstrapped) {
		for (const w of result.warnings) process.stderr.write(`  ✗ ${w}\n`);
		return 1;
	}

	if (result.removed.length > 0) {
		process.stdout.write(`\nRemoved (${result.removed.length}):\n`);
		for (const p of result.removed) process.stdout.write(`  - ${p}\n`);
	} else {
		process.stdout.write("\nNothing to remove — project already clean of the Forge scaffold.\n");
	}

	if (result.kept.length > 0) {
		process.stdout.write(`\nPreserved (user data — use --purge to remove):\n`);
		for (const p of result.kept) process.stdout.write(`  ○ ${p}\n`);
	}

	if (result.warnings.length > 0) {
		process.stdout.write(`\nWarnings:\n`);
		for (const w of result.warnings) process.stdout.write(`  △ ${w}\n`);
	}

	process.stdout.write(`\n✓ forge uninstall complete — ${dir}\n`);
	return result.ok ? 0 : 1;
}
