// hooks/triage-error.ts — Post-Bash-failure Forge error triage (FORGE-S23-T03).
//
// Port of forge/forge/hooks/triage-error.js (71 lines) for the pi extension context.
//
// When a Bash tool call exits non-zero and the command matches a Forge-related
// pattern, the hook-dispatcher calls isForgeRelated() and, on a match, uses
// buildTriageMessage() to build a ctx.ui.notify message suggesting the user
// run /forge:report-bug.
//
// This module is a pure helper — no pi imports, no side effects. All logic is
// exported so tests can exercise it in isolation.
//
// Plugin parity reference: forge/forge/hooks/triage-error.js (read-only — do NOT edit).
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL6 — no shell-string interpolation; no spawn calls.

// ── Pattern set (ported verbatim from triage-error.js:10-20) ─────────────────

/**
 * Regex patterns that identify Forge-related Bash commands.
 * Ported verbatim from forge/forge/hooks/triage-error.js lines 10–20.
 * Exported as `readonly` so tests can verify count and identity.
 */
export const FORGE_PATTERNS: readonly RegExp[] = [
	/manage-config/,
	/\.forge\//,
	/CLAUDE_PLUGIN_ROOT/,
	/FORGE_ROOT/,
	/MANAGE_CONFIG/,
	/engineering\/tools\//,
	/forge:init/,
	/forge:health/,
	/forge:regenerate/,
	/forge:update/,
	/forge:add-pipeline/,
] as const;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true if the command matches any Forge-related pattern.
 * Mirrors `isForgeRelated()` from triage-error.js.
 */
export function isForgeRelated(command: string): boolean {
	return FORGE_PATTERNS.some((p) => p.test(command));
}

/**
 * Build the ctx.ui.notify message for a failed Forge-related command.
 *
 * Format (condensed for notification surface):
 *   FORGE_ERROR_TRIAGE: A Forge command just failed. [First error line: "...". ]
 *   Would you like to file a bug? Run /forge:report-bug
 *
 * @param command     The original bash command string (unused in message body; kept for future use).
 * @param outputSnippet  First few lines of tool output, already joined to a single string.
 *                       Empty string if no output is available.
 */
export function buildTriageMessage(_command: string, outputSnippet: string): string {
	const snippetPart = outputSnippet ? `First error line: "${outputSnippet}". ` : "";
	return (
		`FORGE_ERROR_TRIAGE: A Forge command just failed. ` +
		snippetPart +
		`Would you like to file a bug? Run /forge:report-bug`
	);
}
