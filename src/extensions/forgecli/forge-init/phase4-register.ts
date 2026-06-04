// forge-init/phase4-register.ts — Phase 4 Register (FORGE-S25-T24, B-5)
//
// Encapsulates Steps 4-1 through 4-11 from the init pipeline.
// Phase 4 is heterogeneous (11 deterministic FS/tool/git steps, no LLM dispatch)
// and is extracted as a standalone async function.
//
// Key contract:
//   - Returns `Phase4Result { kbPathFinal }` on success — caller reads kbPathFinal for
//     the post-init report section.
//   - Returns `"abort"` when Step 4-1 detects store-cli.cjs is missing (half-built dist).
//     The caller MUST handle "abort" and return immediately from the init handler.
//   - `deleteInitProgress` is called on successful completion.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deleteInitProgress } from "./init-progress.js";
import { execFileAsync, runToolAdvisory } from "../lib/exec-helpers.js";
import { getRefreshKbLinksHandler } from "../refresh-kb-links.js";

/** Read the bundled forge version from .claude-plugin/plugin.json */
function getBundledForgeVersion(bundleRoot: string): string {
	try {
		const pluginPath = path.join(bundleRoot, ".claude-plugin", "plugin.json");
		const raw = fs.readFileSync(pluginPath, "utf8");
		const plugin = JSON.parse(raw) as { version?: string };
		return typeof plugin.version === "string" ? plugin.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface Phase4Result {
	kbPathFinal: string;
}

export interface Phase4Context {
	cwd: string;
	bundleRoot: string;
	toolsRoot: string;
	projectName: string;
	configCache: Record<string, unknown>;
	ctx: ExtensionCommandContext;
	isPiRuntime: () => boolean;
	getBundledToolsRoot: () => string;
}

// ── Private helpers ────────────────────────────────────────────────────────

function updateGitignore(cwd: string, ctx: ExtensionCommandContext): void {
	const gitignorePath = path.join(cwd, ".gitignore");
	if (!fs.existsSync(gitignorePath)) {
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

function collectMdFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectMdFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(full);
		}
	}
	return results;
}

function isNonInteractiveLocal(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

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
	const ok = isNonInteractiveLocal()
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
		`| /forge:plan-sprint | Decompose sprint requirements into tasks |`,
		`| /forge:new-sprint | Elicit and structure requirements for a new sprint |`,
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

// ── Phase 4 runner ─────────────────────────────────────────────────────────

/**
 * Run Phase 4 — Register: 11 deterministic steps.
 *
 * Returns `Phase4Result` on success or `"abort"` if Step 4-1 fails (missing store-cli.cjs).
 */
export async function runPhase4(ctx4: Phase4Context): Promise<Phase4Result | "abort"> {
	const {
		cwd,
		bundleRoot,
		toolsRoot,
		projectName,
		configCache,
		ctx,
		isPiRuntime,
		getBundledToolsRoot: getToolsRoot,
	} = ctx4;

	ctx.ui.setStatus?.("forge:init", "Phase 4/4: Register");

	// Banner
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

	// ── Step 4-1: write paths.forgeRoot + copy schemas ──────────────────────
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
			const runtimeToolsRoot = getToolsRoot();
			const storeCli = path.join(runtimeToolsRoot, "store-cli.cjs");
			if (!fs.existsSync(storeCli)) {
				ctx.ui.notify(
					`× step 4-1 paths.forgeRoot: store-cli.cjs missing from bundled tools (expected: ${storeCli}). ` +
						"Run 'npm run build' to populate dist/forge-payload/tools/. Aborting Phase 4.",
					"error",
				);
				return "abort";
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

		// Write paths.forgeRef (FR-010) — the bundled plugin version
		const bundledVersion = getBundledForgeVersion(bundleRoot);
		if (bundledVersion && bundledVersion !== "0.0.0") {
			await runToolAdvisory(
				manageConfigTool,
				["set", "paths.forgeRef", bundledVersion],
				cwd,
				ctx,
				"step 4-1 paths.forgeRef",
			);
		}

		// Backfill missing config fields from schema defaults (version, paths.*, etc.)
		await runToolAdvisory(
			manageConfigTool,
			["backfill", "--forge-root", bundleRoot],
			cwd,
			ctx,
			"step 4-1 config backfill",
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

	// ── Step 4-1a: tools-copy (FORGE-S29-T05) ───────────────────────────────
	// Copy bundled tools/*.cjs and tools/lib/*.cjs into .forge/tools/ so that
	// subagents can invoke store-cli and friends via .forge/tools/ without
	// relying on FORGE_ROOT environment variable resolution.
	// Mirrors the plugin T01 tools-vendoring step. Non-fatal: a missing tools
	// dir is silently skipped (e.g. minimal test bundles).
	{
		const toolsSrc = path.join(getToolsRoot());
		const toolsDest = path.join(cwd, ".forge", "tools");
		try {
			if (fs.existsSync(toolsSrc)) {
				fs.mkdirSync(toolsDest, { recursive: true });
				const toolFiles = fs.readdirSync(toolsSrc).filter((f) => f.endsWith(".cjs") || f.endsWith(".js"));
				for (const f of toolFiles) {
					try {
						fs.copyFileSync(path.join(toolsSrc, f), path.join(toolsDest, f));
					} catch {
						// non-fatal
					}
				}
				// Copy lib/ subdirectory
				const libSrc = path.join(toolsSrc, "lib");
				const libDest = path.join(toolsDest, "lib");
				if (fs.existsSync(libSrc)) {
					fs.mkdirSync(libDest, { recursive: true });
					const libFiles = fs.readdirSync(libSrc).filter((f) => f.endsWith(".cjs") || f.endsWith(".js"));
					for (const f of libFiles) {
						try {
							fs.copyFileSync(path.join(libSrc, f), path.join(libDest, f));
						} catch {
							// non-fatal
						}
					}
				}
				// Write .forge-tools-version marker with the bundled plugin version
				const toolsVersion = getBundledForgeVersion(bundleRoot);
				const markerPath = path.join(toolsDest, ".forge-tools-version");
				try {
					fs.writeFileSync(markerPath, JSON.stringify({ version: toolsVersion }, null, 2) + "\n", "utf8");
				} catch {
					// non-fatal
				}
				ctx.ui.notify(`〇 Copied bundled tools to .forge/tools/ (v${toolsVersion}).`, "info");
			}
		} catch {
			// non-fatal — tools-copy failure does not abort Phase 4
			ctx.ui.notify("△ Could not copy bundled tools to .forge/tools/ — non-fatal.", "warning");
		}
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

	// ── Step 4-2: manage-versions init ──────────────────────────────────────
	if (fs.existsSync(manageVersionsTool)) {
		await runToolAdvisory(manageVersionsTool, ["init"], cwd, ctx, "step 4-2 manage-versions");
	}

	// ── Step 4-3: generation-manifest seed + record-all ─────────────────────
	// record-all re-hashes already-tracked files but is a no-op on an empty
	// manifest. When Phase 2 ran inline (no subagent dispatch), the model skips
	// the per-file self-check step that calls `record <path>`, leaving the
	// manifest empty. Seed first by recording every .md in the KB directory so
	// record-all has something to work with regardless of which Phase 2 path ran.
	if (fs.existsSync(generationManifestTool)) {
		const engPath = (() => {
			const p = configCache.paths as Record<string, unknown> | undefined;
			return p && typeof p.engineering === "string" ? p.engineering : "engineering";
		})();
		const kbDir = path.join(cwd, engPath);
		for (const mdFile of collectMdFiles(kbDir)) {
			await runToolAdvisory(
				generationManifestTool,
				["record", mdFile],
				cwd,
				ctx,
				`step 4-3 generation-manifest seed: ${path.relative(cwd, mdFile)}`,
				10000,
			);
		}
		await runToolAdvisory(
			generationManifestTool,
			["record-all"],
			cwd,
			ctx,
			"step 4-3 generation-manifest record-all",
			30000,
		);
	}

	// ── Step 4-4: build-persona-pack ─────────────────────────────────────────
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

	// ── Step 4-5: build-context-pack — extract kbPathFinal from configCache ──
	let kbPathFinal = "engineering";
	{
		const p = configCache.paths as Record<string, unknown> | undefined;
		if (p && typeof p.engineering === "string") kbPathFinal = p.engineering;
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

	// ── Step 4-6: build-init-context final rebuild ───────────────────────────
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

	// ── Step 4-7: seed-store ─────────────────────────────────────────────────
	if (fs.existsSync(seedStoreTool)) {
		await runToolAdvisory(seedStoreTool, [], cwd, ctx, "step 4-7 seed-store", 30000);
	}

	// ── Step 4-8: update-check cache baseline ────────────────────────────────
	const updateCachePath = path.join(cwd, ".forge", "update-check-cache.json");
	try {
		const pluginPath = path.join(bundleRoot, ".claude-plugin", "plugin.json");
		const pluginRaw = fs.readFileSync(pluginPath, "utf8");
		const plugin = JSON.parse(pluginRaw) as { version?: string };
		const bundledVersion = plugin.version ?? "0.0.0";
		const cache = {
			lastChecked: new Date().toISOString(),
			installedVersion: bundledVersion,
			latestVersion: bundledVersion,
			upToDate: true,
		};
		fs.writeFileSync(updateCachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
		ctx.ui.notify("〇 Update-check cache baseline written.", "info");
	} catch {
		ctx.ui.notify("△ Could not write update-check cache — non-fatal.", "warning");
	}

	// ── Step 4-9: Tomoshibi — invoke refresh-kb-links handler directly ───────
	try {
		const refreshHandler = getRefreshKbLinksHandler();
		const refreshResult = await refreshHandler(cwd);
		for (const msg of refreshResult.messages) {
			ctx.ui.notify(msg, "info");
		}
		if (refreshResult.filesUpdated === 0) {
			ctx.ui.notify(
				"△ Run /forge:refresh-kb-links manually after init completes " + "(no agent instruction files found).",
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

	// ── Step 4-10: .gitignore update ─────────────────────────────────────────
	updateGitignore(cwd, ctx);

	// Step 4-10b: BUG-025 fix — remove Claude-Code-only .claude/commands/ artifact.
	// substitute-placeholders.cjs (Phase 3) unconditionally writes command .md files
	// to .claude/commands/<prefix>/ regardless of runtime. Under pi runtime pi never
	// scans .claude/commands/ (commands are discovered via programmatic registerCommand
	// in registerAllForgeCommands). Delete the directory so it does not pollute the
	// project root. This runs in Phase 4 so it handles both same-session and resumed
	// inits (where Phase 3 ran in a prior session).
	if (isPiRuntime()) {
		// Use configCache — Phase 1 wrote config.json and configCache was populated before Phase 2
		let commandsPrefix = "forge";
		{
			const proj = configCache.project as Record<string, unknown> | undefined;
			if (proj && typeof proj.prefix === "string" && proj.prefix) {
				commandsPrefix = proj.prefix.toLowerCase();
			}
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

	// ── Step 4-11: agent instruction file linking ─────────────────────────────
	await linkAgentInstructionFile(cwd, kbPathFinal, projectName, ctx);

	// Completion — delete init-progress (always at the END, after all steps succeed)
	deleteInitProgress(cwd);
	ctx.ui.notify("〇 Phase 4 complete — /forge:init done.", "info");

	return { kbPathFinal };
}
