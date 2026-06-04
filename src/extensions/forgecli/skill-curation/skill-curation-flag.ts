// Skill-curation feature flag — FORGE-S24-T12.
//
// Single source of truth for resolving `forgeCli.skillCuration.enabled`
// from the layered config. The four SKILL-CURATION emission modules
// (T08 skill-retriever, T09 skill-usage-tracker, T10 skill-curator-subagent,
// T11 friction-emit) call `isSkillCurationEnabled()` at the top of their
// public emission / dispatch entry points and no-op when it returns false.
//
// Resolution order (first match wins):
//   1. Env override `FORGE_CLI_SKILL_CURATION_ENABLED` — accepts "1"/"true"
//      (case-insensitive) for on, "0"/"false" for off. Provided primarily
//      for unit tests and one-shot operator overrides; takes precedence
//      over disk config so a poisoned config never blocks an operator
//      from turning the flag on or off for a single session.
//   2. Project config (`<cwd>/.pi/forge-cli/config.json`): `forgeCli.skillCuration.enabled`.
//   3. Global config (`~/.pi/forge-cli/config.json`): `forgeCli.skillCuration.enabled`.
//   4. Default: false (Iron Law — gated rollout per FORGE-S24-T12 AC2).
//
// Iron Laws (forge-cli-engineer):
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL2  — TypeScript; no runtime cast. The layered loader has already
//          Ajv-validated the JSON against forge-cli-schema.json before
//          we read it.
//   IL7  — no silent continuation past failures: schema errors at the
//          layered-config level are surfaced by orchestrator and TUI callers
//          upstream of this helper (see doc/decisions/layered-config-error-policy.md).
//          This function only reads `.project`/`.global` layers; its resilience
//          to absent layers is intentional — missing means "no opinion".

import { loadLayeredConfig } from "../config-layer.js";

const ENV_FLAG = "FORGE_CLI_SKILL_CURATION_ENABLED";

/**
 * Parse an env flag value to a tri-state: true / false / null (absent or
 * unrecognised). Unrecognised values fall through to the disk layers — we
 * do NOT throw or coerce to false silently.
 */
function parseEnvFlag(raw: string | undefined): boolean | null {
	if (raw === undefined) return null;
	const normalised = raw.trim().toLowerCase();
	if (normalised === "1" || normalised === "true") return true;
	if (normalised === "0" || normalised === "false") return false;
	return null;
}

/**
 * Resolve the SKILL-CURATION feature flag for the given working directory.
 *
 * Default OFF — the helper returns true only when an explicit `true` value
 * is found in the env override or one of the config layers.
 *
 * `cwd` defaults to `process.cwd()` for production call sites; tests pass
 * a temp dir to isolate filesystem state.
 */
export function isSkillCurationEnabled(cwd: string = process.cwd()): boolean {
	const envValue = parseEnvFlag(process.env[ENV_FLAG]);
	if (envValue !== null) return envValue;

	const layered = loadLayeredConfig(cwd);

	const projectFlag = layered.project?.forgeCli?.skillCuration?.enabled;
	if (typeof projectFlag === "boolean") return projectFlag;

	const globalFlag = layered.global?.forgeCli?.skillCuration?.enabled;
	if (typeof globalFlag === "boolean") return globalFlag;

	return false;
}

// Exposed for unit tests that want to assert env-parsing behaviour
// without touching the disk layers.
export const _internal = { parseEnvFlag, ENV_FLAG };
