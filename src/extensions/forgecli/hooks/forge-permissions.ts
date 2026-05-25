// Forge permission pattern registry — FORGE-S23-T04.
//
// Port of forge/forge/hooks/forge-permissions.js pattern-match auto-allow logic.
// Pi has no PermissionRequest event, so "auto-allow" means: when the tool_call
// matches a known Forge pattern, silently return undefined (no block) from the
// tool_call handler, bypassing the two-layer-guard boundary check.
//
// Key differences from the plugin:
//   - No updatedPermissions / localSettings.json persistence: pi has no
//     PermissionRequest event or persistent allow-rule protocol. The rule
//     string is kept for audit-log display only.
//   - WEBFETCH_PATTERNS omitted: pi's @earendil-works/pi-coding-agent has no
//     WebFetchToolCallEvent type in its exported union. Adding dead code that
//     could never fire would be misleading.
//   - MultiEdit patterns omitted: pi has no MultiEdit event.
//   - node -e / node -p remain excluded: arbitrary code execution must not
//     be auto-approved. (Security decision from the original plugin, preserved.)
//
// File placement rationale: task prompt suggested "into two-layer-guard.ts",
// but that file has a tight single-responsibility scope. The T02 (write-guard.ts)
// and T03 (triage-error.ts) siblings establish the pattern: one concern per file.
// This file follows that convention per forge-cli-engineer Iron Law 8 (prefer
// architectural symmetry over literal prompt when prior art exists in the codebase).

/** A single pattern entry in the permission registry. */
interface PermissionPattern {
	/** Regex tested against the tool input string. */
	pattern: RegExp;
	/**
	 * Human-readable rule string — kept for audit-log display only.
	 * NOT persisted: pi has no PermissionRequest event.
	 */
	rule: string;
}

// ── Pattern registries — ported verbatim from forge-permissions.js ──────────

/** Bash command patterns that are auto-allowed. */
export const BASH_PATTERNS: PermissionPattern[] = [
	// Node tool invocations — covers $FORGE_ROOT/tools/*.cjs and $CLAUDE_PLUGIN_ROOT
	{ pattern: /^node\s+.*\/tools\/[\w-]+\.(cjs|js)\b/, rule: "node ~/.claude/plugins/cache/forge/forge/*/tools/*" },
	// NOTE: node -e and node -p are intentionally excluded — arbitrary code
	// execution must not be auto-approved. Forge workflows use node .../tools/*.cjs
	// for tool invocations; inline node -e/p requires explicit user approval.
	// Shell commands used by Forge workflows
	{ pattern: /^mkdir\s+-p\s+/, rule: "mkdir -p .forge/*" },
	{ pattern: /^mkdir\s+-p\s+\S+/, rule: "mkdir -p .forge/*" },
	{ pattern: /^cp\s+/, rule: "cp */schemas/*.schema.json .forge/schemas/" },
	{ pattern: /^ls\s+/, rule: "ls *" },
	{ pattern: /^cat\s+/, rule: "cat .forge/*" },
	{ pattern: /^date\s+-u\s+/, rule: "date -u *" },
	{ pattern: /^date\s+/, rule: "date -u *" },
	{ pattern: /^jq\s+/, rule: "jq *" },
	{ pattern: /^touch\s+/, rule: "touch .forge/*" },
	{ pattern: /^uname\s+/, rule: "uname *" },
	{ pattern: /^rm\s+\.forge/, rule: "rm .forge/*" },
	{ pattern: /^rm\s+-rf\s+\.forge/, rule: "rm -rf .forge/*" },
	{ pattern: /^rmdir\s+/, rule: "rmdir .forge/*" },
	{ pattern: /^gh\s+auth\s+/, rule: "gh auth status *" },
	{ pattern: /^gh\s+issue\s+/, rule: "gh issue create *" },
	// git read-only commands (already auto-approved by Claude Code, but belt-and-suspenders)
	{ pattern: /^git\s+status\b/, rule: "git status *" },
	{ pattern: /^git\s+log\b/, rule: "git log *" },
	{ pattern: /^git\s+diff\b/, rule: "git diff *" },
	{ pattern: /^git\s+add\s+/, rule: "git add *" },
	{ pattern: /^git\s+commit\s+-m\s+/, rule: "git commit -m *" },
	{ pattern: /^git\s+push\b/, rule: "git push *" },
	{ pattern: /^git\s+checkout\s+/, rule: "git checkout *" },
	{ pattern: /^git\s+branch\s+/, rule: "git branch *" },
	{ pattern: /^git\s+stash\b/, rule: "git stash *" },
	{ pattern: /^git\s+worktree\s+/, rule: "git worktree *" },
];

/** Write tool path patterns that are auto-allowed. */
export const WRITE_PATTERNS: PermissionPattern[] = [
	{ pattern: /^\.forge\//, rule: ".forge/**" },
	{ pattern: /^\.claude\/commands\//, rule: ".claude/commands/**" },
	{ pattern: /^engineering\//, rule: "engineering/**" },
	{ pattern: /^CLAUDE\.md$/i, rule: "CLAUDE.md" },
	{ pattern: /^AGENTS\.md$/i, rule: "AGENTS.md" },
	{ pattern: /^\.gitignore$/, rule: ".gitignore" },
];

/** Edit tool path patterns that are auto-allowed. */
export const EDIT_PATTERNS: PermissionPattern[] = [
	{ pattern: /^\.forge\//, rule: ".forge/**" },
	{ pattern: /^\.claude\/commands\//, rule: ".claude/commands/**" },
	{ pattern: /^engineering\//, rule: "engineering/**" },
	{ pattern: /^CLAUDE\.md$/i, rule: "CLAUDE.md" },
	{ pattern: /^AGENTS\.md$/i, rule: "AGENTS.md" },
];

// Map from pi tool name to its pattern list.
// NOTE: "multiedit" is omitted — pi has no MultiEdit event in its tool_call union.
// NOTE: "webfetch" is omitted — pi has no WebFetchToolCallEvent type.
const PATTERN_MAP: Record<string, PermissionPattern[]> = {
	bash: BASH_PATTERNS,
	write: WRITE_PATTERNS,
	edit: EDIT_PATTERNS,
};

/**
 * Check whether a pi tool_call matches a known Forge auto-allow pattern.
 *
 * @param toolName   The pi tool name ("bash", "write", "edit", etc.)
 * @param toolInput  The tool's input object (toolCallEvent.input)
 * @returns The matched rule string for audit logging, or null if no match.
 *          A non-null return is the "silently allow" signal — the caller
 *          should return undefined from the tool_call handler (no block).
 *
 * Input fields tested per tool type (mirrors plugin matchTool):
 *   bash   → toolInput.command   (string)
 *   write  → toolInput.path      (string; pi uses `path`, not `file_path`)
 *   edit   → toolInput.path      (string)
 */
export function matchForgePermission(toolName: string, toolInput: Record<string, unknown>): string | null {
	const patterns = PATTERN_MAP[toolName];
	if (!patterns) return null;

	let input: string;
	if (toolName === "bash") {
		input = typeof toolInput.command === "string" ? toolInput.command : "";
	} else if (toolName === "write" || toolName === "edit") {
		input = typeof toolInput.path === "string" ? toolInput.path : "";
	} else {
		return null;
	}

	for (const { pattern, rule } of patterns) {
		if (pattern.test(input)) return rule;
	}
	return null;
}
