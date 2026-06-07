// claude-bootstrap/settings-merge.ts — Forge hooks merge into .claude/settings.json (FORGE-S31-T03)
//
// Provides merge-not-clobber semantics for writing Forge's hook configuration into
// a project's .claude/settings.json. Existing keys (including hooks from other tools)
// are preserved byte-identical. Forge entries are only added where missing.
//
// Key contracts:
//   - Never overwrites a file that does not parse as JSON
//   - Running twice is idempotent: second run detects existing Forge entries and returns "already-present"
//   - Pure fs operations: no shell-outs, no LLM, no network

import * as fs from "node:fs";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MergeResult {
	outcome: "created" | "merged" | "already-present" | "error";
	warning?: string;
}

// The hooks block structure mirrors the Claude Code settings.json hooks schema.
// Each event type maps to an array of hook group entries.
interface HookEntry {
	type: "command";
	command: string;
	timeout: number;
}

interface SessionStartGroup {
	hooks: HookEntry[];
}

interface MatcherGroup {
	matcher: string;
	hooks: HookEntry[];
}

export interface ForgeSettingsHooks {
	SessionStart: SessionStartGroup[];
	PreToolUse: MatcherGroup[];
	PostToolUse: MatcherGroup[];
	PermissionRequest: MatcherGroup[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sentinel string used to identify Forge hook commands for dedup detection. */
const FORGE_HOOK_SENTINEL = ".forge/tools/hooks/";

// ── buildForgeHooksBlock ──────────────────────────────────────────────────────

/**
 * Returns the canonical Forge hooks block for project .claude/settings.json.
 *
 * All commands point at $CLAUDE_PROJECT_DIR/.forge/tools/hooks/<name>.cjs
 * (CLAUDE_PROJECT_DIR is a Claude Code runtime env var; not resolved at build time).
 *
 * Hook list mirrors forge/forge/hooks/hooks.json, with commands re-targeted
 * from ${CLAUDE_PLUGIN_ROOT}/hooks/ to $CLAUDE_PROJECT_DIR/.forge/tools/hooks/.
 */
export function buildForgeHooksBlock(): ForgeSettingsHooks {
	return {
		SessionStart: [
			{
				hooks: [
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/check-update.cjs"',
						timeout: 10000,
					},
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/preflight-session.cjs"',
						timeout: 10000,
					},
				],
			},
		],
		PreToolUse: [
			{
				matcher: "Write|Edit|MultiEdit",
				hooks: [
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/validate-write.cjs"',
						timeout: 5000,
					},
				],
			},
		],
		PostToolUse: [
			{
				matcher: "Bash",
				hooks: [
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/triage-error.cjs"',
						timeout: 5000,
					},
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/query-logger.cjs"',
						timeout: 3000,
					},
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/post-init.cjs"',
						timeout: 10000,
					},
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/post-sprint.cjs"',
						timeout: 10000,
					},
				],
			},
		],
		PermissionRequest: [
			{
				matcher: "Bash|Write|Edit|MultiEdit|WebFetch",
				hooks: [
					{
						type: "command",
						command: 'node "$CLAUDE_PROJECT_DIR/.forge/tools/hooks/forge-permissions.cjs"',
						timeout: 3000,
					},
				],
			},
		],
	};
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Checks whether a hooks block already contains Forge entries by looking for
 * the Forge hook sentinel string in any hook command.
 */
function hasForgeEntries(hooks: Record<string, unknown>): boolean {
	for (const eventGroups of Object.values(hooks)) {
		if (!Array.isArray(eventGroups)) continue;
		for (const group of eventGroups) {
			const g = group as { hooks?: Array<{ command?: string }> };
			if (!Array.isArray(g.hooks)) continue;
			for (const hook of g.hooks) {
				if (typeof hook.command === "string" && hook.command.includes(FORGE_HOOK_SENTINEL)) {
					return true;
				}
			}
		}
	}
	return false;
}

type EventType = "SessionStart" | "PreToolUse" | "PostToolUse" | "PermissionRequest";

/**
 * Merge Forge hooks into an existing hooks object.
 * For each event type, Forge entries are appended only where no Forge entry already exists
 * (detected by FORGE_HOOK_SENTINEL in command string).
 */
function mergeHooksIntoExisting(
	existing: Record<string, unknown>,
	forgeBlock: ForgeSettingsHooks,
): Record<string, unknown> {
	const merged = { ...existing };

	const eventTypes: EventType[] = ["SessionStart", "PreToolUse", "PostToolUse", "PermissionRequest"];

	for (const eventType of eventTypes) {
		const forgeGroups = forgeBlock[eventType];
		if (!forgeGroups || !Array.isArray(forgeGroups)) continue;

		const existingGroups = Array.isArray(merged[eventType]) ? [...(merged[eventType] as unknown[])] : [];

		// Check if any existing group already has Forge entries for this event type
		const alreadyHasForge = existingGroups.some((group) => {
			const g = group as { hooks?: Array<{ command?: string }> };
			return Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === "string" && h.command.includes(FORGE_HOOK_SENTINEL));
		});

		if (!alreadyHasForge) {
			// Append Forge groups for this event type
			existingGroups.push(...forgeGroups);
		}

		merged[eventType] = existingGroups;
	}

	return merged;
}

// ── mergeForgeHooks ───────────────────────────────────────────────────────────

/**
 * Merge Forge hooks into the project .claude/settings.json with merge-not-clobber semantics.
 *
 * Rules:
 * 1. File absent → create with { "hooks": <forgeHooksBlock> }.
 * 2. File present, valid JSON, no hooks key → add hooks key, preserve all other keys.
 * 3. File present, valid JSON, hooks key with all Forge entries already present → "already-present" (no-op).
 * 4. File present, valid JSON, hooks key with unrelated or missing Forge entries →
 *    merge Forge entries, preserve all existing non-Forge entries.
 * 5. File present, malformed JSON → "error", file never overwritten.
 * 6. Write failure → "error" with descriptive warning.
 */
export function mergeForgeHooks(settingsPath: string): MergeResult {
	const forgeBlock = buildForgeHooksBlock();

	// ── Branch 1: File absent ─────────────────────────────────────────────────
	if (!fs.existsSync(settingsPath)) {
		try {
			const content = JSON.stringify({ hooks: forgeBlock }, null, 2) + "\n";
			fs.writeFileSync(settingsPath, content, "utf8");
			return { outcome: "created" };
		} catch (err: unknown) {
			const e = err as { message?: string };
			return {
				outcome: "error",
				warning: `Could not write ${settingsPath}: ${e.message ?? String(err)}`,
			};
		}
	}

	// ── File present: read and parse ──────────────────────────────────────────
	let rawContent: string;
	try {
		rawContent = fs.readFileSync(settingsPath, "utf8");
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `Could not read ${settingsPath}: ${e.message ?? String(err)}`,
		};
	}

	// ── Branch 2 / 7: Empty or malformed JSON ────────────────────────────────
	if (rawContent.trim() === "") {
		return {
			outcome: "error",
			warning: `${settingsPath} is empty — cannot parse as JSON. Fix or delete the file and re-run.`,
		};
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(rawContent) as Record<string, unknown>;
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `${settingsPath} contains malformed JSON — will not overwrite. Parse error: ${e.message ?? String(err)}`,
		};
	}

	// ── Branch 3: Empty object {} (no hooks key) ──────────────────────────────
	// ── Branch 4: Has other keys but no hooks key ─────────────────────────────
	if (!("hooks" in parsed)) {
		try {
			const updated = { ...parsed, hooks: forgeBlock };
			const content = JSON.stringify(updated, null, 2) + "\n";
			fs.writeFileSync(settingsPath, content, "utf8");
			return { outcome: "merged" };
		} catch (err: unknown) {
			const e = err as { message?: string };
			return {
				outcome: "error",
				warning: `Could not write ${settingsPath}: ${e.message ?? String(err)}`,
			};
		}
	}

	// ── Branch 6: Already has Forge entries ───────────────────────────────────
	const existingHooks = parsed.hooks as Record<string, unknown>;
	if (hasForgeEntries(existingHooks)) {
		return { outcome: "already-present" };
	}

	// ── Branch 5: Has hooks key with unrelated entries — merge Forge in ───────
	try {
		const mergedHooks = mergeHooksIntoExisting(existingHooks, forgeBlock);
		const updated = { ...parsed, hooks: mergedHooks };
		const content = JSON.stringify(updated, null, 2) + "\n";
		fs.writeFileSync(settingsPath, content, "utf8");
		return { outcome: "merged" };
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `Could not write ${settingsPath}: ${e.message ?? String(err)}`,
		};
	}
}
