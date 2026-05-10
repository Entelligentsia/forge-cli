// Two-layer boundary guard — FORGE-S20-T07.
//
// Enforces at the pi tool layer that forge-cli runtime cannot write to
// forge/forge/meta/ (the Forge plugin's meta sources). The two-layer rule:
// fixes to Forge itself go through the forge-engineer/forge-bugfixer skills
// against forge/, not via forge-cli runtime edits.
//
// Until this guard landed, the rule was engineer-discipline only (per
// forge-cli-engineer/SKILL.md cross-pack invariants). With the guard in
// place, any `write` or `edit` tool call whose target path resolves under
// <cwd>/forge/forge/meta/ is rejected at the pi `tool_call` event with an
// operator-readable reason.
//
// Lexical containment, NOT symlink-aware:
//   We use path.resolve (no fs I/O, no symlink follow) for two reasons —
//     1. Targets of write often don't exist yet; fs.realpath would throw.
//     2. Symlinks under the meta tree should still be blocked; symlinks
//        under non-meta trees that happen to point at meta should still be
//        blocked. Lexical containment is the right semantic for a
//        development-tree boundary check.
//
// Scope (FORGE-S20-T07): strictly forge/forge/meta/. Broader scope
// (forge/, pi-mono/, raw .forge/store/ writes) is tracked as a follow-up
// per TASK_PROMPT.md §Out of scope.

import * as path from "node:path";

/** Result of a two-layer boundary check. */
export interface GuardVerdict {
	/** True if the write is permitted. */
	allowed: boolean;
	/**
	 * Operator-readable rejection reason. Set when allowed=false. Includes
	 * the canonical "fix the bug in forge-engineer/forge-bugfixer" pointer
	 * and the resolved absolute path.
	 */
	reason?: string;
	/**
	 * Absolute path the guard evaluated (after path.resolve). Always set so
	 * audit logs and tests can reference it without re-resolving.
	 */
	resolvedPath: string;
}

/**
 * Decide whether a write/edit targeting `targetPath` is permitted under the
 * two-layer boundary.
 *
 * @param targetPath  The path arg from a write/edit tool call. May be
 *                    relative or absolute, may contain `..` segments.
 * @param cwd         The forge-cli runtime working directory. The boundary
 *                    is `<cwd>/forge/forge/meta/` (lexical).
 *
 * Pure: no fs I/O. path.resolve canonicalizes `..` purely lexically.
 */
export function checkTwoLayerBoundary(targetPath: string, cwd: string): GuardVerdict {
	const metaPrefix = path.resolve(cwd, "forge", "forge", "meta") + path.sep;
	const resolved = path.resolve(cwd, targetPath);
	// Trailing-sep concat handles two cases:
	//   1. Sibling like "forge/forge/meta-archive/x" must NOT match (would
	//      pass startsWith without the trailing sep).
	//   2. The directory itself ("forge/forge/meta") must match (resolved
	//      becomes "<abs>/forge/forge/meta", + sep == metaPrefix exactly).
	const candidate = resolved + path.sep;
	if (!candidate.startsWith(metaPrefix)) {
		return { allowed: true, resolvedPath: resolved };
	}
	return {
		allowed: false,
		resolvedPath: resolved,
		reason:
			"forge-cli runtime cannot write to forge/forge/meta/ — fix the bug in " +
			"forge-engineer/forge-bugfixer skill against forge/ instead. " +
			`(resolved: ${resolved})`,
	};
}
