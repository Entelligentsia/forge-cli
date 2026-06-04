// materialize.ts — native handler for /forge:materialize (FORGE-S23-T09)
//
// Ports the deterministic subset of the plugin's /forge:materialize:
//   - Full warm-up (no args or --all): runs substitute-placeholders.cjs,
//     build-persona-pack.cjs, and build-context-pack.cjs from the bundled payload.
//   - Single-workflow mode: deferred — notify + return (follow-up task).
//
// Mode-neutral invariant: never writes .forge/config.json mode field.
// Uses spawn("node", [toolPath, ...argv]) — argv-array, no shell (IL6).
//
// References: regenerate.ts (substitute-placeholders.cjs argv),
//             forge-init.ts (build-persona-pack / build-context-pack argv).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getBundledPayloadRoot, getBundledToolsRoot } from "./forge-init/forge-init.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ParsedMaterializeArgs {
	mode: "all" | "single-workflow";
	workflowId?: string; // only when mode === "single-workflow"
}

// ── Argument parser ─────────────────────────────────────────────────────────

/**
 * Parse /forge:materialize arguments.
 *
 * Recognised forms:
 *   (empty)                  → { mode: "all" }
 *   --all                    → { mode: "all" }
 *   workflows <id>           → { mode: "single-workflow", workflowId: "<id>" }
 *   workflows:<id>           → { mode: "single-workflow", workflowId: "<id>" }
 */
export function parseMaterializeArgs(args: string): ParsedMaterializeArgs {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "--all") {
		return { mode: "all" };
	}
	// "workflows plan_task" or "workflows:plan_task"
	const workflowsMatch = trimmed.match(/^workflows[: ](.+)$/);
	if (workflowsMatch) {
		return { mode: "single-workflow", workflowId: workflowsMatch[1].trim() };
	}
	// Unrecognised flags/forms: treat as full warm-up (fail-open)
	return { mode: "all" };
}

// ── Tool runner ─────────────────────────────────────────────────────────────

/**
 * Spawn `node <toolPath> [...argv]` and await completion.
 * Returns `{ ok: boolean, stderr: string }`.
 *
 * Non-zero exit is FATAL when `fatal === true` (default), ADVISORY otherwise.
 */
async function runTool(
	toolPath: string,
	argv: string[],
	cwd: string,
	label: string,
	timeoutMs = 60_000,
): Promise<{ ok: boolean; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("node", [toolPath, ...argv], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderrBuf = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ ok: false, stderr: `${label} timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		child.stderr?.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, stderr: stderrBuf });
		});
		child.on("error", (err: Error) => {
			clearTimeout(timer);
			resolve({ ok: false, stderr: err.message });
		});
	});
}

// ── Register ────────────────────────────────────────────────────────────────

export function registerMaterialize(pi: ExtensionAPI): void {
	pi.registerCommand("forge:materialize", {
		description:
			"Fill missing or stubbed Forge scaffolding without overwriting pristine files. " +
			"Deterministic complement to /forge:init --fast. Mode-neutral: never writes config mode.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();
			const parsed = parseMaterializeArgs(args);

			// Single-workflow mode: deferred in forge-cli — notify and return
			if (parsed.mode === "single-workflow") {
				ctx.ui.notify(
					`〇 forge:materialize — single-workflow mode ('${parsed.workflowId ?? "?"}') is not yet supported in forge-cli. ` +
						"Use the Forge plugin directly or run /forge:materialize --all for a full warm-up.",
					"info",
				);
				return;
			}

			// Config guard
			const configPath = path.join(cwd, ".forge", "config.json");
			if (!fs.existsSync(configPath)) {
				ctx.ui.notify("× forge:materialize — no .forge/config.json found. Run /forge:init first.", "error");
				return;
			}

			// Resolve tool paths
			let bundleRoot: string;
			let toolsRoot: string;
			try {
				bundleRoot = getBundledPayloadRoot();
				toolsRoot = getBundledToolsRoot();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`× forge:materialize — could not resolve bundle paths: ${msg}`, "error");
				return;
			}

			const substituteTool = path.join(toolsRoot, "substitute-placeholders.cjs");
			const basePackDir = path.join(bundleRoot, ".base-pack");
			const configJsonPath = path.join(cwd, ".forge", "config.json");

			// Guard: tools must exist
			if (!fs.existsSync(substituteTool)) {
				ctx.ui.notify(`× forge:materialize — substitute-placeholders.cjs not found at ${substituteTool}`, "error");
				return;
			}
			if (!fs.existsSync(basePackDir)) {
				ctx.ui.notify(`× forge:materialize — .base-pack not found at ${basePackDir}`, "error");
				return;
			}

			ctx.ui.setStatus?.("forge:materialize", "Materializing .forge/ artifacts…");

			// Step 1: substitute-placeholders.cjs (fatal on failure)
			// argv shape mirrors regenerate.ts usage
			const initContextJson = path.join(cwd, ".forge", "init-context.json");
			const subArgv = [
				"--forge-root",
				bundleRoot,
				"--base-pack",
				basePackDir,
				"--config",
				configJsonPath,
				"--out",
				cwd,
			];
			if (fs.existsSync(initContextJson)) {
				subArgv.push("--context", initContextJson);
			}

			const subResult = await runTool(substituteTool, subArgv, cwd, "substitute-placeholders", 60_000);
			if (!subResult.ok) {
				const errMsg = subResult.stderr.trim().split("\n").slice(-3).join(" | ") || "unknown error";
				ctx.ui.notify(`× forge:materialize — substitute-placeholders.cjs failed: ${errMsg}`, "error");
				ctx.ui.setStatus?.("forge:materialize", undefined);
				return;
			}
			ctx.ui.notify("〇 forge:materialize — scaffold filled", "info");

			// Step 2: build-persona-pack.cjs (advisory — non-fatal)
			const buildPersonaPackTool = path.join(toolsRoot, "build-persona-pack.cjs");
			if (fs.existsSync(buildPersonaPackTool)) {
				fs.mkdirSync(path.join(cwd, ".forge", "cache"), { recursive: true });
				const personaResult = await runTool(
					buildPersonaPackTool,
					["--out", path.join(cwd, ".forge", "cache", "persona-pack.json")],
					cwd,
					"build-persona-pack",
					30_000,
				);
				if (!personaResult.ok) {
					const msg = personaResult.stderr.trim().split("\n").at(-1) ?? "unknown";
					ctx.ui.notify(`△ forge:materialize — build-persona-pack.cjs failed (non-fatal): ${msg}`, "warning");
				}
			}

			// Step 3: build-context-pack.cjs (advisory — non-fatal)
			const buildContextPackTool = path.join(toolsRoot, "build-context-pack.cjs");
			if (fs.existsSync(buildContextPackTool)) {
				// Read engineering path from config
				let kbPath = "engineering";
				try {
					const raw = fs.readFileSync(configPath, "utf8");
					const cfg = JSON.parse(raw) as Record<string, unknown>;
					const p = cfg.paths as Record<string, unknown> | undefined;
					if (p && typeof p.engineering === "string") kbPath = p.engineering;
				} catch {
					// use default
				}
				const ctxResult = await runTool(
					buildContextPackTool,
					[
						"--arch-dir",
						path.join(cwd, kbPath, "architecture"),
						"--out-md",
						path.join(cwd, ".forge", "cache", "context-pack.md"),
						"--out-json",
						path.join(cwd, ".forge", "cache", "context-pack.json"),
					],
					cwd,
					"build-context-pack",
					30_000,
				);
				if (!ctxResult.ok) {
					const msg = ctxResult.stderr.trim().split("\n").at(-1) ?? "unknown";
					ctx.ui.notify(`△ forge:materialize — build-context-pack.cjs failed (non-fatal): ${msg}`, "warning");
				}
			}

			// Complete
			ctx.ui.setStatus?.("forge:materialize", undefined);
			ctx.ui.notify("〇 forge:materialize complete — gaps filled (mode unchanged)", "info");

			// Promotion hint (mode-neutral: only read, never write)
			try {
				const raw = fs.readFileSync(configPath, "utf8");
				const cfg = JSON.parse(raw) as Record<string, unknown>;
				if ((cfg as Record<string, unknown>).mode === "fast") {
					ctx.ui.notify("〇 To declare the project fully generated: /forge:config mode full", "info");
				}
			} catch {
				// non-fatal — promotion hint is cosmetic
			}
		},
	});
}
