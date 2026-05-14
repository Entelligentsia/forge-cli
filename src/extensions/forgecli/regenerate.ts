// regenerate.ts — native handler for /forge:regenerate.
//
// v0 scope: re-materialize the project's .forge/ and .claude/commands/ trees
// from the bundled forge-payload (.base-pack + substitute-placeholders.cjs).
// This is the deterministic subset of the plugin's /forge:regenerate
// behaviour — the meta-driven persona/skill/workflow fan-out (which spawns
// generation subagents) is NOT covered here. v0 is sufficient for the
// common dogfooding case: "I just rebundled a new plugin payload and want
// the testbench to pick up the new workflows / commands / templates."
//
// No sub-target filtering yet; full re-materialization on every call.
// Idempotent — re-running with no changes overwrites with identical bytes.
//
// See forge-cli companion to forge#83 / #85.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";

import { getBundledPayloadRoot, getBundledToolsRoot } from "./forge-init.js";

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
	pi.registerCommand("forge:regenerate", {
		description:
			"Re-materialize .forge/ and .claude/commands/ from the bundled forge-payload " +
			"(deterministic subset of the plugin's /forge:regenerate — runs substitute-placeholders.cjs).",
		async handler(_args, ctx) {
			const cwd = process.cwd();
			const configPath = path.join(cwd, ".forge", "config.json");
			if (!fs.existsSync(configPath)) {
				ctx.ui.notify(
					"× forge:regenerate — no .forge/config.json at cwd. Run /forge:init first.",
					"error",
				);
				return;
			}

			const bundleRoot = getBundledPayloadRoot();
			const toolsRoot = getBundledToolsRoot();
			const buildInitContextTool = path.join(toolsRoot, "build-init-context.cjs");
			const substituteTool = path.join(toolsRoot, "substitute-placeholders.cjs");
			const basePackDir = path.join(bundleRoot, ".base-pack");

			if (!fs.existsSync(substituteTool)) {
				ctx.ui.notify(
					`× forge:regenerate — substitute-placeholders.cjs missing at ${substituteTool}`,
					"error",
				);
				return;
			}
			if (!fs.existsSync(basePackDir)) {
				ctx.ui.notify(`× forge:regenerate — base-pack missing at ${basePackDir}`, "error");
				return;
			}

			ctx.ui.setStatus?.("forge:regenerate", "rebuilding init-context…");

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
					ctx.ui.setStatus?.("forge:regenerate", undefined);
					return;
				}
			}

			ctx.ui.setStatus?.("forge:regenerate", "materializing .forge/ + .claude/commands/…");

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

			ctx.ui.setStatus?.("forge:regenerate", undefined);
			if (ok) {
				ctx.ui.notify(
					"〇 forge:regenerate complete — .forge/workflows, .forge/personas, .forge/skills, " +
						".forge/templates, .claude/commands/ re-materialized from bundled payload.",
					"info",
				);
			}
		},
	});
}
