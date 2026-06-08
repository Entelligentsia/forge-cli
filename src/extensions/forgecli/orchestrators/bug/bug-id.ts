// bug-id.ts — bug record read helper plus the bug-ID minting / capture
// utilities (computeNextBugId, assignNextBugId, extractBugIdFromReportText,
// preCreateBug, extractBugIdFromEvents). Extracted VERBATIM from fix-bug.ts
// (FORGE-S31 file-size refactor); no logic changes.

import { spawnSync } from "node:child_process";

// ── Bug record helpers ─────────────────────────────────────────────────────

export interface BugRecord {
	bugId?: string;
	status?: string;
	summaries?: Record<string, unknown>;
	[key: string]: unknown;
}

export function readBugRecord(bugId: string, storeCli: string, cwd: string): BugRecord | null {
	const result = spawnSync("node", [storeCli, "read", "bug", bugId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return null;
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		return JSON.parse(raw) as BugRecord;
	} catch {
		return null;
	}
}

// Pure helper: next <PREFIX>-BUG-NNN ID given the existing bug IDs.
// Only same-prefix bugs participate in the increment — exported for tests.
// The prefix is config-owned (project.prefix) and identifier-validated by
// loadGovernorProjectConfig, so it is safe to splice into a RegExp.
export function computeNextBugId(bugIds: string[], prefix: string): string {
	const idPattern = new RegExp(`^${prefix}-BUG-(\\d+)$`);
	let maxNum = 0;
	for (const id of bugIds) {
		const m = idPattern.exec(id);
		if (m) {
			const n = parseInt(m[1], 10);
			if (n > maxNum) maxNum = n;
		}
	}
	return `${prefix}-BUG-${String(maxNum + 1).padStart(3, "0")}`;
}

// Pre-assigns a real <PREFIX>-BUG-NNN ID by listing existing bugs and
// incrementing. Prefix comes from .forge/config.json project.prefix — the
// hardcoded FORGE prefix minted phantom FORGE-BUG-* records in any project
// with a different prefix (CART testbench incident, FORGE-BUG-043 class).
export function assignNextBugId(storeCli: string, cwd: string, prefix = "FORGE"): string {
	const result = spawnSync("node", [storeCli, "list", "bug", "--json"], { cwd, encoding: "utf8" });
	let bugIds: string[] = [];
	if (result.status === 0 && result.stdout) {
		try {
			const bugs = JSON.parse(result.stdout as string);
			if (Array.isArray(bugs)) {
				bugIds = bugs.map((b) => String(b.bugId ?? ""));
			}
		} catch {
			/* empty store — start from 1 */
		}
	}
	return computeNextBugId(bugIds, prefix);
}

// Extracts the first canonical <PREFIX>-BUG-NNN referenced in a bug-report
// text (e.g. the "**Bug ID**: CART-BUG-001" header line BUG_REPORT.md files
// carry). Used by the @file intake path so /forge:fix-bug @BUG_REPORT.md
// operates on the referenced store record instead of minting a duplicate.
// Prefix is config-owned and identifier-validated (safe in a RegExp).
export function extractBugIdFromReportText(text: string, prefix: string): string | null {
	const m = text.match(new RegExp(`\\b${prefix}-BUG-\\d+\\b`));
	return m ? m[0] : null;
}

// Pre-creates a minimal bug record so the subagent has a real ID to work with.
export function preCreateBug(bugId: string, title: string, storeCli: string, cwd: string): boolean {
	const data = {
		bugId,
		title,
		severity: "minor",
		status: "reported",
		path: `engineering/bugs/${bugId}`,
		reportedAt: new Date().toISOString(),
	};
	const result = spawnSync("node", [storeCli, "write", "bug", JSON.stringify(data)], { cwd, encoding: "utf8" });
	return result.status === 0;
}

// ── BugId capture via tool_execution_end ──────────────────────────────────

/**
 * Scan tool_execution_end events to extract the bugId written by a triage
 * subagent. Returns the LAST matching tool call's bugId, or null if none found.
 *
 * In pi runtime, the forge_store tool is registered as "forge_store" (not
 * "store-cli"). In Claude Code runtime, subagents may shell out via Bash.
 * This function covers all three paths.
 */
export function extractBugIdFromEvents(
	events: Array<{ toolName?: string; result?: unknown }>,
	prefix = "FORGE",
): string | null {
	// Prefix is config-owned (project.prefix) and identifier-validated by
	// loadGovernorProjectConfig — the previous hardcoded FORGE-BUG- pattern
	// missed every capture in differently-prefixed projects (CART incident).
	const idPattern = new RegExp(`${prefix}-BUG-\\d+`);
	const idPrefix = `${prefix}-BUG-`;
	let lastBugId: string | null = null;
	for (const event of events) {
		if (!event.toolName) continue;
		// Check for store-cli write bug calls (Claude Code runtime)
		if (event.toolName === "store-cli") {
			const result = event.result;
			if (typeof result === "string") {
				const match = result.match(idPattern);
				if (match) lastBugId = match[0];
			} else if (result && typeof result === "object") {
				const obj = result as Record<string, unknown>;
				if (typeof obj.bugId === "string" && obj.bugId.startsWith(idPrefix)) {
					lastBugId = obj.bugId;
				}
			}
		}
		// Check for forge_store tool calls (pi runtime)
		// The pi extension registers the tool as "forge_store", not "store-cli".
		if (event.toolName === "forge_store" && event.result != null) {
			const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			const match = output.match(idPattern);
			if (match) lastBugId = match[0];
		}
		// Also check for write operations to .forge/store/bugs/
		if (event.toolName === "write" && typeof event.result === "string") {
			const match = event.result.match(idPattern);
			if (match) lastBugId = match[0];
		}
		// Bash events: subagents shelling out via Bash may run "store-cli write bug".
		// Only match when output includes store-cli, write, and bug together
		// to avoid false positives from unrelated Bash commands that happen to
		// mention a bug ID in a different context.
		if (event.toolName === "bash" && event.result != null) {
			const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			if (output.includes("store-cli") && output.includes("write") && output.includes("bug")) {
				const match = output.match(idPattern);
				if (match) lastBugId = match[0];
			}
		}
	}
	return lastBugId;
}
