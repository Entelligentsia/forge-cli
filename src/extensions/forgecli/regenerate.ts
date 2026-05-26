// regenerate.ts — native handler for /forge:rebuild (renamed from /forge:regenerate in v1.0).
//
// v0 scope: re-materialize the project's .forge/ and .claude/commands/ trees
// from the bundled forge-payload (.base-pack + substitute-placeholders.cjs).
// This is the deterministic subset of the plugin's /forge:rebuild
// behaviour — the meta-driven persona/skill/workflow fan-out (which spawns
// generation subagents) is NOT covered here. v0 is sufficient for the
// common dogfooding case: "I just rebundled a new plugin payload and want
// the testbench to pick up the new workflows / commands / templates."
//
// FORGE-S26-T11: `--enrich` flag added. When present, skips the base-pack
// re-materialization and dispatches to the enhance workflow (Phase 2 behavior,
// equivalent to former /forge:enhance). Mirrors T03's absorption of enhance
// into rebuild --enrich.
//
// No sub-target filtering yet; full re-materialization on every call.
// Idempotent — re-running with no changes overwrites with identical bytes.
//
// See forge-cli companion to forge#83 / #85.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// FORGE-S26-T11: registerEnhance imported to power `forge:rebuild --enrich`
import { registerEnhance } from "./enhance.js";
import { getBundledPayloadRoot, getBundledToolsRoot } from "./forge-init.js";

// ── Pre-write modification guard (forge-cli#26 / forge#106 / FORGE-BUG-037) ──
//
// `substitute-placeholders.cjs` blanket-overwrites every file in the four
// structural-element categories. Before invoking it, enumerate each .forge/<cat>/
// file and run `generation-manifest.cjs check`. Any file whose recorded hash
// no longer matches its on-disk content is a manual modification — typically
// applied by /forge:enhance Phase 2 — and would be silently destroyed.
// Surface the list to the user and require explicit confirmation.

const STRUCTURAL_CATEGORIES = ["personas", "skills", "workflows", "templates"] as const;

export interface ModifiedFile {
	category: string;
	relativePath: string; // e.g. ".forge/skills/engineer-skills.md"
	/** "modified" = manifest hash mismatch; "untracked" = no manifest entry (file exists but never recorded). */
	state: "modified" | "untracked";
}

/**
 * Enumerate files in .forge/{personas,skills,workflows,templates}/ and return
 * those whose state diverges from the manifest baseline. Two divergence states
 * are surfaced (both warrant a prompt before overwrite):
 *
 * - "modified": file content differs from the recorded manifest hash. Typically
 *   caused by /forge:enhance Phase 2 applying edits in-place.
 * - "untracked": file exists on disk but has NO manifest entry. Caused by a
 *   prior regenerate that ran `clear-namespace` without re-recording. A fresh
 *   /forge:init records hashes for every generated file, so "untracked" should
 *   never appear in a clean install — its presence signals user content that's
 *   been disconnected from the tracking system. See forge-cli#30.
 *
 * Pure function (no I/O beyond fs reads + manifest tool spawns).
 */
export function findModifiedStructuralFiles(cwd: string, toolsRoot: string): ModifiedFile[] {
	const manifestTool = path.join(toolsRoot, "generation-manifest.cjs");
	if (!fs.existsSync(manifestTool)) return [];

	const modified: ModifiedFile[] = [];

	for (const category of STRUCTURAL_CATEGORIES) {
		const dir = path.join(cwd, ".forge", category);
		if (!fs.existsSync(dir)) continue;

		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		for (const f of files) {
			const relPath = path.posix.join(".forge", category, f);
			const result = spawnSync("node", [manifestTool, "check", relPath], {
				cwd,
				encoding: "utf8",
				timeout: 5_000,
			});
			// generation-manifest check exit codes:
			//   0 = pristine, 1 = modified, 2 = untracked, 3 = file missing
			if (result.status === 1) {
				modified.push({ category, relativePath: relPath, state: "modified" });
			} else if (result.status === 2) {
				modified.push({ category, relativePath: relPath, state: "untracked" });
			}
		}
	}

	return modified;
}

async function runTool(
	toolPath: string,
	argv: string[],
	cwd: string,
	ctx: ExtensionCommandContext,
	label: string,
	timeoutMs = 60_000,
): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const child = spawn("node", [toolPath, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdoutBuf = "";
		let stderrBuf = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			ctx.ui.notify(`× forge:regenerate — ${label} timed out after ${timeoutMs}ms`, "error");
			resolve(false);
		}, timeoutMs);
		child.stdout?.on("data", (d) => {
			stdoutBuf += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderrBuf += d.toString();
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				ctx.ui.notify(`〇 ${label} complete`, "info");
				resolve(true);
			} else {
				const msg = (stderrBuf || stdoutBuf).trim().split("\n").slice(-3).join(" | ") || "unknown error";
				ctx.ui.notify(`× forge:regenerate — ${label} exit ${code}: ${msg}`, "error");
				resolve(false);
			}
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			ctx.ui.notify(`× forge:regenerate — ${label} spawn failed: ${err.message}`, "error");
			resolve(false);
		});
	});
}

export function registerRegenerate(pi: ExtensionAPI): void {
	pi.registerCommand("forge:rebuild", {
		description:
			"Re-materialize .forge/ and .claude/commands/ from the bundled forge-payload " +
			"(deterministic subset of the plugin's /forge:rebuild — runs substitute-placeholders.cjs). " +
			"--enrich: trigger enhancement workflow (Phase 2) instead of base-pack re-materialization.",
		async handler(args, ctx) {
			const cwd = process.cwd();

			// FORGE-S26-T11: --enrich flag dispatches to enhance behavior (absorbed from forge:enhance).
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const hasEnrich = parts.includes("--enrich");
			if (hasEnrich) {
				// Strip --enrich, pass remaining args to enhance handler (Phase 2 default)
				const enhanceArgs = parts.filter((p) => p !== "--enrich").join(" ");
				let enhanceHandler:
					| ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
					| undefined;
				const syntheticPi = {
					...pi,
					registerCommand: (name: string, def: { handler: typeof enhanceHandler }) => {
						if (name === "forge:enhance") enhanceHandler = def.handler;
					},
				} as unknown as ExtensionAPI;
				registerEnhance(syntheticPi);
				if (enhanceHandler) {
					await enhanceHandler(enhanceArgs, ctx);
				} else {
					ctx.ui.notify("× forge:rebuild --enrich — enhance handler unavailable", "error");
				}
				return;
			}

			const configPath = path.join(cwd, ".forge", "config.json");
			if (!fs.existsSync(configPath)) {
				ctx.ui.notify("× forge:rebuild — no .forge/config.json at cwd. Run /forge:init first.", "error");
				return;
			}

			const bundleRoot = getBundledPayloadRoot();
			const toolsRoot = getBundledToolsRoot();
			const buildInitContextTool = path.join(toolsRoot, "build-init-context.cjs");
			const substituteTool = path.join(toolsRoot, "substitute-placeholders.cjs");
			const basePackDir = path.join(bundleRoot, ".base-pack");

			if (!fs.existsSync(substituteTool)) {
				ctx.ui.notify(`× forge:rebuild — substitute-placeholders.cjs missing at ${substituteTool}`, "error");
				return;
			}
			if (!fs.existsSync(basePackDir)) {
				ctx.ui.notify(`× forge:rebuild — base-pack missing at ${basePackDir}`, "error");
				return;
			}

			// Pre-write modification guard (forge-cli#26 / forge#106 / FORGE-BUG-037).
			// Skip with --force (e.g. CI / dogfood reset). Otherwise, surface any
			// manual modifications (typically applied by /forge:enhance Phase 2)
			// and require explicit confirmation before overwriting them.
			const force = (args ?? []).includes("--force");
			if (!force) {
				const divergent = findModifiedStructuralFiles(cwd, toolsRoot);
				if (divergent.length > 0) {
					const modCount = divergent.filter((m) => m.state === "modified").length;
					const untCount = divergent.filter((m) => m.state === "untracked").length;
					const summary = [
						`${divergent.length} file(s) in .forge/ diverge from the manifest baseline:`,
						`  ${modCount} modified (hash mismatch — typical /forge:enhance Phase 2 edit)`,
						`  ${untCount} untracked (no manifest entry — usually means a prior regenerate cleared the namespace)`,
						"",
						"Divergent files:",
						...divergent.map((m) => `  △ [${m.state}] ${m.relativePath}`),
						"",
						"Edits CAPTURED by /forge:enhance Phase 2 snapshots (.forge/archive/snap-N/)",
						"will be RESTORED automatically post-regenerate via `manage-versions replay`",
						"(forge#107 / Approach A — overlay semantics, later snapshots win).",
						"",
						"Edits NOT captured in any snapshot will be lost. To capture before regen, run",
						"/forge:enhance Phase 2 → approve edits → ensure `add-snapshot` was called.",
						"",
						"Answer 'yes' to proceed (snapshot-captured edits survive automatically).",
						"Answer 'no' to abort.",
						"Use --force to skip this prompt AND skip replay (pristine base-pack).",
					].join("\n");
					const proceed = await ctx.ui.confirm(
						`Proceed with regenerate? (${divergent.length} divergent file(s): ${modCount} modified, ${untCount} untracked)`,
						summary,
					);
					if (!proceed) {
						ctx.ui.notify(
							`〇 forge:rebuild cancelled — ${divergent.length} divergent file(s) preserved.`,
							"info",
						);
						return;
					}
				}
			}

			ctx.ui.setStatus?.("forge:rebuild", "rebuilding init-context…");

			// 1. Rebuild init-context.json so substitute has fresh placeholders.
			if (fs.existsSync(buildInitContextTool)) {
				const ok = await runTool(
					buildInitContextTool,
					[
						"--config",
						configPath,
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
					30_000,
				);
				if (!ok) {
					ctx.ui.setStatus?.("forge:rebuild", undefined);
					return;
				}
			}

			ctx.ui.setStatus?.("forge:rebuild", "materializing .forge/ + .claude/commands/…");

			// 2. Re-run substitute-placeholders against the bundled base-pack.
			const ok = await runTool(
				substituteTool,
				[
					"--forge-root",
					bundleRoot,
					"--base-pack",
					basePackDir,
					"--config",
					configPath,
					"--context",
					path.join(cwd, ".forge", "init-context.json"),
					"--out",
					cwd,
				],
				cwd,
				ctx,
				"substitute-placeholders",
				60_000,
			);

			// 3a. Replay user enhancements (forge#107 / forge-cli#27 — Approach A layer 3).
			//     After substitute-placeholders wrote fresh base-pack content over
			//     .forge/{personas,skills,workflows,templates}/, restore any user-enhanced
			//     files captured by /forge:enhance Phase 2 snapshots from .forge/archive/snap-N/.
			//     Mirrors regenerate.md's per-category replay step. Pure additive — replay
			//     is a no-op when no snapshots match. Skipped when --force is used (force
			//     is "I want pristine base-pack content, no overlay").
			const manageVersionsTool = path.join(toolsRoot, "manage-versions.cjs");
			let replayTotal = 0;
			if (ok && !force && fs.existsSync(manageVersionsTool)) {
				ctx.ui.setStatus?.("forge:regenerate", "replaying user enhancements…");
				const replayCategories = ["personas", "skills", "workflows", "templates"];
				for (const category of replayCategories) {
					await new Promise<void>((resolve) => {
						const child = spawn("node", [manageVersionsTool, "replay", "--target", category], {
							cwd,
							stdio: ["ignore", "pipe", "pipe"],
						});
						let stdoutBuf = "";
						child.stdout?.on("data", (d) => {
							stdoutBuf += d.toString();
						});
						child.on("close", (code) => {
							if (code === 0) {
								// Parse "restored — N file(s)" out of stdout to track total
								const m = stdoutBuf.match(/(\d+)\s+file\(s\)\s+restored/);
								if (m) {
									replayTotal += parseInt(m[1], 10);
								}
							}
							// Non-zero exit (e.g. structure-versions.json missing on a
							// project that never ran /forge:enhance): treat as no-op.
							resolve();
						});
						child.on("error", () => resolve());
					});
				}
				if (replayTotal > 0) {
					ctx.ui.notify(`〇 replay: ${replayTotal} user enhancement(s) restored from snapshots`, "info");
				}
			}

			// 3b. Refresh schemas from bundled .schemas/. substitute-placeholders does
			//    not touch .forge/schemas/, but a forge plugin version bump can ship
			//    schema changes (e.g. 0.43.13 added `provider` required + dropped
			//    `estimatedCostUSD`). Without this step, regenerated workflows assume
			//    the new contract while the schemas on disk still enforce the old one
			//    — leading to silent validation drift. Mirrors forge-init.ts copy.
			let schemaCount = 0;
			if (ok) {
				const schemasSrc = path.join(bundleRoot, ".schemas");
				const schemasDest = path.join(cwd, ".forge", "schemas");
				if (fs.existsSync(schemasSrc)) {
					fs.mkdirSync(schemasDest, { recursive: true });
					const files = fs.readdirSync(schemasSrc).filter((f) => f.endsWith(".json"));
					for (const f of files) {
						try {
							fs.copyFileSync(path.join(schemasSrc, f), path.join(schemasDest, f));
							schemaCount++;
						} catch {
							// non-fatal — surfaced in count below
						}
					}
				}
			}

			ctx.ui.setStatus?.("forge:rebuild", undefined);
			if (ok) {
				// 4. Update forgeRoot in .forge/config.json to point to the bundled payload.
				//    Without this, projects initialized under a different runtime (e.g. Claude
				//    Code plugin cache) keep pointing to the stale forgeRoot. This causes
				//    subagent bash calls to $FORGE_ROOT to hit outdated store-cli, schema
				//    validators, etc. that lack new enum values and status transitions.
				if (bundleRoot) {
					try {
						const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
						const oldRoot = config?.paths?.forgeRoot;
						if (oldRoot !== bundleRoot) {
							config.paths = config.paths || {};
							config.paths.forgeRoot = bundleRoot;
							fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
							ctx.ui.notify(`Updated forgeRoot in config.json: ${oldRoot ?? "(unset)"} → ${bundleRoot}`, "info");
						}
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						ctx.ui.notify(`⚠ forge:rebuild — could not update forgeRoot in config.json: ${msg}`, "warning");
					}
				}

				ctx.ui.notify(
					"〇 forge:rebuild complete — .forge/workflows, .forge/personas, .forge/skills, " +
						`.forge/templates, .claude/commands/ re-materialized from bundled payload; ${schemaCount} schemas refreshed.`,
					"info",
				);
			}
		},
	});
}
