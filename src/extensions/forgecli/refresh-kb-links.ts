// refresh-kb-links.ts — TypeScript port of forge/forge/skills/refresh-kb-links/SKILL.md
//
// Scans coding-agent instruction files (CLAUDE.md, AGENTS.md, etc.) and
// ensures each has up-to-date managed sections linking to the Forge KB and
// workflows. Called directly by Phase 4 step 4-9 (Tomoshibi) during
// /forge:init and registered as the /forge:refresh-kb-links command handler.
//
// Per PLAN.md sub-decision #5 (F7 fix): TS port is the only valid implementation;
// forge/forge/skills/refresh-kb-links/SKILL.md is a markdown body with no
// runnable .cjs entry point.
//
// Iron Law 6: no shell-string interpolation.
// Iron Law 1: reads .forge/config.json — no writes to forge/ source.

import * as fs from "node:fs";
import * as path from "node:path";

// ── Known agent instruction files ─────────────────────────────────────────

const AGENT_INSTRUCTION_FILES = [
	"CLAUDE.md",
	"AGENTS.md",
	"AGENT.md",
	"GEMINI.md",
	".cursorrules",
	".github/copilot-instructions.md",
] as const;

// ── Known workflow files ───────────────────────────────────────────────────

const WORKFLOW_ENTRIES: Array<{ file: string; label: string; purpose: string }> = [
	{ file: "plan_task.md", label: "Plan", purpose: "Research codebase → implementation plan" },
	{ file: "implement_plan.md", label: "Implement", purpose: "Execute approved plan → code changes" },
	{ file: "fix_bug.md", label: "Fix bug", purpose: "Triage → fix → verify" },
	{
		file: "orchestrate_task.md",
		label: "Run task",
		purpose: "Full task pipeline (plan → implement → review → commit)",
	},
	{ file: "run_sprint.md", label: "Run sprint", purpose: "Full sprint orchestration" },
	{ file: "architect_sprint_plan.md", label: "Sprint plan", purpose: "Sprint planning and task decomposition" },
	{
		file: "architect_sprint_intake.md",
		label: "Sprint intake",
		purpose: "Sprint intake and requirements elicitation",
	},
];

// ── Managed section markers ────────────────────────────────────────────────

const KB_OPEN_PREFIX = "<!-- forge-kb-links";
const KB_CLOSE = "<!-- /forge-kb-links -->";
const WF_OPEN_PREFIX = "<!-- forge-workflow-links";
const WF_CLOSE = "<!-- /forge-workflow-links -->";

// ── Content generators ─────────────────────────────────────────────────────

function buildKbSection(cwd: string, kbPath: string): string {
	const rows: Array<{ label: string; file: string; desc: string }> = [
		{ label: "MASTER_INDEX", file: `${kbPath}/MASTER_INDEX.md`, desc: "All sprints, tasks, bugs, and features" },
		{
			label: "Architecture",
			file: `${kbPath}/architecture/INDEX.md`,
			desc: "Stack, processes, database, routing, deployment",
		},
		{
			label: "Business Domain",
			file: `${kbPath}/business-domain/INDEX.md`,
			desc: "Entity model and domain concepts",
		},
	].filter((r) => fs.existsSync(path.join(cwd, r.file)));

	if (rows.length === 0) return "";

	const tableRows = rows.map((r) => `| [${r.label}](${r.file}) | ${r.desc} |`).join("\n");

	return [
		`<!-- forge-kb-links: managed by Forge — do not edit manually -->`,
		`## Forge Knowledge Base`,
		``,
		`| Index | Contents |`,
		`|-------|----------|`,
		tableRows,
		``,
		`Personas live in \`.forge/personas/\`.`,
		KB_CLOSE,
	].join("\n");
}

function buildWorkflowSection(cwd: string): string {
	const rows = WORKFLOW_ENTRIES.filter((e) => fs.existsSync(path.join(cwd, ".forge", "workflows", e.file)));

	if (rows.length === 0) return "";

	const tableRows = rows.map((e) => `| [${e.label}](.forge/workflows/${e.file}) | ${e.purpose} |`).join("\n");

	return [
		`<!-- forge-workflow-links: managed by Forge — do not edit manually -->`,
		`## Forge Workflows`,
		``,
		`| Workflow | Purpose |`,
		`|----------|---------|`,
		tableRows,
		WF_CLOSE,
	].join("\n");
}

// ── Section replacement ────────────────────────────────────────────────────

/**
 * Replace or append a managed section in a file's content.
 * If the section already exists (detected by open-prefix), replaces it.
 * Otherwise, appends it to the end.
 */
function upsertSection(content: string, openPrefix: string, closeMarker: string, newSection: string): string {
	if (!newSection) return content; // nothing to inject

	// Find existing section
	const openIdx = content.indexOf(openPrefix);
	if (openIdx !== -1) {
		const closeIdx = content.indexOf(closeMarker, openIdx);
		if (closeIdx !== -1) {
			const endIdx = closeIdx + closeMarker.length;
			// Replace existing section
			return content.slice(0, openIdx) + newSection + content.slice(endIdx);
		}
	}

	// Append at end, ensuring a blank line separator
	const trimmed = content.trimEnd();
	return trimmed + "\n\n" + newSection + "\n";
}

// ── Result type ────────────────────────────────────────────────────────────

export interface RefreshKbLinksResult {
	filesUpdated: number;
	filesSkipped: number;
	messages: string[];
}

// ── Main exported function ─────────────────────────────────────────────────

/**
 * Run the refresh-kb-links operation on the project at `cwd`.
 *
 * Returns a result record with counts and human-readable messages.
 * Never throws — errors are captured as messages.
 */
export async function runRefreshKbLinks(cwd: string): Promise<RefreshKbLinksResult> {
	const result: RefreshKbLinksResult = {
		filesUpdated: 0,
		filesSkipped: 0,
		messages: [],
	};

	// Read kbPath from .forge/config.json
	let kbPath = "engineering";
	try {
		const configRaw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
		const config = JSON.parse(configRaw) as Record<string, unknown>;
		const paths = config.paths as Record<string, unknown> | undefined;
		if (paths && typeof paths.engineering === "string" && paths.engineering) {
			kbPath = paths.engineering;
		}
	} catch {
		// Config not present — use default kbPath
	}

	const kbSection = buildKbSection(cwd, kbPath);
	const wfSection = buildWorkflowSection(cwd);

	if (!kbSection && !wfSection) {
		result.messages.push("△ refresh-kb-links: no KB or workflow files found to link.");
		return result;
	}

	for (const filename of AGENT_INSTRUCTION_FILES) {
		const filePath = path.join(cwd, filename);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			// File does not exist — skip
			result.filesSkipped++;
			continue;
		}

		let updated = content;
		if (kbSection) {
			updated = upsertSection(updated, KB_OPEN_PREFIX, KB_CLOSE, kbSection);
		}
		if (wfSection) {
			updated = upsertSection(updated, WF_OPEN_PREFIX, WF_CLOSE, wfSection);
		}

		if (updated !== content) {
			try {
				fs.writeFileSync(filePath, updated, "utf8");
				result.filesUpdated++;
				result.messages.push(`〇 refresh-kb-links: updated ${filename}`);
			} catch (err: unknown) {
				const e = err as { message?: string };
				result.messages.push(`△ refresh-kb-links: failed to write ${filename}: ${e.message ?? "unknown"}`);
			}
		} else {
			result.filesSkipped++;
		}
	}

	// Handle .cursor/rules/*.mdc files
	const cursorRulesDir = path.join(cwd, ".cursor", "rules");
	if (fs.existsSync(cursorRulesDir)) {
		try {
			const mdcFiles = fs.readdirSync(cursorRulesDir).filter((f) => f.endsWith(".mdc"));
			for (const mdcFile of mdcFiles) {
				const filePath = path.join(cursorRulesDir, mdcFile);
				let content: string;
				try {
					content = fs.readFileSync(filePath, "utf8");
				} catch {
					result.filesSkipped++;
					continue;
				}
				let updated = content;
				if (kbSection) {
					updated = upsertSection(updated, KB_OPEN_PREFIX, KB_CLOSE, kbSection);
				}
				if (wfSection) {
					updated = upsertSection(updated, WF_OPEN_PREFIX, WF_CLOSE, wfSection);
				}
				if (updated !== content) {
					fs.writeFileSync(filePath, updated, "utf8");
					result.filesUpdated++;
					result.messages.push(`〇 refresh-kb-links: updated .cursor/rules/${mdcFile}`);
				} else {
					result.filesSkipped++;
				}
			}
		} catch {
			// Skip if unreadable
		}
	}

	return result;
}

// ── Handler factory ────────────────────────────────────────────────────────

/**
 * Get a standalone refresh-kb-links handler suitable for direct invocation
 * from Phase 4 step 4-9. Returns a function that takes cwd and calls
 * runRefreshKbLinks.
 */
export function getRefreshKbLinksHandler(): (cwd: string) => Promise<RefreshKbLinksResult> {
	return runRefreshKbLinks;
}
