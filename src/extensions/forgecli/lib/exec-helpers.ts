// lib/exec-helpers.ts — shared tool invocation helpers (N-C-E, FORGE-S25-T23 B-4).
//
// Centralises the `promisify(execFile)` declaration that was independently
// copy-pasted in forge-tools.ts:24 and store-resolver.ts:14, and the
// `runTool`/`runToolAdvisory` pair extracted from forge-init.ts.

import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Promisified `execFile`. Use instead of declaring `promisify(execFile)`
 * locally in every module.
 *
 * Note: `forge-update-command.ts` deliberately keeps its own injectable
 * `runner` override for test isolation — do NOT migrate that module here.
 */
export const execFileAsync = promisify(execFile);

/** Convenience type alias for callers that need to annotate the signature. */
export type ExecFileAsyncType = typeof execFileAsync;

/**
 * Invoke a Node.js tool by path and wait for it to complete.
 * Throws a descriptive error (including tool basename) on non-zero exit.
 */
export async function runTool(toolPath: string, argv: string[], cwd: string, timeout = 30000): Promise<void> {
	try {
		await execFileAsync("node", [toolPath, ...argv], {
			cwd,
			timeout,
			encoding: "utf8",
		});
	} catch (err: unknown) {
		const e = err as { stderr?: string; message?: string };
		throw new Error(`Tool ${path.basename(toolPath)} failed: ${e.stderr?.trim() || e.message || "unknown error"}`);
	}
}

/**
 * Invoke a Node.js tool in advisory mode: on failure, notify via `ctx.ui.notify`
 * and return `false` instead of throwing.
 *
 * Returns `true` on success, `false` on failure. Callers that need hard failure
 * should use `runTool` directly.
 */
export async function runToolAdvisory(
	toolPath: string,
	argv: string[],
	cwd: string,
	ctx: ExtensionCommandContext,
	label: string,
	timeout = 30000,
): Promise<boolean> {
	try {
		await runTool(toolPath, argv, cwd, timeout);
		return true;
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(`△ ${label}: ${e.message ?? "failed"} — proceeding.`, "warning");
		return false;
	}
}
