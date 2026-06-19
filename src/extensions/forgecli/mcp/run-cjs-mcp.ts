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
	const result = await execFileAsync("node", [toolPath, ...argv], {
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
