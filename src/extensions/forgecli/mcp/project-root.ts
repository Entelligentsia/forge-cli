// mcp/project-root.ts — CLAUDE_PROJECT_DIR resolver for the MCP server.
//
// ADR Decision 6: resolves the project root from the CLAUDE_PROJECT_DIR
// environment variable, falling back to process.cwd() with a stderr warning.
// No pi import — keeps the bundle lean.

/**
 * Resolve the Forge project root.
 *
 * Returns CLAUDE_PROJECT_DIR if set; otherwise falls back to process.cwd()
 * and writes a warning to stderr (same as spike-mcp-hello proof).
 */
export function resolveProjectRoot(): string {
	const envRoot = process.env["CLAUDE_PROJECT_DIR"];
	if (envRoot) {
		return envRoot;
	}
	const cwd = process.cwd();
	process.stderr.write(
		"[forge-mcp] CLAUDE_PROJECT_DIR not set — falling back to cwd: " + cwd + "\n",
	);
	return cwd;
}
