// forge-init.ts — /forge:init command handler — FORGE-S17-T02
//
// Full 4-phase init flow:
//   Phase 1 — Collect: 5 parallel discovery scans → .forge/config.json
//   Phase 2 — Discover: 7 parallel KB doc generation + project-context.json
//   Phase 3 — Materialize: substitute-placeholders → .forge/{personas,skills,workflows,templates}
//   Phase 4 — Register: 11 deterministic steps → versioning, packs, store, Tomoshibi
//
// Per INIT_PARITY_SPEC.md and PLAN.md (rev 2) phases A–G.
//
// Iron Laws:
//   - Iron Law 1: no edits to forge/ or pi-mono/
//   - Iron Law 6: execFile with argv arrays — no shell-string interpolation
//   - Iron Law 7: silent continuation past failures is never acceptable
//
// Sub-decision bindings (from PLAN.md):
//   #1: Marketplace skills — advisory only; write installedSkills: []
//   #3: Parallel dispatch — vendored subagent via ctx.sendUserMessage instruction
//   #4: /forge:enhance — sentinel + advisory only; no sendUserMessage dispatch
//   #5: Tomoshibi — runRefreshKbLinks() native TS port; no shell-out
//   #9: Health check — runHealthCheck() direct call; NOT via sendUserMessage

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runHealthCheck } from "./health-check.js";
import {
	buildProjectContext,
	computeCalibrationBaseline,
	discoverProjectName,
	validateProjectContext,
	writeProjectContext,
} from "./init-context.js";
import { deleteInitProgress, readInitProgress, writeInitProgress } from "./init-progress.js";
import { getRefreshKbLinksHandler } from "./refresh-kb-links.js";

const execFileAsync = promisify(execFile);

// ── Bundle path resolution ─────────────────────────────────────────────────

const _EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
// dist/extensions/forgecli/ → dist/ → <pkg-root>/
const _DIST_DIR = path.resolve(_EXTENSION_DIR, "..", "..");
const _PKG_ROOT = path.resolve(_DIST_DIR, "..");

/** Get the bundled forge-payload root (dist/forge-payload/) */
export function getBundledPayloadRoot(): string {
	return path.join(_PKG_ROOT, "dist", "forge-payload");
}

/** Get the bundled tools directory (dist/forge-payload/tools/) */
export function getBundledToolsRoot(): string {
	return path.join(getBundledPayloadRoot(), "tools");
}

/**
 * Resolve the absolute path to dist/forge-payload/tools and validate it
 * contains store-cli.cjs. Throws if the directory is missing or incomplete.
 * Exported for test access and for Phase-4 pi-aware forgeRoot stamp.
 */
export function resolveBundleToolsRoot(): string {
	const toolsRoot = getBundledToolsRoot();
	const storeCli = path.join(toolsRoot, "store-cli.cjs");
	if (!fs.existsSync(storeCli)) {
		throw new Error(
			`resolveBundleToolsRoot: bundled tools dir missing store-cli.cjs — expected at ${storeCli}. ` +
				"Run 'npm run build' to populate dist/forge-payload/tools/.",
		);
	}
	return toolsRoot;
}

/**
 * Detect pi runtime. forge-init.ts is only ever called from the forgecli pi
 * extension (registerForgeInit is invoked during extension load by pi). There
 * is no Claude Code execution path. Therefore this always returns true.
 *
 * We keep the guard explicit rather than hardcoding `true` so that if a future
 * Claude Code path is added it is obvious where to insert the condition.
 *
 * Heuristic: PI_CODING_AGENT_DIR env set → definitely pi. Otherwise assume pi
 * (our only caller). Only false if explicitly opted-out via env flag in a
 * hypothetical future Claude Code integration.
 * Exported for test access.
 */
export function isPiRuntime(): boolean {
	// If the caller explicitly overrides via env, respect it (test escape hatch only).
	if (process.env.FORGE_INIT_CLAUDE_CODE_MODE === "1") return false;
	return true;
}

/** Get the bundled forge version from .claude-plugin/plugin.json */
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

// ── Session-scoped banner state ────────────────────────────────────────────

// Prevents re-rendering the hero banner on resume within the same session.
let heroBannerShown = false;

// ── Non-interactive mode ───────────────────────────────────────────────────

/**
 * Returns true when running in non-interactive / CI mode.
 *
 * Activated by either:
 *   - `FORGE_YES=1`          — ergonomic shell shorthand (FORGE-S18-T01)
 *   - `FORGE_NON_INTERACTIVE=1` — set by `forge --non-interactive` flag
 *
 * When active, every Y/N gate resolves to its documented default without
 * emitting a model-text prompt.
 */
function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

// ── Flag parsing ───────────────────────────────────────────────────────────

interface ParsedFlags {
	fast: boolean;
	full: boolean;
	startPhase: number | null; // 1-4 if specified, null otherwise
	conflict: boolean;
	invalidPhase: boolean;
}

function parseInitFlags(args: string): ParsedFlags {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const hasFast = parts.includes("--fast");
	const hasFull = parts.includes("--full");

	// Find trailing numeric phase arg
	let startPhase: number | null = null;
	let invalidPhase = false;

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--fast" || p === "--full") continue;
		const n = parseInt(p, 10);
		if (!Number.isNaN(n)) {
			if (n >= 1 && n <= 4) {
				startPhase = n;
			} else {
				invalidPhase = true;
			}
		}
	}

	return {
		fast: hasFast,
		full: hasFull,
		startPhase,
		conflict: hasFast && hasFull,
		invalidPhase,
	};
}

// ── Tool invocation helpers ────────────────────────────────────────────────

async function runTool(toolPath: string, argv: string[], cwd: string, timeout = 30000): Promise<void> {
	try {
		await execFileAsync("node", [toolPath, ...argv], {
			cwd,
			timeout,
			encoding: "utf8",
		});
	} catch (err: unknown) {
		const e = err as { stderr?: string; message?: string };
		throw new Error(`Tool ${path.basename(toolPath)} failed: ${e.stderr?.trim() || e.message || "unknown error"}`);
	}
}

async function runToolAdvisory(
	toolPath: string,
	argv: string[],
	cwd: string,
	ctx: ExtensionCommandContext,
	label: string,
	timeout = 30000,
): Promise<boolean> {
	try {
		await runTool(toolPath, argv, cwd, timeout);
		return true;
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(`△ ${label}: ${e.message ?? "failed"} — proceeding.`, "warning");
		return false;
	}
}

// ── Per-phase verification ────────────────────────────────────────────────────

interface VerifyResult {
	ok: boolean;
	missing: string[];
	reason?: string;
}

function verifyPhase1(cwd: string): VerifyResult {
	const configPath = path.join(cwd, ".forge", "config.json");
	if (!fs.existsSync(configPath)) {
		return { ok: false, missing: [".forge/config.json"], reason: "config file not written" };
	}
	let cfg: Record<string, unknown>;
	try {
		cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch (err: unknown) {
		const e = err as { message?: string };
		return { ok: false, missing: [".forge/config.json"], reason: `JSON parse failed: ${e.message ?? "?"}` };
	}
	const missing: string[] = [];
	if (!cfg.version) missing.push("version");
	const proj = cfg.project as Record<string, unknown> | undefined;
	if (!proj?.name) missing.push("project.name");
	if (!proj?.prefix) missing.push("project.prefix");
	if (!cfg.stack) missing.push("stack");
	if (!cfg.commands) missing.push("commands");
	const paths = cfg.paths as Record<string, unknown> | undefined;
	if (!paths?.engineering) missing.push("paths.engineering");
	if (!paths?.store) missing.push("paths.store");
	if (!paths?.workflows) missing.push("paths.workflows");
	return { ok: missing.length === 0, missing };
}

function verifyPhase2(cwd: string, kbPath: string): VerifyResult {
	const archDocs = ["stack", "processes", "database", "routing", "deployment", "entity-model", "stack-checklist"];
	const missing: string[] = [];
	for (const d of archDocs) {
		if (!fs.existsSync(path.join(cwd, kbPath, "architecture", `${d}.md`))) {
			missing.push(`${kbPath}/architecture/${d}.md`);
		}
	}
	return { ok: missing.length === 0, missing };
}

function verifyPhase3(cwd: string): VerifyResult {
	const dirs = ["workflows", "personas", "skills", "templates"];
	const missing: string[] = [];
	for (const d of dirs) {
		const dir = path.join(cwd, ".forge", d);
		let count = 0;
		try {
			count = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".json")).length;
		} catch {
			count = 0;
		}
		if (count === 0) missing.push(`.forge/${d}/ (empty)`);
	}
	return { ok: missing.length === 0, missing };
}

// ── Discovery prompt text ──────────────────────────────────────────────────

function buildPhase1PromptText(bundleRoot: string, projectName: string): string {
	const discoveryDir = path.join(bundleRoot, ".init", "discovery");
	const topics = ["stack", "processes", "database", "routing", "testing"];
	const topicLines = topics.map((t) => `  • ${path.join(discoveryDir, `discover-${t}.md`)}`).join("\n");

	return `## /forge:init Phase 1 — Collect: 5 parallel discovery scans

Project: ${projectName}

Run 5 discovery scans concurrently. In a single response, issue 5 parallel tool
calls — one per discovery topic — using whatever read/search tools you have
available (Read, Glob, Grep, Bash). If a \`subagent\` tool is exposed in your
toolset, you MAY dispatch via it (mode: "parallel"); otherwise execute the
scans inline. Do NOT preface with "I don't have a subagent tool" — either path
is acceptable, what matters is concurrency and the resulting deliverable.

For each topic:
1. Read the discovery prompt file at its assigned path (shown below)
2. Analyze the current project codebase
3. Capture structured findings

Discovery prompt files:
${topicLines}

After all 5 complete, synthesize the findings into a unified config and write .forge/config.json.

Required .forge/config.json structure:
{
  "version": "1",
  "project": { "name": "${projectName}", "prefix": "<UPPERCASE_ABBREV>" },
  "stack": { "primary": [...], "test": <framework>, "build": <tool>, "lint": <tool> },
  "commands": { "test": "<test cmd>", "build": "<build cmd>", "lint": "<lint cmd>" },
  "paths": {
    "engineering": "engineering",
    "store": ".forge/store",
    "workflows": ".forge/workflows",
    "commands": ".claude/commands/forge",
    "templates": ".forge/templates"
  }
}

Write the config with: node "${path.join(bundleRoot, "tools/manage-config.cjs")}" set <key> <value>
Or write .forge/config.json directly as valid JSON.`;
}

function buildPhase2PromptText(bundleRoot: string, kbPath: string, projectName: string): string {
	const generateKbDocPath = path.join(bundleRoot, ".init", "generation", "generate-kb-doc.md");
	const docs = ["stack", "processes", "database", "routing", "deployment", "entity-model", "stack-checklist"];
	const docLines = docs.map((d) => `  • ${kbPath}/architecture/${d}.md`).join("\n");

	return `## /forge:init Phase 2 — Discover: 7 parallel KB doc generation

Project: ${projectName}
KB path: ${kbPath}/
Rulebook: ${generateKbDocPath}

Generate 7 knowledge-base documents concurrently. In a single response, issue
7 parallel tool calls — one per document — using whatever read/search/write
tools you have available (Read, Glob, Grep, Bash, Write). If a \`subagent\`
tool is exposed in your toolset, you MAY dispatch via it (mode: "parallel");
otherwise execute the generation inline. Do NOT preface with "I don't have a
subagent tool" — either path is acceptable, what matters is concurrency and
the 7 output files.

For each document:
1. Read the rulebook at: ${generateKbDocPath}
2. Analyze the project codebase for its assigned topic
3. Write the resulting document to its assigned output file

Documents to generate:
${docLines}

After all complete, check for any that returned "FAILED:" in their output — retry those once.

Also create these index files after generation:
- ${kbPath}/architecture/INDEX.md
- ${kbPath}/business-domain/INDEX.md
- ${kbPath}/MASTER_INDEX.md (scaffold)`;
}

// ── Phase 4 helper — .gitignore update ────────────────────────────────────

function updateGitignore(cwd: string, ctx: ExtensionCommandContext): void {
	const gitignorePath = path.join(cwd, ".gitignore");
	if (!fs.existsSync(gitignorePath)) {
		// No gitignore — skip
		return;
	}

	let content: string;
	try {
		content = fs.readFileSync(gitignorePath, "utf8");
	} catch {
		return;
	}

	const IGNORE_PATTERNS = [".forge/store/events/", ".forge/store/events", ".forge/store/", ".forge/"];
	const lines = content.split("\n");
	const alreadyIgnored = lines.some((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return false;
		return IGNORE_PATTERNS.some((pat) => trimmed.includes(pat));
	});

	if (alreadyIgnored) {
		ctx.ui.notify("〇 .forge/store/events/ already gitignored — skipped.", "info");
		return;
	}

	const toAppend =
		"\n# Forge — transient agent event logs (one file per phase, do not commit)\n.forge/store/events/\n";
	try {
		fs.appendFileSync(gitignorePath, toAppend, "utf8");
		ctx.ui.notify("〇 Appended .forge/store/events/ to .gitignore.", "info");
	} catch {
		ctx.ui.notify("△ Could not update .gitignore — update manually.", "warning");
	}
}

// ── Phase 4 helper — agent instruction file linking ────────────────────────

async function linkAgentInstructionFile(
	cwd: string,
	kbPath: string,
	projectName: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".cursorrules"];
	const existing = INSTRUCTION_FILES.filter((f) => fs.existsSync(path.join(cwd, f)));

	if (existing.length > 0) {
		// Already exists — do NOT modify (per spec step 4-11: avoid KB-link bloat)
		return;
	}

	// None exist — prompt to create minimal CLAUDE.md (G4: bypassed in non-interactive mode)
	const ok = isNonInteractive()
		? true
		: await ctx.ui.confirm(
				"Create CLAUDE.md?",
				`No agent instruction file found at project root.\nCreate a minimal CLAUDE.md with links to the Forge knowledge base? [Y/n]`,
			);

	if (!ok) {
		ctx.ui.notify("〇 KB not linked — run /forge:refresh-kb-links after creating CLAUDE.md.", "info");
		return;
	}

	const claudeMdPath = path.join(cwd, "CLAUDE.md");
	const content = [
		`# ${projectName}`,
		``,
		`## Forge Knowledge Base`,
		``,
		`| Index | Contents |`,
		`|-------|----------|`,
		`| [MASTER_INDEX](${kbPath}/MASTER_INDEX.md) | All sprints, tasks, bugs, and features |`,
		`| [Architecture](${kbPath}/architecture/INDEX.md) | Stack, processes, database, routing, deployment |`,
		`| [Business Domain](${kbPath}/business-domain/INDEX.md) | Entity model and domain concepts |`,
		``,
		`## Forge Workflows`,
		``,
		`| Workflow | Purpose |`,
		`|----------|---------|`,
		`| /forge:plan | Research codebase, produce implementation plan |`,
		`| /forge:implement | Execute approved plan, make code changes |`,
		`| /forge:validate | Validate task implementation against acceptance criteria |`,
		`| /forge:approve | Final architect approval gate |`,
		`| /forge:commit | Stage and commit completed task artifacts |`,
		`| /forge:fix-bug | Triage, diagnose, and fix a bug |`,
		`| /forge:run-task | Full plan-implement-review-commit pipeline |`,
		`| /forge:run-sprint | Execute all tasks in a sprint |`,
		`| /forge:sprint-plan | Decompose sprint requirements into tasks |`,
		`| /forge:sprint-intake | Elicit and structure requirements for a new sprint |`,
		``,
		`---`,
		`_Generated by /forge:init. Run /forge:refresh-kb-links to update._`,
		``,
	].join("\n");

	try {
		fs.writeFileSync(claudeMdPath, content, "utf8");
		ctx.ui.notify("〇 Created CLAUDE.md with KB links.", "info");
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(`△ Could not create CLAUDE.md: ${e.message ?? "unknown"}`, "warning");
	}
}

// ── Main command registration ──────────────────────────────────────────────

export function registerForgeInit(pi: ExtensionAPI): void {
	// Capture pi.sendUserMessage in closure — ExtensionCommandContext does not
	// have sendUserMessage; it is on ExtensionAPI per pi types.ts:1187.
	//
	// FIX BUG-017 / BUG-023: all sendUserMessage calls during a command handler
	// execution (which is itself an active agent turn) MUST carry deliverAs: "steer"
	// to avoid the "Agent is already processing" runtime error. The command handler
	// runs inside a turn boundary; raw sendUserMessage() without deliverAs throws.
	const sendToAgent = (text: string) => pi.sendUserMessage(text, { deliverAs: "steer" });

	pi.registerCommand("forge:init", {
		description: "Bootstrap a new Forge SDLC project at the current working directory",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const cwd = process.cwd();
			const bundleRoot = getBundledPayloadRoot();
			const toolsRoot = getBundledToolsRoot();
			const bundledVersion = getBundledForgeVersion();

			// kbPathFinal is resolved in Phase 4 but used in post-phase report.
			// Declare at handler scope so post-phase code can read it.
			let kbPathFinal = "engineering";

			// ── 1. Flag parsing ────────────────────────────────────────────────
			const flags = parseInitFlags(args);

			if (flags.conflict) {
				ctx.ui.notify("× Conflicting flags: --fast and --full cannot be combined.", "error");
				return;
			}

			// ── 2. Resume detection ────────────────────────────────────────────
			const progressResult = readInitProgress(cwd);
			let startPhase = flags.startPhase ?? 1;

			if (progressResult.kind === "malformed") {
				ctx.ui.notify("△ init-progress.json is malformed — deleting and starting fresh.", "warning");
				deleteInitProgress(cwd);
			} else if (progressResult.kind === "stale") {
				// Silently delete stale checkpoint and proceed fresh
				deleteInitProgress(cwd);
			} else if (progressResult.kind === "valid") {
				const lastPhase = progressResult.progress.lastPhase;
				const nextPhase = Math.min(lastPhase + 1, 4);
				const resumeBanner =
					`〇 Previous init detected — last completed phase: ${lastPhase} of 4\n` +
					`Resume from Phase ${nextPhase}?`;

				// G1: in non-interactive mode, default to not resuming (start fresh)
				const shouldResume = isNonInteractive()
					? false
					: await ctx.ui.confirm("Resume /forge:init?", resumeBanner);
				if (shouldResume) {
					startPhase = nextPhase;
					// Skip hero banner on resume (session-scoped gate)
					heroBannerShown = true;
				} else {
					deleteInitProgress(cwd);
					startPhase = 1;
				}
			}

			// Override startPhase from flags if --fast/--full N or direct phase arg
			if (flags.startPhase !== null) {
				startPhase = flags.startPhase;
			}
			if (flags.invalidPhase) {
				// Invalid phase specified — re-prompt via pre-flight (fall through to pre-flight)
				startPhase = 1;
			}

			// ── 3. Hero banner (once per session) ────────────────────────────
			if (!heroBannerShown) {
				heroBannerShown = true;
				const bannersTool = path.join(toolsRoot, "banners.cjs");
				if (fs.existsSync(bannersTool)) {
					await execFileAsync("node", [bannersTool, "forge"], {
						cwd,
						timeout: 5000,
					}).catch(() => {
						/* non-fatal */
					});
					await execFileAsync(
						"node",
						[bannersTool, "--subtitle", `AI SDLC bootstrapper · forge:init v${bundledVersion}`],
						{ cwd, timeout: 5000 },
					).catch(() => {
						/* non-fatal */
					});
				}
			}

			// ── 4. Flag acknowledgement (--fast or --full, no phase jump) ────
			if ((flags.fast || flags.full) && flags.startPhase === null) {
				const mode = flags.fast ? "--fast" : "--full";
				ctx.ui.notify(`〇 ${mode} — running all 4 phases sequentially (functionally equivalent).`, "info");
			}

			// ── 5. Pre-flight plan (unless jumping to a specific phase) ───────
			const projectName = discoverProjectName(cwd);
			if (flags.startPhase === null || flags.invalidPhase) {
				const preflightSummary =
					`Forge Init — ${projectName}\n\n` +
					`4 phases will run in this session (~45 seconds non-interactive):\n\n` +
					`  1   Collect      — 5 parallel discovery scans → config.json\n` +
					`                     KB folder prompt (interactive)\n` +
					`  2   Discover     — KB doc generation (LLM fan-out) + project-context.json\n` +
					`  3   Materialize  — substitute-placeholders.cjs → fully functional workflows\n` +
					`  4   Register     — versioning, manifest, cache, store entries, Tomoshibi\n\n` +
					`Phase 1 is interactive (KB folder name prompt). Phases 2–4 are non-interactive\n` +
					`and complete in under 45 seconds.`;

				// G2: skip pre-flight confirm in non-interactive mode (proceed directly to Phase 1)
				if (!isNonInteractive()) {
					const proceed = await ctx.ui.confirm("Start /forge:init?", preflightSummary);
					if (!proceed) {
						ctx.ui.notify("〇 /forge:init cancelled.", "info");
						return;
					}
				}
			}

			// ── Phase 1 — Collect ─────────────────────────────────────────────
			if (startPhase <= 1) {
				ctx.ui.setStatus?.("forge:init", "Phase 1/4: Collect");
				const bannersTool = path.join(toolsRoot, "banners.cjs");
				if (fs.existsSync(bannersTool)) {
					await execFileAsync("node", [bannersTool, "--phase", "1", "4", "Collect", "north"], {
						cwd,
						timeout: 5000,
					}).catch(() => {
						/* non-fatal */
					});
				}

				ctx.ui.notify("Running 5 discovery scans in parallel...", "info");

				// Dispatch 5 discovery subagents via sendUserMessage instruction.
				// If the agent doesn't have a `subagent` tool, it must fall back to
				// running the 5 scans inline — Phase 1's deliverable is non-negotiable.
				const phase1Prompt = buildPhase1PromptText(bundleRoot, projectName);
				sendToAgent(phase1Prompt);
				await ctx.waitForIdle();

				// Verify deliverable. If missing, retry once with a corrective steer;
				// if still missing, prompt the user to abort or continue with partial.
				let phase1 = verifyPhase1(cwd);
				if (!phase1.ok) {
					ctx.ui.notify(
						`△ Phase 1 deliverable missing: ${phase1.missing.join(", ")} — retrying with corrective steer.`,
						"warning",
					);
					sendToAgent(
						`Phase 1 verification failed. .forge/config.json is missing the following required fields: ${phase1.missing.join(", ")}.\n\n` +
							`Write a complete .forge/config.json now using the \`write\` tool. Do NOT call subagents — analyze the project codebase yourself if needed. ` +
							`Use the schema from the original Phase 1 prompt: version, project.{name,prefix}, stack, commands, and paths.{engineering,store,workflows,commands,templates} are all required.`,
					);
					await ctx.waitForIdle();
					phase1 = verifyPhase1(cwd);
				}
				if (!phase1.ok) {
					if (isNonInteractive()) {
						ctx.ui.notify(
							`× Phase 1 failed: ${phase1.missing.join(", ")}. Aborting init in non-interactive mode.`,
							"error",
						);
						return;
					}
					const proceed = await ctx.ui.confirm(
						"Phase 1 failed twice — continue with partial init?",
						`.forge/config.json is still missing: ${phase1.missing.join(", ")}.\n\n` +
							`Yes = continue (you'll need to /forge:regenerate later).\n` +
							`No  = abort. Inspect the file manually and re-run /forge:init.`,
					);
					if (!proceed) {
						ctx.ui.notify("× /forge:init aborted at Phase 1 verify.", "error");
						return;
					}
					ctx.ui.notify("△ Continuing with partial Phase 1 — downstream phases may fail.", "warning");
				}

				// KB folder prompt (spec §7, F2) — G3: skipped in non-interactive mode (default: "engineering")
				// Phrasing chosen so the default-Yes affirmative ("use engineering/") is the
				// safe path. Pi's ctx.ui.confirm has no defaultValue option, so the question
				// has to align with the highlighted default — earlier "does this conflict?"
				// phrasing made the unsafe answer the default.
				if (!isNonInteractive()) {
					const kbDescription =
						`Forge will create a folder for architecture docs, sprints, bugs, and features.\n\n` +
						`Use "engineering" as the folder name?  (Pick No only if your project already has an "engineering/" folder you don't want Forge to touch.)`;
					const useDefault = await ctx.ui.confirm("Engineering folder name?", kbDescription);
					if (!useDefault) {
						const customName = await ctx.ui.input(
							"Engineering folder name? Enter preferred folder name",
							"e.g. ai-docs, .forge-kb, docs/ai",
						);
						if (customName && customName.trim()) {
							const manageConfigToolEarly = path.join(toolsRoot, "manage-config.cjs");
							if (fs.existsSync(manageConfigToolEarly)) {
								await runToolAdvisory(
									manageConfigToolEarly,
									["set", "paths.engineering", customName.trim()],
									cwd,
									ctx,
									"manage-config paths.engineering",
								);
							}
						}
					}
				}

				// Marketplace skills advisory (sub-decision #1)
				ctx.ui.notify(
					"〇 Marketplace skills auto-recommendation is Claude-Code-only. " +
						"Pi users install extensions manually. Writing installedSkills: []",
					"info",
				);

				// Write installedSkills: []
				const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
				if (fs.existsSync(manageConfigTool)) {
					await runToolAdvisory(
						manageConfigTool,
						["set", "installedSkills", "[]"],
						cwd,
						ctx,
						"manage-config installedSkills",
					);
					// Write mode = "full"
					await runToolAdvisory(manageConfigTool, ["set", "mode", "full"], cwd, ctx, "manage-config mode");
				}

				writeInitProgress(cwd, 1);
				ctx.ui.notify("〇 Phase 1 complete.", "info");
			}

			// ── Phase 2 — Discover ────────────────────────────────────────────
			if (startPhase <= 2) {
				ctx.ui.setStatus?.("forge:init", "Phase 2/4: Discover");
				const bannersTool = path.join(toolsRoot, "banners.cjs");
				if (fs.existsSync(bannersTool)) {
					await execFileAsync("node", [bannersTool, "--phase", "2", "4", "Discover", "oracle"], {
						cwd,
						timeout: 5000,
					}).catch(() => {
						/* non-fatal */
					});
				}

				// Read KB_PATH from config
				let kbPath = "engineering";
				try {
					const configRaw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
					const config = JSON.parse(configRaw) as Record<string, unknown>;
					const paths = config.paths as Record<string, unknown> | undefined;
					if (paths && typeof paths.engineering === "string" && paths.engineering) {
						kbPath = paths.engineering;
					}
				} catch {
					// Use default
				}

				// Directory scaffolding
				const dirs = [
					path.join(cwd, kbPath),
					path.join(cwd, kbPath, "architecture"),
					path.join(cwd, kbPath, "business-domain"),
					path.join(cwd, kbPath, "sprints"),
					path.join(cwd, ".forge", "store"),
					path.join(cwd, ".forge", "cache"),
				];
				for (const dir of dirs) {
					try {
						fs.mkdirSync(dir, { recursive: true });
						// Write .gitkeep for empty dirs
						const keepPath = path.join(dir, ".gitkeep");
						if (!fs.existsSync(keepPath)) {
							fs.writeFileSync(keepPath, "", "utf8");
						}
					} catch {
						// Non-fatal
					}
				}

				// Dispatch 7 parallel KB doc subagents
				const phase2Prompt = buildPhase2PromptText(bundleRoot, kbPath, projectName);
				sendToAgent(phase2Prompt);
				await ctx.waitForIdle();

				// Verify Phase 2 deliverables.
				let phase2 = verifyPhase2(cwd, kbPath);
				if (!phase2.ok) {
					ctx.ui.notify(
						`△ Phase 2 deliverable incomplete: ${phase2.missing.length} doc(s) missing — retrying.`,
						"warning",
					);
					sendToAgent(
						`Phase 2 verification failed. The following architecture docs are missing:\n${phase2.missing.map((m) => `  - ${m}`).join("\n")}\n\n` +
							`Write the missing files now using the \`write\` tool. Do NOT call subagents — analyze the project codebase yourself. ` +
							`Use the rulebook at ${path.join(bundleRoot, ".init", "generation", "generate-kb-doc.md")} for the per-doc shape and confidence-header format.`,
					);
					await ctx.waitForIdle();
					phase2 = verifyPhase2(cwd, kbPath);
				}
				if (!phase2.ok) {
					if (isNonInteractive()) {
						ctx.ui.notify(
							`× Phase 2 failed: ${phase2.missing.length} doc(s) still missing. Aborting init in non-interactive mode.`,
							"error",
						);
						return;
					}
					const proceed = await ctx.ui.confirm(
						"Phase 2 failed twice — continue with partial init?",
						`Missing docs:\n${phase2.missing.map((m) => `  - ${m}`).join("\n")}\n\n` +
							`Yes = continue (you'll need to fill these manually).\n` +
							`No  = abort. Inspect the project and re-run /forge:init.`,
					);
					if (!proceed) {
						ctx.ui.notify("× /forge:init aborted at Phase 2 verify.", "error");
						return;
					}
					ctx.ui.notify("△ Continuing with partial Phase 2.", "warning");
				}

				// Construct project-context.json
				let kbPathResolved = kbPath;
				let prefix = "";
				try {
					const configRaw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
					const config = JSON.parse(configRaw) as Record<string, unknown>;
					const proj = config.project as Record<string, unknown> | undefined;
					if (proj && typeof proj.prefix === "string") prefix = proj.prefix;
					const paths = config.paths as Record<string, unknown> | undefined;
					if (paths && typeof paths.engineering === "string") kbPathResolved = paths.engineering;
				} catch {
					// Use defaults
				}

				// Read config for full project context construction
				let configForContext: Record<string, unknown> = {};
				try {
					const raw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
					configForContext = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					// empty config
				}

				const projectCtx = buildProjectContext(
					{
						projectName: ((configForContext.project as Record<string, unknown>)?.name as string) ?? projectName,
						prefix,
						kbPath: kbPathResolved,
					},
					configForContext as {
						project?: { name?: string; prefix?: string };
						paths?: { engineering?: string; forgeRoot?: string };
					},
				);

				try {
					validateProjectContext(projectCtx);
					writeProjectContext(cwd, projectCtx);
					ctx.ui.notify("〇 project-context.json written.", "info");
				} catch (err: unknown) {
					const e = err as { message?: string };
					ctx.ui.notify(
						`△ project-context.json validation failed: ${e.message ?? "unknown"} — proceeding.`,
						"warning",
					);
				}

				// Calibration baseline
				const baseline = computeCalibrationBaseline(cwd, kbPathResolved, bundledVersion);
				const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
				if (fs.existsSync(manageConfigTool)) {
					await runToolAdvisory(
						manageConfigTool,
						["set", "calibrationBaseline", JSON.stringify(baseline)],
						cwd,
						ctx,
						"manage-config calibrationBaseline",
					);
				}

				writeInitProgress(cwd, 2);
				ctx.ui.notify("〇 Phase 2 complete.", "info");
			}

			// ── Phase 3 — Materialize ─────────────────────────────────────────
			if (startPhase <= 3) {
				ctx.ui.setStatus?.("forge:init", "Phase 3/4: Materialize");
				const bannersTool = path.join(toolsRoot, "banners.cjs");
				if (fs.existsSync(bannersTool)) {
					await execFileAsync("node", [bannersTool, "--phase", "3", "4", "Materialize", "supervisor"], {
						cwd,
						timeout: 5000,
					}).catch(() => {
						/* non-fatal */
					});
				}

				const buildInitContextTool = path.join(toolsRoot, "build-init-context.cjs");
				const substituteTool = path.join(toolsRoot, "substitute-placeholders.cjs");
				const buildOverlayTool = path.join(toolsRoot, "build-overlay.cjs");
				const basePackDir = path.join(bundleRoot, ".base-pack");

				// 3a: build-init-context.cjs first build
				if (fs.existsSync(buildInitContextTool)) {
					await runToolAdvisory(
						buildInitContextTool,
						[
							"--config",
							path.join(cwd, ".forge", "config.json"),
							"--personas",
							path.join(cwd, ".forge", "personas"),
							"--templates",
							path.join(cwd, ".forge", "templates"),
							"--kb",
							cwd,
							"--out",
							path.join(cwd, ".forge", "init-context.md"),
							"--json-out",
							path.join(cwd, ".forge", "init-context.json"),
						],
						cwd,
						ctx,
						"build-init-context",
						30000,
					);
				}

				// 3b: substitute-placeholders.cjs — base-pack materialisation
				if (fs.existsSync(substituteTool) && fs.existsSync(basePackDir)) {
					await runToolAdvisory(
						substituteTool,
						[
							"--forge-root",
							bundleRoot,
							"--base-pack",
							basePackDir,
							"--config",
							path.join(cwd, ".forge", "config.json"),
							"--context",
							path.join(cwd, ".forge", "init-context.json"),
							"--out",
							cwd,
						],
						cwd,
						ctx,
						"substitute-placeholders",
						60000,
					);
				}

				// 3c: build-overlay.cjs smoke test (exit 1 is advisory)
				if (fs.existsSync(buildOverlayTool)) {
					await runToolAdvisory(
						buildOverlayTool,
						["--task", "INIT-SMOKE-TEST", "--format", "json"],
						cwd,
						ctx,
						"build-overlay smoke (advisory)",
						15000,
					);
				}

				// Verify Phase 3 deliverables. substitute-placeholders.cjs is invoked
				// via runToolAdvisory, so a missing/invalid config produces zero
				// output and no exception. Hard-fail here.
				const phase3 = verifyPhase3(cwd);
				if (!phase3.ok) {
					ctx.ui.notify(
						`× Phase 3 failed: ${phase3.missing.join(", ")}. ` +
							`This usually means substitute-placeholders.cjs ran against an incomplete config. ` +
							`Fix .forge/config.json and run /forge:regenerate, or restart /forge:init from scratch (delete .forge/init-progress.json).`,
						"error",
					);
					return;
				}

				writeInitProgress(cwd, 3);
				ctx.ui.notify("〇 Phase 3 complete.", "info");
			}

			// ── Phase 4 — Register ────────────────────────────────────────────
			if (startPhase <= 4) {
				ctx.ui.setStatus?.("forge:init", "Phase 4/4: Register");
				const bannersTool = path.join(toolsRoot, "banners.cjs");
				if (fs.existsSync(bannersTool)) {
					await execFileAsync("node", [bannersTool, "--phase", "4", "4", "Register", "forge"], {
						cwd,
						timeout: 5000,
					}).catch(() => {
						/* non-fatal */
					});
				}

				const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
				const manageVersionsTool = path.join(toolsRoot, "manage-versions.cjs");
				const generationManifestTool = path.join(toolsRoot, "generation-manifest.cjs");
				const buildPersonaPackTool = path.join(toolsRoot, "build-persona-pack.cjs");
				const buildContextPackTool = path.join(toolsRoot, "build-context-pack.cjs");
				const buildInitContextTool = path.join(toolsRoot, "build-init-context.cjs");
				const seedStoreTool = path.join(toolsRoot, "seed-store.cjs");

				// Step 4-1: write paths.forgeRoot + copy schemas
				// Stamp paths.forgeRoot to the bundle root (dist/forge-payload/) so
				// that the canonical Forge convention "$FORGE_ROOT/tools/<tool>.cjs"
				// resolves correctly. The bundled tools live at
				// dist/forge-payload/tools/ (renamed from .tools/ — the dot prefix
				// broke the convention and forced consumers/workflows to special-case
				// the layout).
				if (fs.existsSync(manageConfigTool)) {
					// Validate that store-cli.cjs is present in the bundled tools dir
					// before stamping. Guards against half-built dist trees.
					let forgeRootToStamp: string;
					if (isPiRuntime()) {
						const toolsRoot = getBundledToolsRoot();
						const storeCli = path.join(toolsRoot, "store-cli.cjs");
						if (!fs.existsSync(storeCli)) {
							ctx.ui.notify(
								`× step 4-1 paths.forgeRoot: store-cli.cjs missing from bundled tools (expected: ${storeCli}). ` +
									"Run 'npm run build' to populate dist/forge-payload/tools/. Aborting Phase 4.",
								"error",
							);
							return;
						}
						forgeRootToStamp = bundleRoot;
					} else {
						// Claude Code path (not active today — preserved for future use)
						forgeRootToStamp = bundleRoot;
					}
					await runToolAdvisory(
						manageConfigTool,
						["set", "paths.forgeRoot", forgeRootToStamp],
						cwd,
						ctx,
						"step 4-1 paths.forgeRoot",
					);
				}

				const schemasSrc = path.join(bundleRoot, ".schemas");
				const schemasDest = path.join(cwd, ".forge", "schemas");
				fs.mkdirSync(schemasDest, { recursive: true });
				if (fs.existsSync(schemasSrc)) {
					const schemaFiles = fs.readdirSync(schemasSrc).filter((f) => f.endsWith(".json"));
					for (const f of schemaFiles) {
						try {
							fs.copyFileSync(path.join(schemasSrc, f), path.join(schemasDest, f));
						} catch {
							// non-fatal
						}
					}
					ctx.ui.notify(`〇 Copied ${schemaFiles.length} schema files to .forge/schemas/.`, "info");
				}

				// Step 4-1b: enhancement substrate
				const enhancementsDir = path.join(cwd, ".forge", "enhancements");
				fs.mkdirSync(enhancementsDir, { recursive: true });
				const overlaySchemaPath = path.join(schemasSrc, "project-overlay.schema.json");
				if (fs.existsSync(overlaySchemaPath)) {
					try {
						fs.copyFileSync(overlaySchemaPath, path.join(schemasDest, "project-overlay.schema.json"));
					} catch {
						// non-fatal
					}
				}

				// Step 4-2: manage-versions init
				if (fs.existsSync(manageVersionsTool)) {
					await runToolAdvisory(manageVersionsTool, ["init"], cwd, ctx, "step 4-2 manage-versions");
				}

				// Step 4-3: generation-manifest record-all
				if (fs.existsSync(generationManifestTool)) {
					await runToolAdvisory(
						generationManifestTool,
						["record-all"],
						cwd,
						ctx,
						"step 4-3 generation-manifest",
						30000,
					);
				}

				// Step 4-4: build-persona-pack
				if (fs.existsSync(buildPersonaPackTool)) {
					await runToolAdvisory(
						buildPersonaPackTool,
						["--out", path.join(cwd, ".forge", "cache", "persona-pack.json")],
						cwd,
						ctx,
						"step 4-4 build-persona-pack",
						30000,
					);
				}

				// Step 4-5: build-context-pack
				try {
					const raw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
					const cfg = JSON.parse(raw) as Record<string, unknown>;
					const p = cfg.paths as Record<string, unknown> | undefined;
					if (p && typeof p.engineering === "string") kbPathFinal = p.engineering;
				} catch {
					// use default "engineering"
				}

				if (fs.existsSync(buildContextPackTool)) {
					await runToolAdvisory(
						buildContextPackTool,
						[
							"--arch-dir",
							path.join(cwd, kbPathFinal, "architecture"),
							"--out-md",
							path.join(cwd, ".forge", "cache", "context-pack.md"),
							"--out-json",
							path.join(cwd, ".forge", "cache", "context-pack.json"),
						],
						cwd,
						ctx,
						"step 4-5 build-context-pack",
						30000,
					);
				}

				// Step 4-6: build-init-context final rebuild
				if (fs.existsSync(buildInitContextTool)) {
					await runToolAdvisory(
						buildInitContextTool,
						[
							"--config",
							path.join(cwd, ".forge", "config.json"),
							"--personas",
							path.join(cwd, ".forge", "personas"),
							"--templates",
							path.join(cwd, ".forge", "templates"),
							"--kb",
							cwd,
							"--out",
							path.join(cwd, ".forge", "init-context.md"),
							"--json-out",
							path.join(cwd, ".forge", "init-context.json"),
						],
						cwd,
						ctx,
						"step 4-6 build-init-context final",
						30000,
					);
				}

				// Step 4-7: seed-store
				if (fs.existsSync(seedStoreTool)) {
					await runToolAdvisory(seedStoreTool, [], cwd, ctx, "step 4-7 seed-store", 30000);
				}

				// Step 4-8: update-check cache baseline
				const updateCachePath = path.join(cwd, ".forge", "update-check-cache.json");
				try {
					const pluginPath = path.join(bundleRoot, ".claude-plugin", "plugin.json");
					const pluginRaw = fs.readFileSync(pluginPath, "utf8");
					const plugin = JSON.parse(pluginRaw) as { version?: string };
					const cache = {
						lastChecked: new Date().toISOString(),
						installedVersion: plugin.version ?? bundledVersion,
						latestVersion: plugin.version ?? bundledVersion,
						upToDate: true,
					};
					fs.writeFileSync(updateCachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
					ctx.ui.notify("〇 Update-check cache baseline written.", "info");
				} catch {
					ctx.ui.notify("△ Could not write update-check cache — non-fatal.", "warning");
				}

				// Step 4-9: Tomoshibi — invoke refresh-kb-links handler directly
				try {
					const refreshHandler = getRefreshKbLinksHandler();
					const refreshResult = await refreshHandler(cwd);
					for (const msg of refreshResult.messages) {
						ctx.ui.notify(msg, "info");
					}
					if (refreshResult.filesUpdated === 0) {
						ctx.ui.notify(
							"△ Run /forge:refresh-kb-links manually after init completes " +
								"(no agent instruction files found).",
							"info",
						);
					}
				} catch (err: unknown) {
					const e = err as { message?: string };
					ctx.ui.notify(
						`△ Tomoshibi (refresh-kb-links) failed: ${e.message ?? "unknown"} — ` +
							"Run /forge:refresh-kb-links manually after init completes.",
						"warning",
					);
				}

				// Step 4-10: .gitignore update
				updateGitignore(cwd, ctx);

				// Step 4-10b: BUG-025 fix — remove Claude-Code-only .claude/commands/ artifact.
				// substitute-placeholders.cjs (Phase 3) unconditionally writes command .md files
				// to .claude/commands/<prefix>/ regardless of runtime. Under pi runtime pi never
				// scans .claude/commands/ (commands are discovered via programmatic registerCommand
				// in registerAllForgeCommands). Delete the directory so it does not pollute the
				// project root. This runs in Phase 4 so it handles both same-session and resumed
				// inits (where Phase 3 ran in a prior session).
				if (isPiRuntime()) {
					let commandsPrefix = "forge";
					try {
						const cfgRaw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
						const cfg = JSON.parse(cfgRaw) as Record<string, unknown>;
						const proj = cfg.project as Record<string, unknown> | undefined;
						if (proj && typeof proj.prefix === "string" && proj.prefix) {
							commandsPrefix = proj.prefix.toLowerCase();
						}
					} catch {
						// fall back to "forge"
					}
					const claudeCommandsDir = path.join(cwd, ".claude", "commands", commandsPrefix);
					if (fs.existsSync(claudeCommandsDir)) {
						try {
							fs.rmSync(claudeCommandsDir, { recursive: true, force: true });
							// Remove empty ancestor dirs best-effort
							const parentDir = path.join(cwd, ".claude", "commands");
							try {
								if (fs.readdirSync(parentDir).length === 0) {
									fs.rmdirSync(parentDir);
									const grandparent = path.join(cwd, ".claude");
									if (fs.readdirSync(grandparent).length === 0) fs.rmdirSync(grandparent);
								}
							} catch {
								// best-effort
							}
						} catch (err: unknown) {
							const e = err as { message?: string };
							ctx.ui.notify(
								`△ Could not remove .claude/commands/${commandsPrefix}/: ${e.message ?? "unknown"} — non-fatal.`,
								"warning",
							);
						}
					}
				}

				// Step 4-11: agent instruction file linking
				await linkAgentInstructionFile(cwd, kbPathFinal, projectName, ctx);

				// Completion — delete init-progress
				deleteInitProgress(cwd);
				ctx.ui.notify("〇 Phase 4 complete — /forge:init done.", "info");
			}

			// ── Post-Phase-4: health check ────────────────────────────────────
			ctx.ui.setStatus?.("forge:init", "Post-init: health check");
			const healthResult = await runHealthCheck(cwd, bundleRoot);
			if (healthResult.clean) {
				ctx.ui.notify("〇 /forge:health: clean.", "info");
			} else {
				ctx.ui.notify(
					`△ /forge:health: ${healthResult.gaps.length} gap(s) detected — see console output.`,
					"warning",
				);
				for (const gap of healthResult.gaps) {
					ctx.ui.notify(`  · ${gap.check}: ${gap.message}`, "info");
				}
			}

			// ── post-init sentinel ────────────────────────────────────────────
			const sentinelPath = path.join(cwd, ".forge", "cache", "post-init-enhancement-triggered");
			if (!fs.existsSync(sentinelPath)) {
				try {
					fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
					fs.writeFileSync(sentinelPath, new Date().toISOString() + "\n", "utf8");
					ctx.ui.notify(
						"〇 /forge:enhance — full implementation in S18+. " +
							"Sentinel written; auto-trigger will fire when it lands.",
						"info",
					);
				} catch {
					// non-fatal
				}
			}

			// ── Report ────────────────────────────────────────────────────────
			// FIX BUG-020: read kbPathFinal from config.json at report time so
			// a custom KB folder chosen in Phase 1 is reflected here. kbPathFinal
			// is only updated inside the Phase-4 block, so if init was resumed
			// from Phase 1-3 we still get the right value.
			try {
				const cfgRaw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
				const cfg = JSON.parse(cfgRaw) as Record<string, unknown>;
				const p = cfg.paths as Record<string, unknown> | undefined;
				if (p && typeof p.engineering === "string" && p.engineering) {
					kbPathFinal = p.engineering;
				}
			} catch {
				// use default "engineering" already set
			}

			ctx.ui.setStatus?.("forge:init", undefined);
			const kbPath_ = kbPathFinal;

			// FIX BUG-022 (product call): surface gap details in Report.
			// Conservative path: always include gap list in the Report.
			// Exit non-zero (via notify "error") only for blocking (severity: "error") gaps.
			// Warning-severity gaps are advisory; init is considered successful.
			//
			// Rationale: exiting non-zero for any gap would break common fresh-init
			// flows where KB docs haven't been generated yet (kb-freshness warning).
			// Error gaps (e.g. config missing) indicate structural failure and must
			// surface clearly.
			const criticalGaps = healthResult.gaps.filter((g) => g.severity === "error");
			const warningGaps = healthResult.gaps.filter((g) => g.severity === "warning");

			let healthSection = `Health: ${healthResult.summary}`;
			if (healthResult.gaps.length > 0) {
				const gapLines = healthResult.gaps
					.map((g) => `  [${g.severity.toUpperCase()}] ${g.check}: ${g.message}`)
					.join("\n");
				healthSection += `\n\nGap detail:\n${gapLines}`;
			}
			if (warningGaps.length > 0) {
				healthSection += `\n\nWarning gaps are advisory. Run /forge:health anytime to recheck.`;
			}
			if (criticalGaps.length > 0) {
				healthSection += `\n\n× CRITICAL: ${criticalGaps.length} blocking gap(s) — review the detail above and re-run /forge:init.`;
				ctx.ui.notify(
					`× /forge:init: ${criticalGaps.length} critical gap(s) require attention — see Report.`,
					"error",
				);
			}

			// Final cross-phase verification — banner reflects real disk state.
			const finalP1 = verifyPhase1(cwd);
			const finalP3 = verifyPhase3(cwd);
			const fullyComplete = finalP1.ok && finalP3.ok;
			const bannerLabel = fullyComplete
				? `║  /forge:init complete                                        ║`
				: `║  /forge:init incomplete — see gaps below                     ║`;
			const incompleteDetail: string[] = [];
			if (!finalP1.ok) {
				incompleteDetail.push(`× Phase 1: ${finalP1.missing.join(", ")} (config incomplete)`);
			}
			if (!finalP3.ok) {
				incompleteDetail.push(`× Phase 3: ${finalP3.missing.join(", ")} (materialization missing)`);
				incompleteDetail.push(
					`  → Recover: \`/forge:regenerate\` (re-runs substitute-placeholders against current config), or delete .forge/init-progress.json and re-run /forge:init.`,
				);
			}

			const report = [
				``,
				`╔══════════════════════════════════════════════════════════════╗`,
				bannerLabel,
				`╚══════════════════════════════════════════════════════════════╝`,
				``,
				`Project: ${projectName}`,
				`Bundle:  forge v${bundledVersion}`,
				``,
				`Knowledge base: ${kbPath_}/`,
				`Personas: .forge/personas/`,
				`Skills:   .forge/skills/`,
				`Workflows: .forge/workflows/`,
				`Templates: .forge/templates/`,
				``,
				...(incompleteDetail.length > 0 ? [`Phase verification gaps:`, ...incompleteDetail, ``] : []),
				healthSection,
				``,
				`Next steps:`,
				`  1. Run /forge:sprint-intake to start your first sprint`,
				`  2. Run /forge:health anytime to check project health`,
				`  3. Run /forge:refresh-kb-links to update agent instruction file links`,
				``,
				`Note: Marketplace skills auto-recommendation is Claude-Code-only.`,
				`Pi users install extensions manually.`,
				``,
				// BUG-025: explain slash command registration under pi runtime
				...(isPiRuntime()
					? [
							`Note: Slash commands registered programmatically (pi runtime); skipping .claude/commands/ Claude-Code-only artifact.`,
							``,
						]
					: []),
			].join("\n");

			sendToAgent(report);
		},
	});
}
