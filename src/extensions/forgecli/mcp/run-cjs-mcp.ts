// mcp/run-cjs-mcp.ts — thin subprocess wrapper for MCP server tool invocations.
//
// Similar to lib/run-cjs.ts but without the pi AbortSignal parameter (the MCP
// SDK callback signature does not pass one). Kept in a separate file to avoid
// importing pi types into the MCP server bundle.
//
// Iron Law 6 compliance: execFile with argv arrays only. No shell strings.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Spawn the *same* node binary that is running this MCP server, by absolute
// path, rather than the bare string "node". Claude Code launches the stdio
// server with an environment whose PATH may not contain a `node` (common with
// NVM/fnm/volta/asdf, or any restricted launch env) — `execFile("node", …)`
// then fails with `spawn node ENOENT`, killing all 12 cjs-wrapper tools while
// the 2 native in-process tools still work. Even where a `node` is on PATH it
// may be the wrong version. `process.execPath` is the absolute path of the
// running interpreter and is always correct and version-matched.
const NODE_BIN = process.execPath;

/**
 * Run a Forge .cjs tool as a subprocess.
 *
 * @param toolPath   Absolute path to the .cjs tool.
 * @param argv       Arguments passed after "node <toolPath>".
 * @param cwd        Directory containing .forge/ — becomes subprocess cwd.
 * @param timeoutMs  Subprocess timeout in milliseconds.
 */
export async function runCjsMcp(
	toolPath: string,
	argv: string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(NODE_BIN, [toolPath, ...argv], {
		cwd,
		encoding: "utf8" as BufferEncoding,
		timeout: timeoutMs,
	});
	const stdout = result.stdout;
	const stderr = result.stderr;
	return {
		stdout: typeof stdout === "string" ? stdout : String(stdout),
		stderr: typeof stderr === "string" ? stderr : String(stderr),
	};
}
