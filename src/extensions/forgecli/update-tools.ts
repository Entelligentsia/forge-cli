// update-tools.ts — native atomic handler for /forge:update-tools (FORGE-S23-T10)
//
// Copies all JSON schema files from the bundled forge payload (.schemas/) to
// the project's .forge/schemas/, then runs validate-store --dry-run to verify.
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
import { getBundledPayloadRoot, getBundledToolsRoot } from "./forge-init.js";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

export interface UpdateToolsResult {
	copied: number;
	skipped: number;
	validationPassed: boolean;
	messages: string[];
}

// ── Core runner ──────────────────────────────────────────────────────────────

/**
 * Copy all *.json from bundled .schemas/ to .forge/schemas/ in cwd.
 * Runs validate-store --dry-run after copy.
 * Exported so orchestrators can call directly without going through sendUserMessage.
 */
export async function runUpdateTools(
	cwd: string,
	opts: { _testBundleRoot?: string; _testToolsRoot?: string } = {},
): Promise<UpdateToolsResult> {
	const messages: string[] = [];
	let bundleRoot: string;
	let toolsRoot: string;

	try {
		bundleRoot = opts._testBundleRoot ?? getBundledPayloadRoot();
		toolsRoot = opts._testToolsRoot ?? getBundledToolsRoot();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			copied: 0,
			skipped: 0,
			validationPassed: false,
			messages: [`× forge:update-tools — could not resolve bundle root: ${msg}`],
		};
	}

	// Source: bundled .schemas/ directory
	const schemasSrc = path.join(bundleRoot, ".schemas");
	if (!fs.existsSync(schemasSrc)) {
		return {
			copied: 0,
			skipped: 0,
			validationPassed: false,
			messages: [`× forge:update-tools — bundled schemas directory not found: ${schemasSrc}`],
		};
	}

	// Destination: .forge/schemas/ in the project
	const schemasDest = path.join(cwd, ".forge", "schemas");
	fs.mkdirSync(schemasDest, { recursive: true });

	// Copy all *.json files
	let copied = 0;
	let skipped = 0;
	let schemaFiles: string[];
	try {
		schemaFiles = fs.readdirSync(schemasSrc).filter((f) => f.endsWith(".json"));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			copied: 0,
			skipped: 0,
			validationPassed: false,
			messages: [`× forge:update-tools — could not read schemas directory: ${msg}`],
		};
	}

	for (const file of schemaFiles) {
		const srcPath = path.join(schemasSrc, file);
		const destPath = path.join(schemasDest, file);
		// src and dest are always different directories; structural skip-if-equal
		// is impossible in production but tested via mocks per AC requirement.
		if (srcPath === destPath) {
			skipped++;
			continue;
		}
		try {
			await fs.promises.copyFile(srcPath, destPath);
			copied++;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			messages.push(`△ forge:update-tools — could not copy ${file}: ${msg}`);
		}
	}

	messages.push(`〇 forge:update-tools — copied ${copied} schema file(s) to .forge/schemas/.`);
	if (skipped > 0) {
		messages.push(`  (${skipped} file(s) skipped — source equals destination)`);
	}

	// Run validate-store --dry-run
	const validateStorePath = path.join(toolsRoot, "validate-store.cjs");
	let validationPassed = false;
	try {
		await execFileAsync("node", [validateStorePath, "--dry-run"], {
			cwd,
			encoding: "utf8",
			timeout: 15_000,
		});
		validationPassed = true;
		messages.push("〇 Schemas updated and store validation passed.");
	} catch (err: unknown) {
		const e = err as { stderr?: string; stdout?: string; message?: string };
		const detail = e.stderr || e.stdout || e.message || String(err);
		messages.push(`× Validation failed — ${detail.slice(0, 300)}`);
	}

	return { copied, skipped, validationPassed, messages };
}

// ── Register ─────────────────────────────────────────────────────────────────

export interface RegisterUpdateToolsOptions {
	/** Override bundle root — for testing only. */
	_testBundleRoot?: string;
	/** Override tools root — for testing only. */
	_testToolsRoot?: string;
}

export function registerUpdateTools(pi: ExtensionAPI, opts: RegisterUpdateToolsOptions = {}): void {
	pi.registerCommand("forge:update-tools", {
		description:
			"Refresh .forge/schemas/ from the installed Forge plugin version. " +
			"Copies all JSON schema files from the bundled payload to your project.",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();

			// Outside-project guard
			const configPath = path.join(cwd, ".forge", "config.json");
			if (!fs.existsSync(configPath)) {
				ctx.ui.notify("× forge:update-tools — no .forge/config.json found. " + "Run /forge:init first.", "error");
				return;
			}

			ctx.ui.setStatus?.("forge:update-tools", "Copying schemas…");

			const result = await runUpdateTools(cwd, {
				_testBundleRoot: opts._testBundleRoot,
				_testToolsRoot: opts._testToolsRoot,
			});

			ctx.ui.setStatus?.("forge:update-tools", undefined);

			for (const msg of result.messages) {
				const severity = msg.startsWith("×") ? "error" : msg.startsWith("△") ? "warning" : "info";
				ctx.ui.notify(msg, severity);
			}
		},
	});
}
