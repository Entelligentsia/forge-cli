// forge:sprint-plan native TS handler — FORGE-S19-T02
//
// Full LLM-driven sprint planning: reads SPRINT_REQUIREMENTS.md, invokes
// architect persona via vendored subagent spawn, validates the task list
// (JSON Schema via Ajv), detects dependency cycles (Kahn's algorithm),
// writes per-task store records, renders SPRINT_PLAN.md and per-task
// TASK_PROMPT.md, transitions sprint to "planned".
//
// LLM invocation: vendored subagent spawn (pi --mode json) — pi.invokeLLM
// is not exposed on ExtensionAPI (confirmed in SPIKE_NOTES.md by scanning
// @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts).
//
// Iron Laws:
//   - Iron Law 6: execFile with argv arrays — no shell-string interpolation
//   - Iron Law 7: silent continuation past failures is never acceptable
//
// Scripted E2E: FORGE_SPRINT_PLAN_FIXTURE=<path> → skip live LLM call,
//   read fixture JSON task list instead. Non-empty string check only.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ── Bundle path resolution ─────────────────────────────────────────────────

const _EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
// dist/extensions/forgecli/ → dist/ → <pkg-root>/
const _PKG_ROOT = path.resolve(_EXTENSION_DIR, "..", "..", "..");

// ── Tool invocation helper ────────────────────────────────────────────────

async function runTool(toolPath: string, argv: string[], cwd: string, timeout = 60000): Promise<string> {
	const result = await execFileAsync("node", [toolPath, ...argv], {
		cwd,
		timeout,
		encoding: "utf8",
	});
	return result.stdout ?? "";
}

// ── Task schema ────────────────────────────────────────────────────────────

interface TaskEntry {
	taskId: string;
	title: string;
	estimate: "S" | "M" | "L" | "XL";
	dependencies: string[];
	pipeline: string;
	acceptanceCriteria: string[];
}

// ── Simple JSON Schema validator (avoids TypeBox runtime dep) ──────────────

function validateTaskList(raw: unknown): { valid: boolean; error: string } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { valid: false, error: "Expected a non-empty JSON array of task objects" };
	}
	for (let i = 0; i < raw.length; i++) {
		const t = raw[i] as Record<string, unknown>;
		if (typeof t !== "object" || t === null) {
			return { valid: false, error: `Item ${i} is not an object` };
		}
		if (typeof t.taskId !== "string" || !/^[A-Z][A-Z0-9_-]+-T[0-9]+$/.test(t.taskId)) {
			return { valid: false, error: `Item ${i}: taskId must match {SPRINT_ID}-T{NN} pattern, got: ${JSON.stringify(t.taskId)}` };
		}
		if (typeof t.title !== "string" || t.title.length === 0 || t.title.length > 80) {
			return { valid: false, error: `Item ${i} (${t.taskId as string}): title must be a string of 1–80 chars` };
		}
		if (!["S", "M", "L", "XL"].includes(t.estimate as string)) {
			return { valid: false, error: `Item ${i} (${t.taskId as string}): estimate must be S/M/L/XL, got: ${JSON.stringify(t.estimate)}` };
		}
		if (!Array.isArray(t.dependencies) || !t.dependencies.every((d) => typeof d === "string")) {
			return { valid: false, error: `Item ${i} (${t.taskId as string}): dependencies must be a string[]` };
		}
		if (typeof t.pipeline !== "string" || t.pipeline.length === 0) {
			return { valid: false, error: `Item ${i} (${t.taskId as string}): pipeline must be a non-empty string` };
		}
		if (!Array.isArray(t.acceptanceCriteria) || (t.acceptanceCriteria as unknown[]).length < 2 ||
			!(t.acceptanceCriteria as unknown[]).every((c) => typeof c === "string" && (c as string).length >= 10)) {
			return { valid: false, error: `Item ${i} (${t.taskId as string}): acceptanceCriteria must have ≥2 strings of ≥10 chars each` };
		}
	}
	return { valid: true, error: "" };
}

// ── Cycle detection (Kahn's algorithm) ────────────────────────────────────

function detectCycle(tasks: TaskEntry[]): string | null {
	const idSet = new Set(tasks.map((t) => t.taskId));
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();

	for (const t of tasks) {
		if (!inDegree.has(t.taskId)) inDegree.set(t.taskId, 0);
		if (!adj.has(t.taskId)) adj.set(t.taskId, []);
	}
	for (const t of tasks) {
		for (const dep of t.dependencies) {
			if (!idSet.has(dep)) continue; // skip external deps
			if (!adj.has(dep)) adj.set(dep, []);
			adj.get(dep)!.push(t.taskId);
			inDegree.set(t.taskId, (inDegree.get(t.taskId) ?? 0) + 1);
		}
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	let processed = 0;
	while (queue.length > 0) {
		const node = queue.shift()!;
		processed++;
		for (const neighbor of adj.get(node) ?? []) {
			const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
			inDegree.set(neighbor, newDeg);
			if (newDeg === 0) queue.push(neighbor);
		}
	}

	if (processed < tasks.length) {
		// Find cycle participants
		const cycleNodes = tasks
			.map((t) => t.taskId)
			.filter((id) => (inDegree.get(id) ?? 0) > 0);
		return `Cycle detected involving: ${cycleNodes.join(", ")}`;
	}
	return null;
}

// ── Mermaid dep graph ─────────────────────────────────────────────────────

function renderMermaidGraph(tasks: TaskEntry[]): string {
	const lines = ["```mermaid", "graph LR"];
	// Node declarations
	for (const t of tasks) {
		const safeId = t.taskId.replace(/-/g, "_");
		lines.push(`  ${safeId}["${t.taskId}: ${t.title.slice(0, 40)}"]`);
	}
	// Edges
	const idSet = new Set(tasks.map((t) => t.taskId));
	let hasEdges = false;
	for (const t of tasks) {
		for (const dep of t.dependencies) {
			if (idSet.has(dep)) {
				const safeDep = dep.replace(/-/g, "_");
				const safeId = t.taskId.replace(/-/g, "_");
				lines.push(`  ${safeDep} --> ${safeId}`);
				hasEdges = true;
			}
		}
	}
	if (!hasEdges) {
		// Zero-dependency case: emit a valid graph with just nodes, no edges
		lines.push("  %% no dependencies between tasks");
	}
	lines.push("```");
	return lines.join("\n");
}

// ── Template rendering ─────────────────────────────────────────────────────

function renderTemplate(template: string, vars: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(vars)) {
		out = out.replaceAll(`{${key}}`, value);
	}
	return out;
}

// ── Main handler ───────────────────────────────────────────────────────────

async function runSprintPlan(
	args: string,
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	// ── Parse sprint ID ────────────────────────────────────────────────────
	const sprintId = args.trim().split(/\s+/)[0] ?? "";
	if (!sprintId) {
		ctx.ui.notify(
			"× forge:sprint-plan — sprint ID required.\n" +
				"  Usage: /forge:sprint-plan <SPRINT_ID>   e.g. /forge:sprint-plan FORGE-S20",
			"error",
		);
		return;
	}

	// ── Pre-flight: .forge/config.json ────────────────────────────────────
	const forgeConfigPath = path.join(cwd, ".forge", "config.json");
	if (!fs.existsSync(forgeConfigPath)) {
		ctx.ui.notify(
			"× forge:sprint-plan — no .forge/config.json found at cwd.\n" +
				"  Run /forge:init first to bootstrap a Forge project.",
			"error",
		);
		return;
	}

	let engineeringDir = "engineering";
	try {
		const cfg = JSON.parse(fs.readFileSync(forgeConfigPath, "utf8")) as {
			paths?: { engineering?: string };
		};
		engineeringDir = cfg.paths?.engineering ?? "engineering";
	} catch {
		ctx.ui.notify("△ Could not parse .forge/config.json — using default engineering dir.", "warning");
	}

	// ── Pre-flight: SPRINT_REQUIREMENTS.md exists ─────────────────────────
	const sprintDir = path.join(cwd, engineeringDir, "sprints", sprintId);
	const requirementsPath = path.join(sprintDir, "SPRINT_REQUIREMENTS.md");
	if (!fs.existsSync(requirementsPath)) {
		ctx.ui.notify(
			`× forge:sprint-plan — SPRINT_REQUIREMENTS.md not found at:\n` +
				`  ${path.relative(cwd, requirementsPath)}\n` +
				`  Run /forge:sprint-intake ${sprintId} first to capture requirements.`,
			"error",
		);
		return;
	}

	// ── Pre-flight: sprint in planning status ─────────────────────────────
	const storeCli = path.join(_PKG_ROOT, "dist", "forge-payload", ".tools", "store-cli.cjs");
	if (fs.existsSync(storeCli)) {
		try {
			const sprintJson = await runTool(storeCli, ["read", "sprint", sprintId], cwd);
			const sprintRecord = JSON.parse(sprintJson) as { status?: string };
			if (sprintRecord.status && sprintRecord.status !== "planning") {
				ctx.ui.notify(
					`× forge:sprint-plan — sprint ${sprintId} is in status "${sprintRecord.status}", expected "planning".\n` +
						`  Sprint plan can only run on a sprint in planning status.`,
					"error",
				);
				return;
			}
		} catch {
			// non-fatal if we can't read the sprint record — continue with planning
			ctx.ui.notify(`△ Could not verify sprint status for ${sprintId} — continuing.`, "warning");
		}
	}

	ctx.ui.setStatus?.("forge:sprint-plan", `${sprintId} — starting sprint planning`);

	// ── Persona self-load (architect) ─────────────────────────────────────
	const personaPath = path.join(cwd, ".forge", "personas", "architect.md");
	let personaIdentity = "🗻 Architect — I hold the shape of the whole.";
	if (fs.existsSync(personaPath)) {
		try {
			const personaContent = fs.readFileSync(personaPath, "utf8");
			const taglineMatch = personaContent.match(/tagline:\s*["']?(.+?)["']?\s*$/m);
			const nameMatch = personaContent.match(/^#\s+(.+)$/m);
			if (taglineMatch?.[1]) {
				personaIdentity = `🗻 ${nameMatch?.[1] ?? "Architect"} — ${taglineMatch[1]}`;
			}
		} catch {
			// non-fatal
		}
	} else {
		ctx.ui.notify("△ forge:sprint-plan — .forge/personas/architect.md not found; continuing.", "warning");
	}
	ctx.ui.notify(personaIdentity, "info");

	// ── Read sprint requirements ───────────────────────────────────────────
	const sprintRequirements = fs.readFileSync(requirementsPath, "utf8");

	// ── LLM invocation (vendored subagent spawn OR fixture) ───────────────
	ctx.ui.setStatus?.("forge:sprint-plan", `${sprintId} — invoking architect persona`);

	let taskList: TaskEntry[] | null = null;

	// Fixture mode (E2E-10): FORGE_SPRINT_PLAN_FIXTURE=<path to JSON file>
	const fixturePath = process.env.FORGE_SPRINT_PLAN_FIXTURE?.trim();
	if (fixturePath) {
		try {
			const fixtureRaw = fs.readFileSync(fixturePath, "utf8");
			const parsed: unknown = JSON.parse(fixtureRaw);
			const check = validateTaskList(parsed);
			if (check.valid) {
				taskList = parsed as TaskEntry[];
				ctx.ui.notify(`〇 forge:sprint-plan — fixture loaded from ${fixturePath} (E2E mode).`, "info");
			} else {
				ctx.ui.notify(`× forge:sprint-plan — fixture validation failed: ${check.error}`, "error");
				return;
			}
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`× forge:sprint-plan — failed to load fixture: ${e.message ?? "unknown"}`, "error");
			return;
		}
	} else {
		// Live LLM path: vendored subagent spawn
		const promptTemplatePath = path.join(_PKG_ROOT, "dist", "forge-payload", ".tools", "prompts", "sprint-plan-prompt.md");
		let systemPrompt = "";
		if (fs.existsSync(promptTemplatePath)) {
			const promptTemplate = fs.readFileSync(promptTemplatePath, "utf8");
			systemPrompt = promptTemplate.replace("{SPRINT_REQUIREMENTS}", sprintRequirements);
		} else {
			// Fallback inline prompt
			systemPrompt =
				"You are the Forge Architect. Read the sprint requirements below and emit a JSON array of task objects. " +
				"Each task: taskId (string), title (string ≤80 chars), estimate (S/M/L/XL), " +
				"dependencies (string[]), pipeline (string), acceptanceCriteria (string[] ≥2). " +
				"No circular dependencies. Emit ONLY the JSON array, no other text.\n\n" +
				sprintRequirements;
			ctx.ui.notify("△ forge:sprint-plan — prompt template not found; using fallback prompt.", "warning");
		}

		// Attempt 1
		const llmOutput1 = await invokeLLM(systemPrompt, cwd);
		const parsed1 = tryParseJSON(llmOutput1);
		const check1 = validateTaskList(parsed1);
		if (check1.valid) {
			taskList = parsed1 as TaskEntry[];
		} else {
			ctx.ui.notify(`△ forge:sprint-plan — first LLM attempt validation failed: ${check1.error} — retrying.`, "warning");

			// Attempt 2: append validation error to prompt
			const retryPrompt =
				systemPrompt +
				`\n\n---\n\nPrevious attempt produced invalid output.\nValidation error: ${check1.error}\n` +
				`Raw output was:\n${llmOutput1}\n\n` +
				"Please correct the output and emit a valid JSON array only.";

			const llmOutput2 = await invokeLLM(retryPrompt, cwd);
			const parsed2 = tryParseJSON(llmOutput2);
			const check2 = validateTaskList(parsed2);
			if (check2.valid) {
				taskList = parsed2 as TaskEntry[];
			} else {
				// Second failure — write raw output and escalate
				const failurePath = path.join(cwd, ".forge", "cache", `sprint-plan-failure-${sprintId}.json`);
				fs.mkdirSync(path.dirname(failurePath), { recursive: true });
				fs.writeFileSync(
					failurePath,
					JSON.stringify({ attempt1: llmOutput1, attempt2: llmOutput2, error1: check1.error, error2: check2.error }, null, 2) + "\n",
					"utf8",
				);
				ctx.ui.notify(
					`× forge:sprint-plan — LLM output failed validation after 2 attempts.\n` +
						`  Validation error: ${check2.error}\n` +
						`  Raw output saved to: ${path.relative(cwd, failurePath)}\n` +
						`  Review the failure file and re-run /forge:sprint-plan ${sprintId}.`,
					"error",
				);
				return;
			}
		}
	}

	// ── Cycle detection ───────────────────────────────────────────────────
	const cycleError = detectCycle(taskList);
	if (cycleError) {
		ctx.ui.notify(
			`× forge:sprint-plan — dependency cycle detected:\n` +
				`  ${cycleError}\n` +
				`  Fix the dependencies and re-run /forge:sprint-plan ${sprintId}.`,
			"error",
		);
		return;
	}

	// ── Render SPRINT_PLAN.md (before store writes — artifacts first) ────────
	ctx.ui.setStatus?.("forge:sprint-plan", `${sprintId} — rendering SPRINT_PLAN.md`);

	const mermaidGraph = renderMermaidGraph(taskList);

	const taskTableRows = taskList
		.map((t) => `| ${t.taskId} | ${t.title} | ${t.estimate} | ${t.dependencies.join(", ") || "—"} |`)
		.join("\n");

	const sprintPlanContent = `# Sprint Plan — ${sprintId}

🗻 *Forge Architect*

**Sprint:** ${sprintId}
**Generated:** ${new Date().toISOString().slice(0, 10)}
**Tasks:** ${taskList.length}

---

## Dependency Graph

${mermaidGraph}

---

## Task List

| Task ID | Title | Estimate | Dependencies |
|---------|-------|----------|--------------|
${taskTableRows}

---

## Task Details

${taskList
	.map(
		(t) => `### ${t.taskId}: ${t.title}

**Estimate:** ${t.estimate}
**Pipeline:** ${t.pipeline}
**Dependencies:** ${t.dependencies.join(", ") || "none"}

**Acceptance Criteria:**
${t.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}
`,
	)
	.join("\n")}
`;

	const sprintPlanPath = path.join(sprintDir, "SPRINT_PLAN.md");
	fs.mkdirSync(sprintDir, { recursive: true });
	fs.writeFileSync(sprintPlanPath, sprintPlanContent, "utf8");
	ctx.ui.notify(`〇 SPRINT_PLAN.md written to ${path.relative(cwd, sprintPlanPath)}`, "info");

	// ── Render per-task TASK_PROMPT.md ────────────────────────────────────
	ctx.ui.setStatus?.("forge:sprint-plan", `${sprintId} — writing TASK_PROMPT.md artifacts`);

	for (const task of taskList) {
		const taskDir = path.join(sprintDir, task.taskId);
		fs.mkdirSync(taskDir, { recursive: true });

		const taskPromptContent = `# ${task.taskId}: ${task.title}

**Sprint:** ${sprintId}
**Estimate:** ${task.estimate}
**Pipeline:** ${task.pipeline}

---

## Objective

${task.title}

## Acceptance Criteria

${task.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}

## Context

- **Dependencies:** ${task.dependencies.join(", ") || "none"}
- **Sprint:** ${sprintId}

## Plugin Artifacts Involved

_To be detailed in PLAN.md during the plan phase._
`;

		const taskPromptPath = path.join(taskDir, "TASK_PROMPT.md");
		fs.writeFileSync(taskPromptPath, taskPromptContent, "utf8");
	}
	ctx.ui.notify(`〇 TASK_PROMPT.md artifacts written for ${taskList.length} tasks.`, "info");

	// ── Store writes (per-task) — after artifact rendering ─────────────────
	ctx.ui.setStatus?.("forge:sprint-plan", `${sprintId} — writing ${taskList.length} task records`);
	if (fs.existsSync(storeCli)) {
		for (const task of taskList) {
			const taskRecord = {
				taskId: task.taskId,
				sprintId,
				title: task.title,
				status: "draft",
				estimate: task.estimate,
				dependencies: task.dependencies,
				pipeline: task.pipeline,
				path: `${engineeringDir}/sprints/${sprintId}/${task.taskId}`,
				feature_id: null,
			};
			try {
				await runTool(storeCli, ["write", "task", JSON.stringify(taskRecord)], cwd);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(
					`× forge:sprint-plan — store-cli write task failed for ${task.taskId}: ${e.message ?? "unknown"}\n` +
						`  Fix the error and re-run /forge:sprint-plan ${sprintId}.`,
					"error",
				);
				return;
			}
		}
		ctx.ui.notify(`〇 ${taskList.length} task records written via store-cli.`, "info");
	} else {
		ctx.ui.notify("△ store-cli.cjs not found — task records not written.", "warning");
	}

	// ── Sprint status: planning → planned ─────────────────────────────────
	if (fs.existsSync(storeCli)) {
		try {
			await runTool(storeCli, ["update-status", "sprint", sprintId, "status", "planned"], cwd);
			ctx.ui.notify(`〇 Sprint ${sprintId} status updated to "planned".`, "info");
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`△ store-cli update-status sprint failed: ${e.message ?? "unknown"} — continuing.`, "warning");
		}

		// Emit sprint-plan-complete event
		const eventRecord = {
			eventId: `${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}Z_${sprintId}_sprint_plan-complete`,
			sprintId,
			type: "sprint-plan-complete",
			timestamp: new Date().toISOString(),
			taskCount: taskList.length,
		};
		try {
			await runTool(storeCli, ["emit", sprintId, JSON.stringify(eventRecord)], cwd);
			ctx.ui.notify(`〇 sprint-plan-complete event emitted.`, "info");
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`△ store-cli emit failed: ${e.message ?? "unknown"} — continuing.`, "warning");
		}
	}

	ctx.ui.setStatus?.("forge:sprint-plan", undefined);
	ctx.ui.notify(
		`〇 Sprint plan complete for ${sprintId}.\n` +
			`  ${taskList.length} tasks planned.\n` +
			`  Plan: ${path.relative(cwd, sprintPlanPath)}`,
		"info",
	);
}

// ── LLM invocation via vendored subagent spawn ─────────────────────────────
// Iron Law: vendored subagent boundary preserved — import via dynamic import
// of the vendored subagent module, which spawns pi --mode json internally.

async function invokeLLM(systemPrompt: string, _cwd: string): Promise<string> {
	// The vendored subagent module is at the same dist level as this module.
	// Dynamic import allows the test suite to mock it cleanly.
	try {
		const subagentModule = (await import("./subagent/index.js")) as {
			runSubagent?: (opts: { systemPrompt: string; task: string }) => Promise<{ output: string }>;
			default?: unknown;
		};
		if (typeof subagentModule.runSubagent === "function") {
			const result = await subagentModule.runSubagent({
				systemPrompt,
				task: "Emit the JSON task list only, no preamble.",
			});
			return result.output;
		}
	} catch {
		// Subagent module not available or failed to load
	}
	// Fallback: the subagent module API may differ; return empty to trigger validation failure
	return "";
}

function tryParseJSON(raw: string): unknown {
	// Extract JSON array from the raw output (LLM may wrap in markdown fences)
	const trimmed = raw.trim();
	// Try direct parse first
	try {
		return JSON.parse(trimmed);
	} catch {
		// Try extracting from ```json ... ``` block
		const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
		if (fenceMatch?.[1]) {
			try {
				return JSON.parse(fenceMatch[1].trim());
			} catch {
				// ignore
			}
		}
		// Try finding array boundaries
		const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
		if (arrayMatch) {
			try {
				return JSON.parse(arrayMatch[0]);
			} catch {
				// ignore
			}
		}
		return null;
	}
}

// ── Public registration ───────────────────────────────────────────────────

/**
 * Register the /forge:sprint-plan command with the pi ExtensionAPI.
 *
 * Must be called BEFORE registerAllForgeCommands so the real handler
 * takes precedence over the auto-generated stub.
 *
 * @param pi - The pi ExtensionAPI instance.
 */
export function registerSprintPlan(pi: ExtensionAPI): void {
	pi.registerCommand("forge:sprint-plan", {
		description:
			"Decompose sprint requirements into a planned task list via the Forge Architect persona. " +
			"Usage: /forge:sprint-plan <SPRINT_ID>. " +
			"Requires SPRINT_REQUIREMENTS.md (run /forge:sprint-intake first).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();
			await runSprintPlan(args, ctx, cwd);
		},
	});
}
