// Pi-runtime token telemetry hook — FORGE-S19-T03
//
// Registers a pi.on("message_end") listener that captures per-turn token usage
// from AssistantMessage events. Accumulates usage per phase key and exposes
// flushPhaseUsage() to write sidecars via store-cli record-usage.
//
// Phase key is provided by the caller via the getPhaseKey() option. The sprint
// runner sets FORGE_PHASE_KEY before spawning the pi session; individual
// commands can override with their own getPhaseKey implementation.
//
// Non-blocking contract:
//   - Non-assistant messages (user, toolResult) are silently skipped.
//   - Missing/malformed usage field on an assistant message → treated as zeros.
//   - subprocess failure in flushPhaseUsage → stderr warn, no throw.
//
// Iron Law 6 compliance: spawnSync is called with an argv array — no shell
// string interpolation anywhere in this module.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@entelligentsia/pi-coding-agent";

// MessageEndEvent is not re-exported from the pi-coding-agent main package index
// (confirmed against @entelligentsia/pi-coding-agent@0.74.0 dist/index.d.ts).
// Use a local structural type for the message_end event — keeps us type-safe
// without relying on a deep import (blocked by moduleResolution: NodeNext).
interface LocalMessageEndEvent {
	type: "message_end";
	message: unknown;
}

// ── Public types ──────────────────────────────────────────────────────────────

/** Per-phase accumulated token totals. */
export interface UsageAccumulator {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	estimatedCostUSD: number;
	/** Last model identifier seen in this phase. */
	model: string;
	/** Number of assistant turns accumulated. */
	turnCount: number;
}

/** Options for registerUsageHook. */
export interface UsageHookOptions {
	/**
	 * Returns the current phase key. Called on every message_end event.
	 * Defaults to reading FORGE_PHASE_KEY env var, falling back to "default".
	 */
	getPhaseKey?: () => string;
}

/** Options for flushPhaseUsage. */
export interface FlushOptions {
	/** Sprint ID (e.g. "FORGE-S19"). */
	sprintId: string;
	/** Event ID for the sidecar (e.g. "20260509T080000000Z_FORGE-S19-T03_engineer_plan"). */
	eventId: string;
	/** Phase key to flush from the accumulator. */
	phaseKey: string;
	/** Absolute path to the forge plugin root (for store-cli.cjs location). */
	forgeRoot: string;
	/** The accumulator map returned by registerUsageHook. */
	accumulator: Map<string, UsageAccumulator>;
	/** Called after a successful flush. Optional notification hook. */
	onFlush?: (phaseKey: string, usage: UsageAccumulator) => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function defaultGetPhaseKey(): string {
	return process.env.FORGE_PHASE_KEY ?? "default";
}

function safeNumber(val: unknown): number {
	if (typeof val === "number" && Number.isFinite(val)) return val;
	return 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a message_end listener on `pi` that accumulates per-turn token usage.
 *
 * @returns The accumulator map (keyed by phase key). Pass this to flushPhaseUsage.
 */
export function registerUsageHook(pi: ExtensionAPI, options: UsageHookOptions = {}): Map<string, UsageAccumulator> {
	const getPhaseKey = options.getPhaseKey ?? defaultGetPhaseKey;
	const accumulator = new Map<string, UsageAccumulator>();

	pi.on("message_end", (event: LocalMessageEndEvent): void => {
		const msg = event.message as { role?: string; model?: string; usage?: unknown };

		// Only assistant messages carry token usage.
		if (msg.role !== "assistant") return;

		const usage = msg.usage as
			| {
					input?: unknown;
					output?: unknown;
					cacheRead?: unknown;
					cacheWrite?: unknown;
					cost?: { total?: unknown };
			  }
			| undefined;

		const input = safeNumber(usage?.input);
		const output = safeNumber(usage?.output);
		const cacheRead = safeNumber(usage?.cacheRead);
		const cacheWrite = safeNumber(usage?.cacheWrite);
		const costTotal = safeNumber(usage?.cost?.total);
		const model = typeof msg.model === "string" ? msg.model : "unknown";

		const phaseKey = getPhaseKey();
		const existing = accumulator.get(phaseKey);

		if (existing) {
			existing.inputTokens += input;
			existing.outputTokens += output;
			existing.cacheReadTokens += cacheRead;
			existing.cacheWriteTokens += cacheWrite;
			existing.estimatedCostUSD += costTotal;
			existing.model = model; // use last model seen
			existing.turnCount += 1;
		} else {
			accumulator.set(phaseKey, {
				inputTokens: input,
				outputTokens: output,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite,
				estimatedCostUSD: costTotal,
				model,
				turnCount: 1,
			});
		}
	});

	return accumulator;
}

/**
 * Flush accumulated usage for `phaseKey` to store-cli record-usage.
 *
 * Non-blocking: if the subprocess exits non-zero, emits a warn line to
 * stderr and returns normally. Never throws.
 */
export function flushPhaseUsage(opts: FlushOptions): void {
	const { sprintId, eventId, phaseKey, forgeRoot, accumulator } = opts;
	const acc = accumulator.get(phaseKey);

	if (!acc) {
		process.stderr.write(`[warn] usage hook: no accumulated data for phase key "${phaseKey}" — skipping flush\n`);
		return;
	}

	const storeCli = path.join(forgeRoot, "tools", "store-cli.cjs");

	// Iron Law 6: argv array — no shell-string interpolation.
	const argv = [
		storeCli,
		"record-usage",
		sprintId,
		eventId,
		"--input-tokens",
		String(acc.inputTokens),
		"--output-tokens",
		String(acc.outputTokens),
		"--cache-read-tokens",
		String(acc.cacheReadTokens),
		"--cache-write-tokens",
		String(acc.cacheWriteTokens),
		"--estimated-cost-usd",
		String(acc.estimatedCostUSD),
		"--token-source",
		"reported",
		"--model",
		acc.model,
	];

	const result = spawnSync(process.execPath, argv, {
		cwd: process.cwd(),
		stdio: "pipe",
	});

	if (result.status !== 0) {
		const errText = result.stderr ? String(result.stderr).trim() : "(no stderr)";
		process.stderr.write(
			`[warn] usage hook: record-usage exited ${result.status ?? "null"} for phase "${phaseKey}" — ${errText}\n`,
		);
		return;
	}

	if (opts.onFlush) {
		opts.onFlush(phaseKey, acc);
	}
}
