// status-command.ts — native v0 handler for /forge:status (FORGE-S23-T10)
//
// Replaces the delegateMarkdownCommand stub that previously lived in forge-commands.ts.
// Reads the active sprint from store and lists tasks with their statuses.
// No TUI — text-only widget via ctx.ui.notify.
//
// Archetype: Atomic (no LLM in loop — pack-04 §Atomic).
// Iron Laws:
//   IL1 — new code lives in forge-cli/ only
//   IL6 — no shell-string interpolation (argv-array throughout)
//   IL7 — silent continuation past failures is never acceptable

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveToolDir } from "./store/store-resolver.js";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

interface SprintRecord {
	id: string;
	status?: string;
	title?: string;
}

interface TaskRecord {
	id: string;
	status?: string;
	title?: string;
}

interface StoreCLIListResult {
	results: SprintRecord[];
}

interface StoreCLISprintResult {
	results: TaskRecord[];
}

// ── Core runner ──────────────────────────────────────────────────────────────

export interface StatusResult {
	lines: string[];
	hasActiveSprint: boolean;
}

/**
 * Read active sprint and its tasks from store-cli.
 * Returns formatted text lines for display via ctx.ui.notify.
 * Exported so orchestrators can call directly without going through sendUserMessage.
 */
export async function runStatus(forgeRoot: string, cwd: string): Promise<StatusResult> {
	const toolDir = resolveToolDir(forgeRoot);
	const storeCliPath = path.join(toolDir, "store-cli.cjs");

	// Step 1: list all sprints
	let listResult: StoreCLIListResult;
	try {
		const out = await execFileAsync("node", [storeCliPath, "query", "--list-sprints"], {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
		});
		listResult = JSON.parse(out.stdout) as StoreCLIListResult;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			lines: [`× forge:status — could not list sprints: ${msg}`],
			hasActiveSprint: false,
		};
	}

	// Step 2: filter active sprints, sort by ID descending (proxy for recency)
	const activeSprints = (listResult.results ?? [])
		.filter((s) => s.status === "active")
		.sort((a, b) => b.id.localeCompare(a.id));

	if (activeSprints.length === 0) {
		return {
			lines: [
				"forge:status — No active sprint found.",
				'Run /forge:init to initialise a project, or check your store with /forge:search "--list-sprints".',
			],
			hasActiveSprint: false,
		};
	}

	// Use the most recent active sprint
	const sprint = activeSprints[0];

	// Step 3: fetch tasks for this sprint
	let sprintResult: StoreCLISprintResult;
	try {
		const out = await execFileAsync("node", [storeCliPath, "query", "--sprint", sprint.id], {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
		});
		sprintResult = JSON.parse(out.stdout) as StoreCLISprintResult;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			lines: [`× forge:status — could not fetch tasks for sprint ${sprint.id}: ${msg}`],
			hasActiveSprint: true,
		};
	}

	const tasks = sprintResult.results ?? [];

	// Step 4: format output
	const lines: string[] = [
		`Sprint: ${sprint.id}${sprint.title ? ` — ${sprint.title}` : ""}`,
		`Tasks: ${tasks.length}`,
		"",
	];

	if (tasks.length === 0) {
		lines.push("  (no tasks found)");
	} else {
		for (const task of tasks) {
			const status = task.status ?? "unknown";
			const title = task.title ? ` — ${task.title.slice(0, 60)}` : "";
			lines.push(`  ${task.id}  [${status}]${title}`);
		}
	}

	if (activeSprints.length > 1) {
		lines.push("");
		lines.push(
			`  Note: ${activeSprints.length - 1} other active sprint(s) found. Showing most recent (${sprint.id}).`,
		);
	}

	return { lines, hasActiveSprint: true };
}

// ── Register ─────────────────────────────────────────────────────────────────

/**
 * Register /forge:status (v0 native handler).
 * forgeRoot is nullable — null means we're outside a Forge project.
 */
export function registerStatusCommand(pi: ExtensionAPI, opts: { forgeRoot: string | null }): void {
	pi.registerCommand("forge:status", {
		description: "Sprint and task summary widget — lists active sprint and task statuses.",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();

			// Outside-project guard
			if (!opts.forgeRoot) {
				ctx.ui.notify("× forge:status — not inside a Forge project. Run /forge:init first.", "error");
				return;
			}

			ctx.ui.setStatus?.("forge:status", "Loading sprint status…");

			const result = await runStatus(opts.forgeRoot, cwd);

			ctx.ui.setStatus?.("forge:status", undefined);

			for (const line of result.lines) {
				const severity = line.startsWith("×") ? "error" : "info";
				ctx.ui.notify(line, severity);
			}
		},
	});
}

// ── Outside-project config guard helper ──────────────────────────────────────
// Not used above because forgeRoot is passed in at register time, but exported
// for use in tests that need to verify the guard path.

export function readForgeRootFromConfig(cwd: string): string | null {
	try {
		const configPath = path.join(cwd, ".forge", "config.json");
		const raw = fs.readFileSync(configPath, "utf8");
		const cfg = JSON.parse(raw) as Record<string, unknown>;
		const paths = cfg.paths as Record<string, unknown> | undefined;
		if (paths && typeof paths.forgeRoot === "string") return paths.forgeRoot;
	} catch {
		// fall through
	}
	return null;
}
