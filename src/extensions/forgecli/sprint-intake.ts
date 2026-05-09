// forge:sprint-intake native TS handler — FORGE-S19-T01
//
// Full multi-turn TUI interview for sprint requirements capture.
// Adapts meta-sprint-intake.md 4-step algorithm to pi ctx.ui.* calls.
//
// Iron Laws:
//   - Iron Law 6: execFile with argv arrays — no shell-string interpolation
//   - Iron Law 7: silent continuation past failures is never acceptable
//
// Non-interactive mode: FORGE_NON_INTERACTIVE=1 or FORGE_YES=1 → abort with
// actionable error. Sprint intake is inherently interactive.
//
// Resumability: checkpoints to .forge/cache/sprint-intake-{SPRINT_ID}.json
// after each capture step. Re-run offers ctx.ui.confirm to resume or restart.
//
// Scripted E2E: FORGE_INTAKE_ANSWERS_FILE=<path> injects a JSON array of
// answer strings, consumed sequentially by ctx.ui.* calls (E2E-09).

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

// ── Non-interactive detection ─────────────────────────────────────────────

function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

// ── Scripted answers for E2E-09 ───────────────────────────────────────────

let _scriptedAnswers: string[] | null = null;
let _scriptedAnswerIdx = 0;

function loadScriptedAnswers(): void {
	// Always reset first so a prior call never leaks into a new session.
	_scriptedAnswers = null;
	_scriptedAnswerIdx = 0;
	const answersFile = process.env.FORGE_INTAKE_ANSWERS_FILE;
	if (!answersFile) return;
	try {
		const raw = fs.readFileSync(answersFile, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			_scriptedAnswers = parsed as string[];
		}
	} catch {
		// non-fatal — fall through to interactive mode
	}
}

function nextScriptedAnswer(): string | undefined {
	if (!_scriptedAnswers) return undefined;
	if (_scriptedAnswerIdx >= _scriptedAnswers.length) return undefined;
	return _scriptedAnswers[_scriptedAnswerIdx++];
}

// ── Tool invocation helper ────────────────────────────────────────────────

async function runTool(toolPath: string, argv: string[], cwd: string, timeout = 30000): Promise<string> {
	const result = await execFileAsync("node", [toolPath, ...argv], {
		cwd,
		timeout,
		encoding: "utf8",
	});
	return result.stdout ?? "";
}

// ── UI helpers (scripted-answers aware) ───────────────────────────────────

async function uiInput(
	ctx: ExtensionCommandContext,
	title: string,
	prompt: string,
): Promise<string | undefined> {
	const scripted = nextScriptedAnswer();
	if (scripted !== undefined) return scripted;
	if (!ctx.hasUI) return undefined;
	return await ctx.ui.input(title, prompt);
}

async function uiConfirm(
	ctx: ExtensionCommandContext,
	title: string,
	prompt: string,
): Promise<boolean | undefined> {
	const scripted = nextScriptedAnswer();
	if (scripted !== undefined) return scripted.toLowerCase() === "y" || scripted.toLowerCase() === "yes";
	if (!ctx.hasUI) return undefined;
	return await ctx.ui.confirm(title, prompt);
}

async function uiSelect(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
): Promise<string | undefined> {
	const scripted = nextScriptedAnswer();
	if (scripted !== undefined) {
		return options.includes(scripted) ? scripted : options[0];
	}
	if (!ctx.hasUI) return undefined;
	return await ctx.ui.select(title, options);
}

// ── Checkpoint schema ─────────────────────────────────────────────────────

interface GoalEntry {
	text: string;
	severity: string;
	acceptanceCriteria: string[];
}

interface RiskEntry {
	description: string;
	likelihood: string;
}

interface CarryOverEntry {
	text: string;
	confirmed: boolean;
}

interface IntakeCheckpoint {
	sprintId: string;
	capturedAt: string;
	phase: string;
	data: {
		title?: string;
		theme?: string;
		goals?: GoalEntry[];
		outOfScope?: string[];
		constraints?: string[];
		risks?: RiskEntry[];
		carryOver?: CarryOverEntry[];
	};
}

function checkpointPath(cwd: string, sprintId: string): string {
	return path.join(cwd, ".forge", "cache", `sprint-intake-${sprintId}.json`);
}

function readCheckpoint(cwd: string, sprintId: string): IntakeCheckpoint | null {
	const cpPath = checkpointPath(cwd, sprintId);
	if (!fs.existsSync(cpPath)) return null;
	try {
		const raw = fs.readFileSync(cpPath, "utf8");
		return JSON.parse(raw) as IntakeCheckpoint;
	} catch {
		return null;
	}
}

function writeCheckpoint(cwd: string, sprintId: string, checkpoint: IntakeCheckpoint): void {
	const cpPath = checkpointPath(cwd, sprintId);
	fs.mkdirSync(path.dirname(cpPath), { recursive: true });
	fs.writeFileSync(cpPath, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
}

function deleteCheckpoint(cwd: string, sprintId: string): void {
	const cpPath = checkpointPath(cwd, sprintId);
	try {
		fs.unlinkSync(cpPath);
	} catch {
		// non-fatal
	}
}

// ── Template rendering ────────────────────────────────────────────────────

function renderTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	let out = template;
	for (const [key, value] of Object.entries(vars)) {
		out = out.replaceAll(`{${key}}`, value);
	}
	return out;
}

// ── Previous sprint detection for carry-over ──────────────────────────────

function findPreviousSprintRetrospective(engineeringDir: string, currentSprintId: string): string | null {
	const sprintsDir = path.join(engineeringDir, "sprints");
	if (!fs.existsSync(sprintsDir)) return null;
	try {
		const dirs = fs.readdirSync(sprintsDir)
			.filter((d) => d !== currentSprintId)
			.sort()
			.reverse();
		for (const dir of dirs) {
			const retroPath = path.join(sprintsDir, dir, "SPRINT_RETROSPECTIVE.md");
			if (fs.existsSync(retroPath)) return retroPath;
		}
	} catch {
		// non-fatal
	}
	return null;
}

function parseCarryOverRecommendations(retroContent: string): string[] {
	const items: string[] = [];
	const lines = retroContent.split("\n");
	let inSection = false;
	for (const line of lines) {
		if (/##.*[Rr]ecommendations.*[Nn]ext.*[Ss]print/.test(line)) {
			inSection = true;
			continue;
		}
		if (inSection) {
			if (/^##/.test(line)) break; // next section
			const m = line.match(/^[-*]\s+(.+)$/);
			if (m?.[1]) items.push(m[1].trim());
		}
	}
	return items;
}

// ── Main handler ──────────────────────────────────────────────────────────

/**
 * Run the sprint intake interview.
 *
 * @param args   - Command arguments string (first token is the sprint ID)
 * @param ctx    - Pi ExtensionCommandContext
 * @param cwd    - Project working directory
 * @param toolsRoot - Absolute path to forge tools (store-cli.cjs lives here)
 */
async function runSprintIntake(
	args: string,
	ctx: ExtensionCommandContext,
	cwd: string,
	toolsRoot: string,
): Promise<void> {
	// ── Non-interactive guard ──────────────────────────────────────────────
	if (isNonInteractive()) {
		ctx.ui.notify(
			"× forge:sprint-intake requires an interactive terminal.\n" +
				"  Sprint intake is a multi-turn interview and cannot run unattended.\n" +
				"  Unset FORGE_NON_INTERACTIVE / FORGE_YES to run interactively.",
			"error",
		);
		return;
	}

	// ── Pre-flight ────────────────────────────────────────────────────────
	const forgeConfigPath = path.join(cwd, ".forge", "config.json");
	if (!fs.existsSync(forgeConfigPath)) {
		ctx.ui.notify(
			"× forge:sprint-intake — no .forge/config.json found at cwd.\n" +
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

	// ── Sprint ID from args ───────────────────────────────────────────────
	const sprintId = args.trim().split(/\s+/)[0] ?? "";
	if (!sprintId) {
		ctx.ui.notify(
			"× forge:sprint-intake — sprint ID required.\n" +
				"  Usage: /forge:sprint-intake <SPRINT_ID>   e.g. /forge:sprint-intake FORGE-S20",
			"error",
		);
		return;
	}

	// ── Load scripted answers if E2E mode ─────────────────────────────────
	loadScriptedAnswers();

	// ── Persona self-load ─────────────────────────────────────────────────
	const personaPath = path.join(cwd, ".forge", "personas", "product-manager.md");
	let personaIdentity = "📋 Product Manager — I capture what the sprint will deliver.";
	if (fs.existsSync(personaPath)) {
		try {
			const personaContent = fs.readFileSync(personaPath, "utf8");
			// Extract tagline from YAML frontmatter if present
			const taglineMatch = personaContent.match(/tagline:\s*["']?(.+?)["']?\s*$/m);
			const nameMatch = personaContent.match(/^#\s+(.+)$/m);
			if (taglineMatch?.[1]) {
				personaIdentity = `📋 ${nameMatch?.[1] ?? "Product Manager"} — ${taglineMatch[1]}`;
			}
		} catch {
			// non-fatal — use default identity
		}
	} else {
		ctx.ui.notify("△ forge:sprint-intake — .forge/personas/product-manager.md not found; continuing.", "warning");
	}
	ctx.ui.notify(personaIdentity, "info");
	ctx.ui.setStatus?.("forge:sprint-intake", `${sprintId} — interview`);

	// ── Context load ──────────────────────────────────────────────────────
	const masterIndexPath = path.join(cwd, engineeringDir, "MASTER_INDEX.md");
	const stackPath = path.join(cwd, engineeringDir, "architecture", "stack.md");
	const bugsDir = path.join(cwd, ".forge", "store", "bugs");
	const featuresDir = path.join(cwd, ".forge", "store", "features");

	let openBugCount = 0;
	let openFeatureCount = 0;

	if (fs.existsSync(bugsDir)) {
		try {
			openBugCount = fs
				.readdirSync(bugsDir)
				.filter((f) => f.endsWith(".json"))
				.filter((f) => {
					try {
						const d = JSON.parse(fs.readFileSync(path.join(bugsDir, f), "utf8")) as { status?: string };
						return d.status !== "fixed" && d.status !== "closed";
					} catch {
						return false;
					}
				}).length;
		} catch {
			// non-fatal
		}
	}

	if (fs.existsSync(featuresDir)) {
		try {
			openFeatureCount = fs
				.readdirSync(featuresDir)
				.filter((f) => f.endsWith(".json"))
				.filter((f) => {
					try {
						const d = JSON.parse(fs.readFileSync(path.join(featuresDir, f), "utf8")) as { status?: string };
						return d.status !== "done" && d.status !== "closed";
					} catch {
						return false;
					}
				}).length;
		} catch {
			// non-fatal
		}
	}

	const contextSummary =
		`Context loaded:` +
		(fs.existsSync(masterIndexPath) ? " ✓ MASTER_INDEX.md" : " ⚠ MASTER_INDEX.md missing") +
		(fs.existsSync(stackPath) ? " ✓ stack.md" : "") +
		` · ${openBugCount} open bugs · ${openFeatureCount} open features`;
	ctx.ui.notify(contextSummary, "info");

	// ── Resume check ──────────────────────────────────────────────────────
	const checkpoint = readCheckpoint(cwd, sprintId);
	let existingData: IntakeCheckpoint["data"] = {};
	if (checkpoint) {
		const savedAt = new Date(checkpoint.capturedAt).toLocaleString();
		const shouldResume = await uiConfirm(
			ctx,
			"Resume sprint intake?",
			`A previous intake session was found (saved ${savedAt}, phase: ${checkpoint.phase}).\nResume from checkpoint?`,
		);
		if (shouldResume === undefined) {
			ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
			ctx.ui.setStatus?.("forge:sprint-intake", undefined);
			return;
		}
		if (shouldResume) {
			existingData = checkpoint.data;
			ctx.ui.notify("〇 Resuming from checkpoint.", "info");
		} else {
			deleteCheckpoint(cwd, sprintId);
		}
	}

	// ── Multi-turn interview ──────────────────────────────────────────────

	// Step 1: Working title
	let title = existingData.title ?? "";
	if (!title) {
		const answer = await uiInput(ctx, "Sprint title", `Sprint ${sprintId} — working title (e.g. "Automated pipeline hardening"):`);
		if (answer === undefined) {
			ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
			ctx.ui.setStatus?.("forge:sprint-intake", undefined);
			return;
		}
		title = answer.trim() || sprintId;
		writeCheckpoint(cwd, sprintId, { sprintId, capturedAt: new Date().toISOString(), phase: "title", data: { ...existingData, title } });
	}

	// Step 2: Theme paragraph
	let theme = existingData.theme ?? "";
	if (!theme) {
		const answer = await uiInput(ctx, "Sprint theme", "Sprint theme (1-2 sentence narrative — what is this sprint fundamentally about?):");
		if (answer === undefined) {
			ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
			ctx.ui.setStatus?.("forge:sprint-intake", undefined);
			return;
		}
		theme = answer.trim();
		writeCheckpoint(cwd, sprintId, { sprintId, capturedAt: new Date().toISOString(), phase: "theme", data: { ...existingData, title, theme } });
	}

	// Step 3: Goals (loop until empty)
	const goals: GoalEntry[] = existingData.goals ?? [];
	const SEVERITY_OPTIONS = ["must-have", "nice-to-have", "out-of-scope"];
	let goalLoop = true;
	while (goalLoop) {
		const goalNum = goals.length + 1;
		const goalText = await uiInput(ctx, `Goal ${goalNum}`, `Goal ${goalNum} (press Enter with empty input to finish):`);
		if (goalText === undefined) {
			ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
			ctx.ui.setStatus?.("forge:sprint-intake", undefined);
			return;
		}
		if (!goalText.trim()) {
			goalLoop = false;
			break;
		}

		const severity = await uiSelect(ctx, `Goal ${goalNum} severity`, SEVERITY_OPTIONS);
		if (severity === undefined) {
			ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
			ctx.ui.setStatus?.("forge:sprint-intake", undefined);
			return;
		}

		// Acceptance criteria for this goal
		const acs: string[] = [];
		let acLoop = true;
		while (acLoop) {
			const acNum = acs.length + 1;
			const acText = await uiInput(ctx, `Goal ${goalNum} — AC ${acNum}`, `Acceptance criterion ${acNum} (empty to finish):`);
			if (acText === undefined) {
				ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
				ctx.ui.setStatus?.("forge:sprint-intake", undefined);
				return;
			}
			if (!acText.trim()) {
				acLoop = false;
			} else {
				acs.push(acText.trim());
			}
		}

		goals.push({ text: goalText.trim(), severity, acceptanceCriteria: acs });
		writeCheckpoint(cwd, sprintId, { sprintId, capturedAt: new Date().toISOString(), phase: "goals", data: { ...existingData, title, theme, goals } });
	}

	// Step 4: Out-of-scope
	const outOfScope: string[] = existingData.outOfScope ?? [];
	if (outOfScope.length === 0) {
		let oosLoop = true;
		while (oosLoop) {
			const item = await uiInput(ctx, "Out of scope", `Out-of-scope item ${outOfScope.length + 1} (empty to skip):`);
			if (item === undefined) {
				ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
				ctx.ui.setStatus?.("forge:sprint-intake", undefined);
				return;
			}
			if (!item.trim()) {
				oosLoop = false;
			} else {
				outOfScope.push(item.trim());
			}
		}
		writeCheckpoint(cwd, sprintId, { sprintId, capturedAt: new Date().toISOString(), phase: "out-of-scope", data: { ...existingData, title, theme, goals, outOfScope } });
	}

	// Step 5: Constraints
	const constraints: string[] = existingData.constraints ?? [];
	if (constraints.length === 0) {
		let consLoop = true;
		while (consLoop) {
			const item = await uiInput(ctx, "Constraints", `Constraint ${constraints.length + 1} (empty to skip):`);
			if (item === undefined) {
				ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
				ctx.ui.setStatus?.("forge:sprint-intake", undefined);
				return;
			}
			if (!item.trim()) {
				consLoop = false;
			} else {
				constraints.push(item.trim());
			}
		}
		writeCheckpoint(cwd, sprintId, { sprintId, capturedAt: new Date().toISOString(), phase: "constraints", data: { ...existingData, title, theme, goals, outOfScope, constraints } });
	}

	// Step 6: Risks
	const LIKELIHOOD_OPTIONS = ["High", "Medium", "Low"];
	const risks: RiskEntry[] = existingData.risks ?? [];
	if (risks.length === 0) {
		let riskLoop = true;
		while (riskLoop) {
			const riskText = await uiInput(ctx, "Risks", `Risk ${risks.length + 1} (empty to skip):`);
			if (riskText === undefined) {
				ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
				ctx.ui.setStatus?.("forge:sprint-intake", undefined);
				return;
			}
			if (!riskText.trim()) {
				riskLoop = false;
			} else {
				const likelihood = await uiSelect(ctx, `Risk ${risks.length + 1} likelihood`, LIKELIHOOD_OPTIONS);
				if (likelihood === undefined) {
					ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
					ctx.ui.setStatus?.("forge:sprint-intake", undefined);
					return;
				}
				risks.push({ description: riskText.trim(), likelihood });
			}
		}
		writeCheckpoint(cwd, sprintId, { sprintId, capturedAt: new Date().toISOString(), phase: "risks", data: { ...existingData, title, theme, goals, outOfScope, constraints, risks } });
	}

	// Step 7: Carry-over from previous sprint
	const carryOver: CarryOverEntry[] = existingData.carryOver ?? [];
	if (carryOver.length === 0) {
		const retroPath = findPreviousSprintRetrospective(path.join(cwd, engineeringDir), sprintId);
		if (retroPath) {
			try {
				const retroContent = fs.readFileSync(retroPath, "utf8");
				const recommendations = parseCarryOverRecommendations(retroContent);
				for (const rec of recommendations) {
					const confirmed = await uiConfirm(ctx, "Carry-over item", `Carry over from previous sprint?\n"${rec}"`);
					if (confirmed === undefined) {
						ctx.ui.notify("〇 forge:sprint-intake — cancelled.", "info");
						ctx.ui.setStatus?.("forge:sprint-intake", undefined);
						return;
					}
					carryOver.push({ text: rec, confirmed });
				}
			} catch {
				// non-fatal — skip carry-over
			}
		}
		writeCheckpoint(cwd, sprintId, { sprintId, capturedAt: new Date().toISOString(), phase: "carry-over", data: { title, theme, goals, outOfScope, constraints, risks, carryOver } });
	}

	// ── Template render → SPRINT_REQUIREMENTS.md ─────────────────────────
	ctx.ui.setStatus?.("forge:sprint-intake", `${sprintId} — writing requirements`);

	const templatePath = path.join(_PKG_ROOT, "dist", "forge-payload", ".base-pack", "templates", "SPRINT_REQUIREMENTS_TEMPLATE.md");
	let requirementsContent: string;
	if (fs.existsSync(templatePath)) {
		const template = fs.readFileSync(templatePath, "utf8");

		// Build must-have goals section
		const mustHaveGoals = goals.filter((g) => g.severity === "must-have");
		const niceGoals = goals.filter((g) => g.severity === "nice-to-have");

		const goalsLines: string[] = [];
		goals.forEach((g, i) => { goalsLines.push(`${i + 1}. ${g.text} [${g.severity}]`); });

		const inScopeLines: string[] = [];
		for (const g of [...mustHaveGoals, ...niceGoals]) {
			inScopeLines.push(`### ${g.text} [${g.severity}]`);
			inScopeLines.push("");
			if (g.acceptanceCriteria.length > 0) {
				inScopeLines.push("**Acceptance criteria:**");
				for (const ac of g.acceptanceCriteria) {
					inScopeLines.push(`- ${ac}`);
				}
				inScopeLines.push("");
			}
		}

		const outOfScopeLines = outOfScope.map((item) => `- ${item}`);
		const constraintLines = constraints.map((c) => `- ${c}`);
		const riskRows = risks.map((r) => `| ${r.description} | ${r.likelihood} | — |`);
		const carryOverRows = carryOver
			.filter((c) => c.confirmed)
			.map((c) => `| ${c.text} | Carry-over | Confirmed |`);

		requirementsContent = renderTemplate(template, {
			SPRINT_ID: sprintId,
			DATE: new Date().toISOString().slice(0, 10),
			PREV_SPRINT_ID: "previous sprint",
		});

		// Replace template placeholders with collected data
		requirementsContent = requirementsContent
			.replace(/^1\. \{Goal 1.*\}$/m, goalsLines.join("\n"))
			.replace(/^2\. \{Goal 2\}$/m, "")
			.replace(/### \{Feature\/Fix Title\} \[must-have\]\n\{One-line description\}\n\n\*\*Acceptance criteria:\*\*\n- \{Criterion 1\}\n- \{Criterion 2\}/m, inScopeLines.join("\n"))
			.replace(/^- \{Explicit exclusion 1\}\n- \{Explicit exclusion 2\}$/m, outOfScopeLines.join("\n") || "- (none)")
			.replace(/^- \{Item\}$/m, niceGoals.map((g) => `- ${g.text}`).join("\n") || "- (none)")
			.replace(/^- \*\*Plugin compatibility:\*\* \{must not break users on version X\.Y\+\}\n- \*\*Distribution:\*\* \{changes to .+\}\n- \*\*Dependencies:\*\* \{Node\.js built-ins only\}$/m, constraintLines.join("\n") || "- (none)")
			.replace(/\| \{Risk\} \| High \/ Medium \/ Low \| \{Mitigation\} \|/m, riskRows.join("\n") || "| (none) | — | — |")
			.replace(/\| \{Item\} \| Partial \/ Blocked \| \{Note\} \|/m, carryOverRows.join("\n") || "| (none) | — | — |");

		// Prepend theme paragraph after header
		requirementsContent = requirementsContent.replace(
			/^(---\n\n## Goals)/m,
			`## Theme\n\n${theme || "(not captured)"}\n\n---\n\n## Goals`,
		);
	} else {
		// Fallback: build from scratch
		const goalLines = goals.map((g, i) => `${i + 1}. ${g.text} [${g.severity}]`).join("\n");
		const acBlock = goals
			.map(
				(g) =>
					`### ${g.text}\n\n**Acceptance criteria:**\n${g.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n") || "- (none)"}`,
			)
			.join("\n\n");
		const ooBlock = outOfScope.map((i) => `- ${i}`).join("\n") || "- (none)";
		const consBlock = constraints.map((c) => `- ${c}`).join("\n") || "- (none)";
		const riskBlock = risks.map((r) => `| ${r.description} | ${r.likelihood} | — |`).join("\n") || "| (none) | — | — |";

		requirementsContent = `# Sprint Requirements — ${sprintId}

**Captured:** ${new Date().toISOString().slice(0, 10)}
**Source:** sprint-intake interview

---

## Theme

${theme || "(not captured)"}

---

## Goals

${goalLines || "(none)"}

## In Scope

${acBlock}

## Out of Scope

${ooBlock}

## Constraints

${consBlock}

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
${riskBlock}
`;
	}

	// Write SPRINT_REQUIREMENTS.md
	const sprintDir = path.join(cwd, engineeringDir, "sprints", sprintId);
	fs.mkdirSync(sprintDir, { recursive: true });
	const requirementsOutPath = path.join(sprintDir, "SPRINT_REQUIREMENTS.md");
	fs.writeFileSync(requirementsOutPath, requirementsContent, "utf8");
	ctx.ui.notify(`〇 SPRINT_REQUIREMENTS.md written to ${path.relative(cwd, requirementsOutPath)}`, "info");

	// ── Store write (sprint manifest) ─────────────────────────────────────
	ctx.ui.setStatus?.("forge:sprint-intake", `${sprintId} — writing sprint record`);

	const storeCli = path.join(
		_PKG_ROOT,
		"dist",
		"forge-payload",
		".tools",
		"store-cli.cjs",
	);

	// Derive project prefix from sprint ID (e.g. "FORGE" from "FORGE-S20")
	const prefixMatch = sprintId.match(/^([A-Z][A-Z0-9_-]*?)-S\d/);
	const projectPrefix = prefixMatch?.[1] ?? "FORGE";
	const sprintNum = sprintId.match(/-S(\d+)/)?.[1] ?? "0";

	const sprintRecord = {
		sprintId,
		title: title,
		status: "planning",
		prefix: projectPrefix,
		goal: theme || "(not captured)",
		sprintNumber: parseInt(sprintNum, 10),
		path: `${engineeringDir}/sprints/${sprintId}`,
	};

	if (fs.existsSync(storeCli)) {
		try {
			await runTool(storeCli, ["write", "sprint", JSON.stringify(sprintRecord)], cwd);
			ctx.ui.notify(`〇 Sprint record written via store-cli.`, "info");
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`△ store-cli write sprint failed: ${e.message ?? "unknown"} — continuing.`, "warning");
		}

		// Emit sprint-intake-complete event
		const eventRecord = {
			eventId: `${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}Z_${sprintId}_sprint_intake-complete`,
			sprintId,
			type: "sprint-intake-complete",
			timestamp: new Date().toISOString(),
		};
		try {
			await runTool(storeCli, ["emit", sprintId, JSON.stringify(eventRecord)], cwd);
			ctx.ui.notify(`〇 sprint-intake-complete event emitted.`, "info");
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`△ store-cli emit failed: ${e.message ?? "unknown"} — continuing.`, "warning");
		}
	} else {
		ctx.ui.notify("△ store-cli.cjs not found in bundled tools — sprint record not written.", "warning");
	}

	// ── Clean up checkpoint ───────────────────────────────────────────────
	deleteCheckpoint(cwd, sprintId);

	ctx.ui.setStatus?.("forge:sprint-intake", undefined);
	ctx.ui.notify(`〇 Sprint intake complete for ${sprintId}. Requirements captured in ${path.relative(cwd, requirementsOutPath)}`, "info");
}

// ── Public registration ───────────────────────────────────────────────────

/**
 * Register the /forge:sprint-intake command with the pi ExtensionAPI.
 *
 * Must be called BEFORE registerAllForgeCommands so the real handler
 * takes precedence over the auto-generated stub.
 *
 * @param pi - The pi ExtensionAPI instance.
 */
export function registerSprintIntake(pi: ExtensionAPI): void {
	pi.registerCommand("forge:sprint-intake", {
		description:
			"Capture sprint requirements via a structured multi-turn interview. " +
			"Usage: /forge:sprint-intake <SPRINT_ID>. " +
			"Non-interactive mode (FORGE_NON_INTERACTIVE=1) is refused — " +
			"sprint intake requires an interactive terminal.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();
			const forgeConfigPath = path.join(cwd, ".forge", "config.json");
			if (!fs.existsSync(forgeConfigPath) && !ctx.hasUI) {
				ctx.ui.notify("forge:sprint-intake — no Forge project at cwd; run /forge:init to bootstrap", "warning");
				return;
			}

			// Resolve tools root from config
			let toolsRoot = "";
			try {
				const cfg = JSON.parse(fs.readFileSync(forgeConfigPath, "utf8")) as {
					paths?: { forgeRoot?: string };
				};
				if (cfg.paths?.forgeRoot) {
					toolsRoot = path.join(cfg.paths.forgeRoot, "tools");
				}
			} catch {
				// non-fatal
			}

			await runSprintIntake(args, ctx, cwd, toolsRoot);
		},
	});
}
