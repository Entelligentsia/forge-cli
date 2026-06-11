// forge reset — FEAT-009 (halt-recovery UX): deterministic pipeline-state reset.
//
// `4ge reset <id> --to <phase> [--kind task|bug]` rewinds a halted/blocked
// run-task or fix-bug pipeline so it can be resumed from a chosen phase. It
// force-transitions the entity to the phase's pre-status and rewrites the
// resume-state cache — encapsulating the manual recovery (force update-status +
// hand-edit of .forge/cache/*-state.json) into one guarded command.
//
// Sprint reset is intentionally NOT offered here: it is a cross-entity,
// referential-integrity-sensitive cascade routed to the LLM-backed
// /forge:reset (FEAT-009 T03).
//
// Structural convention mirrors uninstall.ts / init.ts:
//   - parseResetArgs(args): pure arg parser
//   - runReset(args, opts?): entry point, returns exit code
//
// Iron-Law boundary (IL6): the underlying reset spawns store-cli via an argv
// array (no shell-string interpolation).

import * as fs from "node:fs";
import * as path from "node:path";

import {
	type ResetEntityKind,
	type ResetPipelineResult,
	resetPipelineState,
} from "../extensions/forgecli/orchestrators/common/reset-pipeline.js";

const USAGE =
	"Usage: 4ge reset <id> --to <phase> [--kind task|bug]\n" +
	"  <id>          task id (FORGE-S32-T03) or bug id (FORGE-BUG-046)\n" +
	"  --to <phase>  phase to rewind to:\n" +
	"                  task: plan | review-plan | implement | review-code | validate | approve | writeback | commit\n" +
	"                  bug:  triage | plan-fix | review-plan | implement | review-code | approve | commit\n" +
	"  --kind        force entity kind (default: inferred from the id)";

export interface ResetArgs {
	id: string;
	toPhase: string;
	kind: ResetEntityKind;
}

export interface ResetArgsError {
	error: string;
}

/** Infer entity kind from an id: a `-BUG-` segment ⇒ bug, otherwise task. */
export function inferKind(id: string): ResetEntityKind {
	return /-BUG-/i.test(id) ? "bug" : "task";
}

/**
 * Parse subcommand args for `4ge reset`. Pure (no IO).
 *
 *   4ge reset FORGE-S32-T03 --to implement
 *   4ge reset FORGE-BUG-046 --to triage
 *   4ge reset X-1 --to implement --kind bug
 */
export function parseResetArgs(args: readonly string[]): ResetArgs | ResetArgsError {
	let id: string | undefined;
	let toPhase: string | undefined;
	let kind: ResetEntityKind | undefined;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--to" || a === "-t") {
			toPhase = args[++i];
		} else if (a === "--kind" || a === "-k") {
			const v = args[++i];
			if (v !== "task" && v !== "bug") {
				return { error: `forge reset: --kind must be 'task' or 'bug', got '${v ?? ""}'.\n${USAGE}` };
			}
			kind = v;
		} else if (a.startsWith("-")) {
			return { error: `forge reset: unknown flag '${a}'.\n${USAGE}` };
		} else if (!id) {
			id = a;
		} else {
			return { error: `forge reset: unexpected argument '${a}'.\n${USAGE}` };
		}
	}

	if (!id) return { error: `forge reset: <id> required.\n${USAGE}` };
	if (!toPhase) return { error: `forge reset: --to <phase> required.\n${USAGE}` };

	return { id, toPhase, kind: kind ?? inferKind(id) };
}

export interface RunResetOptions {
	/** Project working directory (default: process.cwd()). */
	cwd?: string;
	/** stdout sink (default: console.log). */
	print?: (s: string) => void;
	/** stderr sink (default: console.error). */
	printErr?: (s: string) => void;
	/** Override the reset implementation (tests). */
	reset?: (params: {
		kind: ResetEntityKind;
		cwd: string;
		id: string;
		toPhase: string;
		storeCli: string;
	}) => ResetPipelineResult;
}

/**
 * Entry point for `4ge reset`. Returns a process exit code (0 ok, 1 error).
 */
export function runReset(args: readonly string[], opts: RunResetOptions = {}): number {
	const cwd = opts.cwd ?? process.cwd();
	const print = opts.print ?? ((s: string) => console.log(s));
	const printErr = opts.printErr ?? ((s: string) => console.error(s));
	const reset = opts.reset ?? resetPipelineState;

	const parsed = parseResetArgs(args);
	if ("error" in parsed) {
		printErr(parsed.error);
		return 1;
	}

	const storeCli = path.join(cwd, ".forge", "tools", "store-cli.cjs");
	if (!fs.existsSync(storeCli)) {
		printErr(
			`forge reset: no Forge project here — ${storeCli} not found.\n` +
				"Run this from a project bootstrapped with `4ge init claude .`.",
		);
		return 1;
	}

	const result = reset({ kind: parsed.kind, cwd, id: parsed.id, toPhase: parsed.toPhase, storeCli });

	if (!result.ok) {
		printErr(`× forge reset — ${result.detail ?? "failed"}`);
		return 1;
	}

	const resumeCmd = parsed.kind === "bug" ? `/forge:fix-bug ${parsed.id}` : `/forge:run-task ${parsed.id}`;
	print(
		`〇 forge reset — ${parsed.id} rewound to '${result.role}' ` +
			`(status → ${result.preStatus}, phase ${result.phaseIndex}).\n` +
			`  Resume with: ${resumeCmd}`,
	);
	return 0;
}
