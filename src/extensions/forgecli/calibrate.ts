// calibrate.ts — /forge:calibrate orchestrator handler (FORGE-S23-T08).
//
// 4-phase flow matching calibrate.md:
//   Phase 1 — Structural-element readiness check (advisory, never blocks)
//   Phase 2 — Hash drift detection (deterministic). Auto-initializes baseline if absent.
//   Phase 3 — Architect patch proposal via runForgeSubagent
//   Phase 4 — Approval gate (ctx.ui.confirm) + patch application + calibration history write
//
// Non-interactive mode (FORGE_YES=1 or FORGE_NON_INTERACTIVE=1): auto-apply all patches.
//
// Iron Laws:
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL6  — no shell-string interpolation
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — LLM dispatch for patch-proposal phase goes through runForgeSubagent

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type CalibrationBaseline, computeCalibrationBaseline } from "./init-context.js";
import { loadForgePersona, runForgeSubagent, getFinalOutput } from "./forge-subagent.js";
import { getSubagentTools, type ForgeToolDefs } from "./forge-tools.js";
import { getBundledPayloadRoot } from "./forge-init.js";
import { isNonInteractive } from "./run-task.js";

// ── Bundled forge version ─────────────────────────────────────────────────

/**
 * Read the bundled forge version from .claude-plugin/plugin.json inside the
 * bundled payload root. Falls back to "0.0.0" on any error.
 * Mirrors the private getBundledForgeVersion() in forge-init.ts.
 */
function getBundledForgeVersion(): string {
	try {
		const pluginPath = path.join(getBundledPayloadRoot(), ".claude-plugin", "plugin.json");
		const raw = fs.readFileSync(pluginPath, "utf8");
		const plugin = JSON.parse(raw) as { version?: string };
		return typeof plugin.version === "string" ? plugin.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

// ── Flag parsing ──────────────────────────────────────────────────────────

export interface ParsedCalibrateFlags {
	/** Override project directory (from --path <dir>). Null = use cwd. */
	path: string | null;
}

/**
 * Parse /forge:calibrate arguments.
 * Supports: --path <dir>
 */
export function parseCalibrateFlags(args: string): ParsedCalibrateFlags {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let customPath: string | null = null;

	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--path" && i + 1 < parts.length) {
			customPath = parts[i + 1];
			i++;
		}
	}

	return { path: customPath };
}

// ── Config reading ────────────────────────────────────────────────────────

export interface ForgeConfig {
	paths?: { engineering?: string; forgeRoot?: string; store?: string };
	calibrationBaseline?: Partial<CalibrationBaseline> & { masterIndexHash?: string | null };
	calibrationHistory?: CalibrationHistoryEntry[];
	[key: string]: unknown;
}

/** Read and parse .forge/config.json from projectRoot. Returns null on any error. */
export function readForgeConfig(projectRoot: string): ForgeConfig | null {
	const cfgPath = path.join(projectRoot, ".forge", "config.json");
	try {
		const raw = fs.readFileSync(cfgPath, "utf8");
		return JSON.parse(raw) as ForgeConfig;
	} catch {
		return null;
	}
}

/** Write ForgeConfig to .forge/config.json. */
function writeForgeConfig(projectRoot: string, cfg: ForgeConfig): void {
	const cfgPath = path.join(projectRoot, ".forge", "config.json");
	fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// ── Hash computation ──────────────────────────────────────────────────────

/**
 * Compute SHA-256 of MASTER_INDEX.md, stripping blank lines and HTML comment lines.
 * Returns null if the file does not exist.
 */
export function computeCurrentHash(projectRoot: string, kbPath: string): string | null {
	const masterIndexPath = path.join(projectRoot, kbPath, "MASTER_INDEX.md");
	try {
		const content = fs.readFileSync(masterIndexPath, "utf8");
		const lines = content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("<!--"));
		return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
	} catch {
		return null;
	}
}

// ── Drift categorization ──────────────────────────────────────────────────

export interface DriftCategory {
	category: "technical" | "business" | "retrospective" | "acceptance criteria";
	evidence: string;
	targets: string[];
}

const SECTION_CATEGORY_MAP: Array<{
	keywords: string[];
	category: DriftCategory["category"];
	targets: string[];
}> = [
	{
		keywords: [
			"stack",
			"architecture",
			"routing",
			"database",
			"deployment",
			"processes",
			"schema",
			"checklist",
			"convention",
		],
		category: "technical",
		targets: ["personas:engineer", "skills:engineer-skills", "skills:supervisor-skills"],
	},
	{
		keywords: ["entity", "domain", "feature", "business", "model"],
		category: "business",
		targets: ["personas:all"],
	},
	{
		keywords: ["retrospective", "iron law", "lesson", "learning"],
		category: "retrospective",
		targets: ["personas:all"],
	},
	{
		keywords: ["acceptance", "criteria", "validation", "qa"],
		category: "acceptance criteria",
		targets: ["personas:product-manager", "skills:qa-engineer"],
	},
];

/**
 * Categorize drift by scanning MASTER_INDEX.md content for section keywords
 * and identifying new sprints since last calibration.
 */
export function categorizeDrift(
	projectRoot: string,
	kbPath: string,
	baseline: Partial<CalibrationBaseline> & { masterIndexHash?: string | null },
): DriftCategory[] {
	const found = new Map<DriftCategory["category"], DriftCategory>();

	// Read MASTER_INDEX.md for keyword-based section categorization
	const masterIndexPath = path.join(projectRoot, kbPath, "MASTER_INDEX.md");
	let masterIndexContent = "";
	try {
		masterIndexContent = fs.readFileSync(masterIndexPath, "utf8").toLowerCase();
	} catch {
		// If we cannot read it, report generic technical drift
		found.set("technical", {
			category: "technical",
			evidence: "MASTER_INDEX.md changed (content unreadable)",
			targets: ["personas:engineer", "skills:engineer-skills", "skills:supervisor-skills"],
		});
		return [...found.values()];
	}

	// Check each category's keywords against content
	for (const mapping of SECTION_CATEGORY_MAP) {
		const matched = mapping.keywords.filter((kw) => masterIndexContent.includes(kw));
		if (matched.length > 0) {
			if (!found.has(mapping.category)) {
				found.set(mapping.category, {
					category: mapping.category,
					evidence: `MASTER_INDEX.md contains ${mapping.category} content (keywords: ${matched.slice(0, 3).join(", ")})`,
					targets: [...mapping.targets],
				});
			}
		}
	}

	// Identify new sprints since last calibration
	const coveredIds = new Set(Array.isArray(baseline.sprintsCovered) ? baseline.sprintsCovered : []);
	const storeSprintsDir = path.join(projectRoot, ".forge", "store", "sprints");
	let newSprintCount = 0;
	try {
		const files = fs.readdirSync(storeSprintsDir).filter((f) => f.endsWith(".json"));
		for (const f of files) {
			try {
				const raw = fs.readFileSync(path.join(storeSprintsDir, f), "utf8");
				const sprint = JSON.parse(raw) as { sprintId?: string; status?: string };
				if (
					typeof sprint.sprintId === "string" &&
					(sprint.status === "done" || sprint.status === "retrospective-done") &&
					!coveredIds.has(sprint.sprintId)
				) {
					newSprintCount++;
				}
			} catch {
				// Skip malformed sprint file
			}
		}
	} catch {
		// Store not accessible
	}

	if (newSprintCount > 0) {
		if (!found.has("retrospective")) {
			found.set("retrospective", {
				category: "retrospective",
				evidence: `${newSprintCount} new completed sprint(s) since last calibration`,
				targets: ["personas:all"],
			});
		}
	}

	// If nothing found but hash changed, report generic technical drift
	if (found.size === 0) {
		found.set("technical", {
			category: "technical",
			evidence: "MASTER_INDEX.md hash changed — specific section changes not identified",
			targets: ["personas:engineer", "skills:engineer-skills", "skills:supervisor-skills"],
		});
	}

	return [...found.values()];
}

// ── Patch proposal prompt ─────────────────────────────────────────────────

export interface PatchProposal {
	target: string;
	type: "regenerate";
	rationale: string;
}

function buildPatchProposalPrompt(categories: DriftCategory[]): string {
	const lines = [
		"# Forge Calibration — Patch Proposal Request",
		"",
		"You are the Forge Architect. Drift has been detected in the project knowledge base.",
		"Review the drift categories below and propose surgical regeneration patches.",
		"",
		"## Drift Report",
		"",
	];

	for (let i = 0; i < categories.length; i++) {
		const cat = categories[i];
		lines.push(
			`### Category ${i + 1}: ${cat.category.charAt(0).toUpperCase() + cat.category.slice(1)}`,
			`Evidence: ${cat.evidence}`,
			`Suggested targets: ${cat.targets.join(", ")}`,
			"",
		);
	}

	lines.push(
		"## Instructions",
		"",
		"For each drift category, output a JSON block (one per patch) with this exact structure:",
		"",
		"```json",
		"{",
		'  "target": "<target string e.g. personas:engineer or skills:engineer-skills>",',
		'  "type": "regenerate",',
		'  "rationale": "<brief explanation of why this target needs regeneration>"',
		"}",
		"```",
		"",
		"Output one json block per proposed patch. Add prose analysis before or after the blocks.",
		"If a suggested target is redundant or not needed, omit it and explain why.",
		"",
		"Targets must be from this set:",
		"- personas:engineer",
		"- personas:product-manager",
		"- personas:all  (full persona rebuild)",
		"- skills:engineer-skills",
		"- skills:supervisor-skills",
		"- skills:qa-engineer",
		"- skills:all  (full skills rebuild)",
	);

	return lines.join("\n");
}

/** Extract PatchProposal objects from the architect's free-form response text. */
export function extractPatchProposals(text: string): PatchProposal[] {
	const proposals: PatchProposal[] = [];
	const blockRegex = /```json\s*([\s\S]+?)\s*```/g;
	let match: RegExpExecArray | null;

	while ((match = blockRegex.exec(text)) !== null) {
		try {
			const obj = JSON.parse(match[1]) as Partial<PatchProposal>;
			if (
				typeof obj.target === "string" &&
				obj.type === "regenerate" &&
				typeof obj.rationale === "string"
			) {
				proposals.push({ target: obj.target, type: "regenerate", rationale: obj.rationale });
			}
		} catch {
			// Skip malformed JSON blocks
		}
	}

	return proposals;
}

// ── Calibration history ───────────────────────────────────────────────────

export interface CalibrationHistoryPatch {
	target: string;
	type: "regenerate";
	applied: boolean;
}

export interface CalibrationHistoryEntry {
	date: string;
	version: string;
	categories: string[];
	patches: CalibrationHistoryPatch[];
}

// ── Structural readiness check ────────────────────────────────────────────

function runStructuralReadinessCheck(
	projectRoot: string,
	bundledVersion: string,
	ctx: ExtensionCommandContext,
): void {
	const versionsPath = path.join(projectRoot, ".forge", "structure-versions.json");
	try {
		const raw = fs.readFileSync(versionsPath, "utf8");
		const versionsData = JSON.parse(raw) as { basePackVersion?: string; currentSnapshot?: string };
		const { basePackVersion, currentSnapshot } = versionsData;

		if (basePackVersion === bundledVersion) {
			ctx.ui.notify(
				`○ Structural elements current — snapshot ${currentSnapshot ?? "?"} (plugin v${basePackVersion})`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`△ Structural element drift detected — installed elements were generated from plugin v${basePackVersion ?? "?"}; ` +
					`current plugin is v${bundledVersion}. Run /forge:update to refresh structural elements.`,
				"warning",
			);
		}
	} catch (err: unknown) {
		const e = err as { code?: string };
		if (e.code === "ENOENT") {
			ctx.ui.notify(
				`◇ structure-versions.json absent — project predates snapshot versioning. Run /forge:update to install the versioning system.`,
				"info",
			);
		}
		// Other errors: silently skip (advisory only)
	}
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerCalibrate(pi: ExtensionAPI, options: { forgeToolDefs?: ForgeToolDefs } = {}): void {
	const sendToAgent = (text: string) => pi.sendUserMessage(text, { deliverAs: "steer" });

	pi.registerCommand("forge:calibrate", {
		description:
			"Detect drift between the knowledge base and agent definitions, propose surgical regeneration patches, and apply approved patches.",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const rawCwd = process.cwd();
			const flags = parseCalibrateFlags(args);

			// Resolve projectRoot from --path flag or cwd
			let projectRoot = rawCwd;
			if (flags.path !== null) {
				projectRoot = path.isAbsolute(flags.path) ? flags.path : path.resolve(rawCwd, flags.path);
			}

			const bundleRoot = getBundledPayloadRoot();
			const bundledVersion = getBundledForgeVersion();

			// ── Step 0 — Structural-element readiness check (advisory) ──────────
			runStructuralReadinessCheck(projectRoot, bundledVersion, ctx);

			// ── Step 1 — Read config ─────────────────────────────────────────────
			const cfg = readForgeConfig(projectRoot);
			if (!cfg) {
				ctx.ui.notify(
					"△ No Forge instance found — run /forge:init to create one.",
					"error",
				);
				return;
			}

			const kbPath = cfg.paths?.engineering ?? "engineering";
			const forgeRoot = cfg.paths?.forgeRoot ?? bundleRoot;

			// ── Step 2 — Establish or verify calibration baseline ────────────────
			const baseline = cfg.calibrationBaseline as Partial<CalibrationBaseline> | undefined;

			if (!baseline || !baseline.masterIndexHash) {
				// Auto-initialize baseline
				ctx.ui.notify("○ No calibration baseline found — initializing...", "info");
				const newBaseline = computeCalibrationBaseline(projectRoot, kbPath, bundledVersion);

				cfg.calibrationBaseline = newBaseline;
				try {
					writeForgeConfig(projectRoot, cfg);
					ctx.ui.notify(
						`○ Baseline established — calibration baseline written to config ` +
							`(version: ${bundledVersion}, sprints covered: ${newBaseline.sprintsCovered.length})`,
						"info",
					);
				} catch (err: unknown) {
					const e = err as { message?: string };
					ctx.ui.notify(
						`× Failed to write calibration baseline: ${e.message ?? "unknown"}`,
						"error",
					);
				}
				return;
			}

			// ── Step 3 — Detect drift ────────────────────────────────────────────
			const currentHash = computeCurrentHash(projectRoot, kbPath);

			if (currentHash !== null && currentHash === baseline.masterIndexHash) {
				ctx.ui.notify(
					`○ KB calibrated — no drift since last calibration ` +
						`(last: ${baseline.lastCalibrated ?? "unknown"}, version: ${baseline.version ?? "unknown"})`,
					"info",
				);
				return;
			}

			ctx.ui.notify("△ Drift detected in MASTER_INDEX.md — analyzing...", "warning");

			// ── Step 4 — Categorize drift ────────────────────────────────────────
			const driftCategories = categorizeDrift(projectRoot, kbPath, baseline);

			if (driftCategories.length === 0) {
				ctx.ui.notify(
					"△ Drift detected in MASTER_INDEX.md but no specific category changes identified. " +
						"Run /forge:regenerate to do a full rebuild.",
					"warning",
				);
				return;
			}

			// ── Step 5 — Propose patches via architect subagent ──────────────────
			ctx.ui.setStatus?.("forge:calibrate", "Generating patch proposals...");

			let proposals: PatchProposal[] = [];

			try {
				const architectPersona = loadForgePersona("architect", projectRoot);
				const patchPrompt = buildPatchProposalPrompt(driftCategories);

				const result = await runForgeSubagent({
					persona: architectPersona,
					task: patchPrompt,
					cwd: projectRoot,
					forgeRoot,
					signal: ctx.signal,
					customTools: options.forgeToolDefs ? getSubagentTools(options.forgeToolDefs, architectPersona.name) : undefined,
				});

				if (result.exitCode !== 0) {
					ctx.ui.notify(
						`△ Architect subagent returned non-zero: ${result.errorMessage ?? "unknown error"}. ` +
							"Using drift categories directly as patch targets.",
						"warning",
					);
					proposals = driftCategories.flatMap((cat) =>
						cat.targets.map((t) => ({
							target: t,
							type: "regenerate" as const,
							rationale: cat.evidence,
						})),
					);
				} else {
					const proposalText = getFinalOutput(result.messages);
					proposals = extractPatchProposals(proposalText);

					if (proposals.length === 0) {
						ctx.ui.notify(
							"△ Patch proposal parsing yielded no structured patches — using drift categories as targets.",
							"warning",
						);
						proposals = driftCategories.flatMap((cat) =>
							cat.targets.map((t) => ({
								target: t,
								type: "regenerate" as const,
								rationale: cat.evidence,
							})),
						);
					}
				}
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(
					`△ Architect subagent failed: ${e.message ?? "unknown"}. Using drift categories as targets.`,
					"warning",
				);
				proposals = driftCategories.flatMap((cat) =>
					cat.targets.map((t) => ({
						target: t,
						type: "regenerate" as const,
						rationale: cat.evidence,
					})),
				);
			}

			ctx.ui.setStatus?.("forge:calibrate", undefined);

			// ── Step 6 — Approval gate ───────────────────────────────────────────
			const driftLines: string[] = [
				"",
				`## Calibration Drift Report`,
				"",
				`△ Drift detected — ${driftCategories.length} categories since last calibration ` +
					`(${baseline.lastCalibrated ?? "unknown"})`,
				"",
			];
			for (let i = 0; i < driftCategories.length; i++) {
				const cat = driftCategories[i];
				const catProposals = proposals.filter((p) => cat.targets.includes(p.target));
				driftLines.push(
					`### Category ${i + 1}: ${cat.category.charAt(0).toUpperCase() + cat.category.slice(1)}`,
					`  Evidence: ${cat.evidence}`,
					`  Proposed regeneration:`,
					...catProposals.map((p) => `    · ${p.target}`),
					"",
				);
			}
			ctx.ui.notify(driftLines.join("\n"), "info");

			const approvedPatches: Array<PatchProposal & { applied: boolean }> = [];
			const skippedPatches: PatchProposal[] = [];

			if (isNonInteractive()) {
				ctx.ui.notify(
					`○ Non-interactive mode — auto-applying all ${proposals.length} patch(es).`,
					"info",
				);
				for (const p of proposals) {
					approvedPatches.push({ ...p, applied: false });
				}
			} else {
				const proposalSummary = proposals
					.map((p, i) => `${i + 1}. ${p.target} — ${p.rationale}`)
					.join("\n");

				const applyAll = await ctx.ui.confirm(
					"Apply all calibration patches?",
					`${proposals.length} patch(es) proposed:\n\n${proposalSummary}\n\nYes = apply all | No = skip all`,
				);

				if (!applyAll) {
					ctx.ui.notify(
						"○ Calibration patches skipped — run /forge:calibrate again to apply.",
						"info",
					);
					skippedPatches.push(...proposals);
				} else {
					for (const p of proposals) {
						approvedPatches.push({ ...p, applied: false });
					}
				}
			}

			// ── Step 7 — Execute approved patches ────────────────────────────────
			for (const patch of approvedPatches) {
				ctx.ui.notify(`  → Regenerating ${patch.target}...`, "info");
				try {
					// Delegate to LLM via steer channel — waitForIdle() ensures regeneration
					// completes before we record history (F2 from plan review).
					sendToAgent(
						`Run /forge:regenerate for target: ${patch.target}\n\n` +
							`Regenerate the Forge knowledge base target: ${patch.target}\n` +
							`Project root: ${projectRoot}`,
					);
					await ctx.waitForIdle();
					patch.applied = true;
					ctx.ui.notify(`  ○ ${patch.target} regenerated.`, "info");
				} catch (err: unknown) {
					const e = err as { message?: string };
					ctx.ui.notify(
						`  △ Regeneration failed for ${patch.target}: ${e.message ?? "unknown"} — skipping.`,
						"warning",
					);
					patch.applied = false;
				}
			}

			// ── Step 8 — Update calibration state ────────────────────────────────
			const newHash = computeCurrentHash(projectRoot, kbPath);
			const newBaseline = computeCalibrationBaseline(projectRoot, kbPath, bundledVersion);
			if (newHash !== null) {
				newBaseline.masterIndexHash = newHash;
			}

			const historyPatches: CalibrationHistoryPatch[] = [
				...approvedPatches.map((p) => ({
					target: p.target,
					type: "regenerate" as const,
					applied: p.applied,
				})),
				...skippedPatches.map((p) => ({
					target: p.target,
					type: "regenerate" as const,
					applied: false,
				})),
			];

			const historyEntry: CalibrationHistoryEntry = {
				date: new Date().toISOString(),
				version: bundledVersion,
				categories: driftCategories.map((c) => c.category),
				patches: historyPatches,
			};

			cfg.calibrationBaseline = newBaseline;
			if (!Array.isArray(cfg.calibrationHistory)) {
				cfg.calibrationHistory = [];
			}
			cfg.calibrationHistory.push(historyEntry);

			try {
				writeForgeConfig(projectRoot, cfg);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(
					`△ Failed to update calibration state: ${e.message ?? "unknown"} — baseline may be stale.`,
					"warning",
				);
			}

			// ── Step 9 — Summary ─────────────────────────────────────────────────
			const appliedCount = approvedPatches.filter((p) => p.applied).length;
			const totalCount = approvedPatches.length + skippedPatches.length;
			const appliedTargets = approvedPatches
				.filter((p) => p.applied)
				.map((p) => p.target)
				.join(", ");

			const summaryLines = [
				"",
				"## ○ Calibration Complete",
				"",
				`  Patches applied: ${appliedCount} of ${totalCount}`,
				`  Regenerated: ${appliedTargets || "(none)"}`,
				`  Baseline updated: ${newBaseline.lastCalibrated}`,
				"",
				"── Run /forge:health to verify knowledge base currency.",
			];

			const failedPatches = approvedPatches.filter((p) => !p.applied);
			if (failedPatches.length > 0) {
				const failedTargets = failedPatches.map((p) => p.target).join(", ");
				summaryLines.push(
					"",
					`△ Failed patches: ${failedTargets}`,
					"── Re-run /forge:calibrate or manually /forge:regenerate the failed targets.",
				);
			}

			ctx.ui.notify(summaryLines.join("\n"), "info");
		},
	});
}
