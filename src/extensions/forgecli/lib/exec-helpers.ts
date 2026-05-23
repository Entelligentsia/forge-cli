// lib/exec-helpers.ts — shared execFileAsync helper (N-C-E).
//
// Centralises the `promisify(execFile)` declaration that was independently
// copy-pasted in forge-tools.ts:24 and store-resolver.ts:14.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
