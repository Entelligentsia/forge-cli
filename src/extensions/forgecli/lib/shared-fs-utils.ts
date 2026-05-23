// lib/shared-fs-utils.ts — shared filesystem predicates (C-16, S-3).
//
// Centralises the isFile / isDirectory helpers that were previously
// duplicated as private functions in forge-root.ts and subagent/agents.ts
// (and inlined in forge-tools.ts, store-resolver.ts, migration-engine.ts).
//
// Both helpers return `false` on any filesystem error (including ENOENT,
// EACCES, ENOTDIR). Callers that need to distinguish error kinds must call
// `fs.statSync` directly.

import * as fs from "node:fs";

/**
 * Returns true when `p` exists and is a regular file.
 * Returns false for directories, symlinks to directories, missing paths,
 * and any other filesystem error.
 */
export function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/**
 * Returns true when `p` exists and is a directory.
 * Returns false for regular files, missing paths, and any other filesystem
 * error.
 */
export function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}
