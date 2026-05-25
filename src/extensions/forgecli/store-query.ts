// store-query.ts — native atomic handler for /forge:store-query (FORGE-S23-T10)
//
// Dispatches to store-cli query (flags path) or store-cli nlp (intent path)
// and emits raw stdout via ctx.ui.notify.
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
import { resolveToolDir } from "./store-resolver.js";

const execFileAsync = promisify(execFile);

// ── Usage message ─────────────────────────────────────────────────────────────

const USAGE = `Usage: /forge:store-query <intent or flags>

Examples:
  /forge:store-query open bugs in S12
  /forge:store-query FORGE-BUG-047
  /forge:store-query --sprint FORGE-S12 --status in-progress
  /forge:store-query --keyword auth
  /forge:store-query schema`;

// ── Core runner ──────────────────────────────────────────────────────────────

export interface StoreQueryResult {
	stdout: string;
	ok: boolean;
	errorMessage?: string;
}

/**
 * Run store-cli in query or nlp mode.
 * - Args starting with "--" → query branch: `store-cli query ...flags`
 * - Otherwise → nlp branch: `store-cli nlp "<args>"`
 *
 * Returns raw stdout for display. Does NOT JSON-parse — caller renders as-is.
 * Exported so orchestrators can call directly without going through sendUserMessage.
 */
export async function runStoreQuery(args: string, forgeRoot: string, cwd: string): Promise<StoreQueryResult> {
	const trimmed = args.trim();
	const toolDir = resolveToolDir(forgeRoot);
	const storeCliPath = path.join(toolDir, "store-cli.cjs");

	let argv: string[];
	let timeoutMs: number;

	if (trimmed.startsWith("--")) {
		// Query branch: pass flags verbatim as argv tokens
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		argv = ["query", ...tokens];
		timeoutMs = 10_000;
	} else {
		// NLP branch: pass entire trimmed arg string as single argument
		argv = ["nlp", trimmed];
		timeoutMs = 30_000;
	}

	try {
		const result = await execFileAsync("node", [storeCliPath, ...argv], {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs,
		});
		return { stdout: result.stdout, ok: true };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		// execFile rejects on non-zero exit; stdout may still contain partial results
		const stderr = e.stderr || e.message || String(err);
		const stdout = e.stdout || "";
		return {
			stdout,
			ok: false,
			errorMessage: stderr.slice(0, 500),
		};
	}
}

// ── Register ─────────────────────────────────────────────────────────────────

/**
 * Register /forge:store-query.
 * forgeRoot is nullable — null means we're outside a Forge project.
 */
export function registerStoreQuery(pi: ExtensionAPI, opts: { forgeRoot: string | null }): void {
	pi.registerCommand("forge:store-query", {
		description:
			"Query the Forge store by natural language or exact flags. " +
			"Use flags (--sprint, --task, --keyword) for exact queries; " +
			"use plain text for NLP intent queries.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();

			// Outside-project guard
			if (!opts.forgeRoot) {
				ctx.ui.notify("× forge:store-query — not inside a Forge project. Run /forge:init first.", "error");
				return;
			}

			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(USAGE, "info");
				return;
			}

			ctx.ui.setStatus?.("forge:store-query", "Querying store…");

			const result = await runStoreQuery(trimmed, opts.forgeRoot, cwd);

			ctx.ui.setStatus?.("forge:store-query", undefined);

			if (!result.ok && result.errorMessage) {
				ctx.ui.notify(`× forge:store-query — ${result.errorMessage}`, "error");
				// Still show partial stdout if available
				if (result.stdout.trim()) {
					ctx.ui.notify(result.stdout.trim(), "info");
				}
				return;
			}

			ctx.ui.notify(result.stdout.trim() || "(no results)", "info");
		},
	});
}
