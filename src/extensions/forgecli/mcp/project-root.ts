// mcp/project-root.ts — CLAUDE_PROJECT_DIR resolver for the MCP server.
//
// ADR Decision 6: resolves the project root from the CLAUDE_PROJECT_DIR
// environment variable, falling back to process.cwd() with a stderr warning.
// No pi import — keeps the bundle lean.

import { existsSync, statSync } from "node:fs";

/**
 * Resolve the Forge project root.
 *
 * Returns CLAUDE_PROJECT_DIR when it points at a real directory; otherwise
 * falls back to process.cwd() and writes a warning to stderr.
 *
 * The existence check is load-bearing: a project-scoped `.mcp.json` may set
 * `CLAUDE_PROJECT_DIR` to an UNEXPANDED template token (e.g. the literal
 * "${projectRoot}") when the host doesn't substitute it. A non-empty-but-bogus
 * value would otherwise be trusted and flow straight into execFile's `cwd`,
 * where Node rejects the missing directory with a misleading
 * `spawn <node> ENOENT`. Validating here makes the server resilient to a
 * malformed env value and falls back to the (correct) launch cwd instead.
 */
export function resolveProjectRoot(): string {
	const envRoot = process.env["CLAUDE_PROJECT_DIR"];
	if (envRoot && existsSync(envRoot) && statSync(envRoot).isDirectory()) {
		return envRoot;
	}
	const cwd = process.cwd();
	if (envRoot) {
		process.stderr.write(
			"[forge-mcp] CLAUDE_PROJECT_DIR is set but not a directory (" +
				envRoot +
				") — falling back to cwd: " +
				cwd +
				"\n",
		);
	} else {
		process.stderr.write(
			"[forge-mcp] CLAUDE_PROJECT_DIR not set — falling back to cwd: " + cwd + "\n",
		);
	}
	return cwd;
}
