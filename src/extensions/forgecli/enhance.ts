// forge:enhance — Phase-2 native kickoff handler (FORGE-S20-T04).
//
// Replaces the post-S17 sentinel-writing stub registered in forge-commands.ts.
// The handler is a thin kickoff shim per Pack-04 + Pack-06:
//   1. Reads `.forge/workflows/enhance.md` (the materialized workflow).
//   2. Verifies four Pack-06 materialization markers — refuses to dispatch on
//      regression and emits a per-marker `ctx.ui.notify` so a user sees the
//      cause.
//   3. Loads the persona declared in the workflow's `deps.personas:`
//      frontmatter via the FORGE-S20-T02 loader (no ad-hoc fs.readFile of
//      `.forge/personas/`).
//   4. Composes ONE kickoff message: persona identity, phase-specific
//      dispatch instruction, the workflow body verbatim, and any free-form
//      argv tail.
//   5. Hands control to the LLM via `sendKickoff(pi, text)` —
//      `deliverAs: "steer"`. Never raw `pi.sendUserMessage`.
//
// Phase 2 (default) directs the LLM to read friction events ONLY through
// `forge_store_query` (Pack-06 Read/Write/Ask/Store discipline) and to write
// proposals to `engineering/enhancement-proposals/phase2-<timestamp>.md`. If
// zero friction events exist, the LLM emits a notice and writes no file.
//
// Phases 1 and 3 are forwarded with the workflow's own dispatch text.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL4 — no JSON.stringify-into-subagent dispatch.
//   IL6 — no shell-string interpolation; no spawn calls here.
//   IL7 — every failure path emits ctx.ui.notify and returns; no silent
//         continuation.

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { assertAudience } from "./audience-gate.js";
import { sendKickoff } from "./kickoff.js";
// FORGE-S25-T16: extracted to lib modules (H-1, H-2). Re-exported here for
// backward compatibility with existing test and consumer imports.
import { extractPersonaNames } from "./lib/frontmatter-parser.js";
import { loadPersona, PersonaSkillLoaderError } from "./parsers/persona-skill-loader.js";
import { loadWorkflow, WorkflowLoaderError } from "./parsers/workflow-loader.js";

export { extractPersonaNames };

import { checkMaterialization, type MaterializationCheck } from "./lib/manifest-checker.js";

export { checkMaterialization, type MaterializationCheck };

// Argv parsing -------------------------------------------------------------

export type EnhancePhase = 1 | 2 | 3;

export interface ParsedArgs {
	phase: EnhancePhase;
	extra: string;
	rawPhaseFlag: string;
}

const VALID_PHASES: ReadonlySet<EnhancePhase> = new Set<EnhancePhase>([1, 2, 3]);

export function parseEnhanceArgs(rawArgs: string): ParsedArgs {
	const trimmed = (rawArgs ?? "").trim();
	if (trimmed === "") {
		return { phase: 2, extra: "", rawPhaseFlag: "" };
	}

	const tokens = trimmed.split(/\s+/);
	let phase: EnhancePhase = 2;
	let rawPhaseFlag = "";
	const tail: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "--auto") {
			phase = 1;
			rawPhaseFlag = "--auto";
			continue;
		}
		if (tok === "--phase") {
			const next = tokens[i + 1];
			if (next === undefined) {
				throw new Error("invalid --phase value: missing argument");
			}
			const n = Number(next);
			if (!Number.isInteger(n) || !VALID_PHASES.has(n as EnhancePhase)) {
				throw new Error(`invalid --phase value: ${JSON.stringify(next)} (expected 1, 2, or 3)`);
			}
			phase = n as EnhancePhase;
			rawPhaseFlag = `--phase ${next}`;
			i += 1;
			continue;
		}
		const eqMatch = /^--phase=(.+)$/.exec(tok);
		if (eqMatch) {
			const n = Number(eqMatch[1]);
			if (!Number.isInteger(n) || !VALID_PHASES.has(n as EnhancePhase)) {
				throw new Error(`invalid --phase value: ${JSON.stringify(eqMatch[1])} (expected 1, 2, or 3)`);
			}
			phase = n as EnhancePhase;
			rawPhaseFlag = tok;
			continue;
		}
		tail.push(tok);
	}

	return { phase, extra: tail.join(" "), rawPhaseFlag };
}

// Kickoff composition ------------------------------------------------------

export interface ComposeKickoffOpts {
	workflowMd: string;
	personaIdentity: string;
	parsed: ParsedArgs;
	cwd: string;
	timestamp: string;
}

export function composeKickoff(opts: ComposeKickoffOpts): string {
	const { workflowMd, personaIdentity, parsed, timestamp } = opts;

	const sections: string[] = [`# /forge:enhance --phase ${parsed.phase}`, ""];
	if (personaIdentity.trim().length > 0) {
		sections.push(personaIdentity.trim(), "");
	}

	if (parsed.phase === 2) {
		const proposalRel = path.posix.join("engineering", "enhancement-proposals", `phase2-${timestamp}.md`);
		sections.push(
			"## Dispatch — Phase 2 (post-sprint propose-diffs)",
			"",
			"Run the workflow below. Specifically:",
			"",
			"1. Discover friction events. **Preferred**: `forge_store_query` with `{command:'nlp', args:['events where type=friction']}`. **If that returns zero or a suspiciously low count** (the underlying NLP engine uses keyword heuristics that can miss events), **fall back to the workflow body's filesystem walk** (`meta-enhance.md` Step 1's JS one-liner: read `.forge/store/events/**/*.json`, filter `e => e && e.type === 'friction'`). The fs-walk filter is the source of truth on `type`; the MCP query is a convenience layer over it. Use whichever surfaces the events.",
			`2. If at least one friction event is present (from either path), synthesize concrete enrichment proposals per the workflow's Phase 2 algorithm, then write them via the \`write\` tool to \`${proposalRel}\` (one section per proposed change, with a fenced diff block showing before/after).`,
			"3. If genuinely zero friction events are present (both the MCP query AND the fs-walk return empty), emit an explicit notice — `〇 no friction events present — Phase 2 produces no proposals` — and write NO proposal file. Empty artifacts are not acceptable.",
			"4. Honour the Pack-06 Read/Write/Ask/Store discipline: store writes go via the `forge_store` MCP tool with `{command:'write', args:['<entity>','<json>']}` (2-positional, id INSIDE json); never raw-write `.forge/store/`. Do NOT bash-shell `forge store ...`.",
			"5. **VERIFY after apply — MANDATORY (forge-cli#31)**: After applying enhancement edits via Edit/Write, BEFORE calling add-snapshot, you MUST call `forge_verify_apply` with the list of claimed file paths. The tool runs `generation-manifest check` on each and returns four buckets: `modified` (verified ✓), `unchanged` (your Edit silently no-op'd — usually an `old_string` whitespace/punctuation mismatch), `untracked` (no manifest entry — treat as potentially modified), `missing` (file gone). **If `unchanged.length > 0`**, you MUST re-apply those edits via Edit/Write and call `forge_verify_apply` again — repeat until `unchanged` is empty. **Do NOT proceed to add-snapshot until every claimed file is in `modified` or `untracked`.** This guard exists because agents historically claim 'Files Modified' in their UI reports while the actual disk content is unchanged; without it the next `/forge:regenerate` overwrites stale state and replay restores nothing.",
			'6. **Snapshot after verify (forge#107 / forge-cli#30)**: Once `forge_verify_apply` reports no `unchanged` files, MUST call `manage-versions add-snapshot` via bash to capture the verified edits into `.forge/archive/snap-N/`. Without this, the next `/forge:regenerate` cannot restore via replay. Format:\n   ```sh\n   node "$FORGE_ROOT/tools/manage-versions.cjs" add-snapshot --source post-sprint:<SPRINT_ID> --enhanced-elements "<comma-separated paths, e.g. .forge/personas/architect.md,.forge/skills/engineer-skills.md>"\n   ```\n   `$FORGE_ROOT` is exported into the bash environment — see the orientation block above for its resolved value. After add-snapshot, verify success by checking `.forge/structure-versions.json`\'s `currentSnapshot` advanced and `ls .forge/archive/snap-N/` is non-empty.',
		);
	} else if (parsed.phase === 1) {
		sections.push(
			"## Dispatch — Phase 1 (post-init auto-apply placeholder fills)",
			"",
			"Run the workflow's Phase 1 algorithm verbatim. Apply only high-confidence placeholder fills; list low-confidence keys without substituting.",
		);
	} else {
		sections.push(
			"## Dispatch — Phase 3 (drift detection)",
			"",
			"Run the workflow's Phase 3 algorithm verbatim. Compare codebase state against structural-element knowledge and write the drift report to `.forge/enhancement-proposals/phase3-<timestamp>.md`.",
		);
	}

	sections.push("", "---", "", "## Workflow", "", workflowMd.trim(), "", "---");

	if (parsed.extra.trim().length > 0) {
		sections.push("", "## Additional context", "", parsed.extra.trim());
	}

	return sections.join("\n");
}

// Timestamp helper ---------------------------------------------------------

export function defaultNow(): Date {
	return new Date();
}

export function formatTimestamp(d: Date): string {
	const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		"T" +
		`${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
	);
}

// Registration -------------------------------------------------------------

const WORKFLOW_REL_PATH = path.join(".forge", "workflows", "enhance.md");

export interface RegisterEnhanceOptions {
	cwd?: string;
	now?: () => Date;
}

export function registerEnhance(pi: ExtensionAPI, options: RegisterEnhanceOptions = {}): void {
	pi.registerCommand("forge:enhance", {
		description:
			"Progressive project-specific enrichment of structural elements. " +
			"Usage: /forge:enhance [--phase 1|2|3 | --auto] [free-form context]. " +
			"Default phase: 2 (post-sprint propose-diffs).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const workflowPath = path.join(cwd, WORKFLOW_REL_PATH);

			let workflowMd: string;
			let workflowAudience: import("./parsers/workflow-loader.js").AudienceValue;
			try {
				const loaded = loadWorkflow(workflowPath);
				workflowMd = loaded.rawMarkdown;
				workflowAudience = loaded.audience;
			} catch (err: unknown) {
				if (err instanceof WorkflowLoaderError) {
					if (err.code === "missing_file") {
						ctx.ui.notify(
							`× forge:enhance — workflow not found at ${WORKFLOW_REL_PATH}; run /forge:init or /forge:rebuild first.`,
							"error",
						);
					} else {
						ctx.ui.notify(`× forge:enhance — workflow load failed (${err.code}): ${err.message}`, "error");
					}
					return;
				}
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:enhance — failed to read workflow: ${e.message ?? "unknown"}`, "error");
				return;
			}

			let parsed: ParsedArgs;
			try {
				parsed = parseEnhanceArgs(args);
			} catch (err: unknown) {
				const e = err as { message?: string };
				ctx.ui.notify(`× forge:enhance — ${e.message ?? "argv parse failed"}`, "error");
				return;
			}

			const check = checkMaterialization(workflowPath, workflowMd);
			if (!check.ok) {
				for (const marker of check.missing) {
					ctx.ui.notify(`× workflow regression: ${marker} not found in ${workflowPath}`, "error");
				}
				return;
			}

			const personas = extractPersonaNames(workflowMd);
			let personaIdentity = "";
			if (personas.length > 0) {
				try {
					const persona = loadPersona(personas[0], { cwd });
					personaIdentity = persona.identity;
				} catch (err: unknown) {
					if (err instanceof PersonaSkillLoaderError) {
						ctx.ui.notify(
							`× forge:enhance — persona '${personas[0]}' load failed (${err.code}): ${err.message}`,
							"error",
						);
						return;
					}
					const e = err as { message?: string };
					ctx.ui.notify(`× forge:enhance — persona load error: ${e.message ?? "unknown"}`, "error");
					return;
				}
			}

			if (!assertAudience({ workflowName: "enhance", audience: workflowAudience }, ctx)) {
				return;
			}

			const now = options.now ?? defaultNow;
			const timestamp = formatTimestamp(now());

			const kickoff = composeKickoff({
				workflowMd,
				personaIdentity,
				parsed,
				cwd,
				timestamp,
			});

			sendKickoff(pi, kickoff);
		},
	});
}
