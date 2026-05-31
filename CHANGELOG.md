# Changelog

All notable changes to `@entelligentsia/forgecli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.10] — 2026-05-31

Coordinated release matching forge plugin **v1.0.10** (the issue #111
artifact-resolution line). Versions 1.0.4–1.0.9 are intentionally skipped so the
CLI version tracks the plugin version it bundles. No `npm publish` happened
between 1.0.3 and this release; the items below are the net delta since the
published 1.0.3.

### Fixed

- **`forge.bundledVersion` corrected `0.51.1` → `1.0.10`.** This field is the
  bundled-plugin version surfaced by `forge --version` (`forge-plugin@…`), the
  `/forge:init` banner (`Bundle: forge v…`), and—critically—the session-start
  **version-drift detector** (`hooks/check-update.ts`). The stale `0.51.1` value
  made drift detection compare installed projects against the wrong baseline;
  it now reflects the plugin actually bundled.
- **`build-payload`** now bundles `artifact-store.cjs` (issue #111 Phase 3
  runtime dependency that was missing from the payload).
- **`phase-guard`** task-mode `set-summary` uses the TASK key-map instead of the
  bug-mode map (backlog A).

### Added

- **`forge_artifact` verb parity with the plugin (issue #111 Phase 2–3).**
  `exists`, `url`, and `delete` verbs added in lockstep with the plugin's
  `artifact.cjs`; the artifact-kind list is now derived from the plugin's
  `artifact-kinds.cjs` registry (bundled) rather than hard-coded.

### Changed

- **vendor-pi bumped to upstream `0.78.0`** (weekly sync).
- **`forge_store` docs:** `set-summary` / `set-bug-summary` `jsonFile` is optional
  (auto-resolved from `record.path`).

### Tests

- **Test suite aligned with the v1.0 command surface (FORGE-S26).** 35 tests
  asserted the pre-v1.0 command set (removed `calibrate`/`materialize`/`migrate`/
  `update-tools`; renames `store-query`→`search`, `store-repair`→`repair`,
  `quiz-agent`→`check-agent`, `retrospective`→`retro`; `enhance` removed). Triage
  confirmed all were stale assertions, one width-truncation test bug, or an
  auth-gated live test — no production regressions. Fix was test-only. All four
  CI gates green (typecheck, no-skip lint, vitest, knip).

## [1.0.3] — 2026-05-28

### Fixed

- **FORGE-BUG-040 (critical) — `/forge:fix-bug` triage subagent received the orchestrator-only `fix_bug.md` body and executed the full bug lifecycle in one phase.** `BUG_PHASES` wiring corrected: `triage → triage`, `plan-fix → plan_task`, `implement → implement_plan` (previously all three pointed at `fix_bug`). The compensating materialization-skip wrapper and audience-bypass clause are deleted; the audience gate now runs uniformly for every BUG phase. Pairs with plugin v1.0.3 (coordinated release). Closes Entelligentsia/forge#110.

### Added

- `subagent/phase-guard.ts` — tool-boundary phase-ownership enforcement (`assertPhaseOwnership`, `assertBugStatusOwnership`, `assertOrchestratorOnlyEmit`, `PhaseOwnershipError`). Wired into `forge_preflight` and the four bug-mutating `forge_store` verbs (`set-bug-summary`, `set-summary`, `update-status bug`, `emit`). Subagent callers attempting cross-phase calls are rejected with a structured error; orchestrator callers are unaffected.
- `subagent/phase-summary-map.ts` — single-source `BUG_SUMMARY_KEY_BY_ROLE` (hoisted out of `fix-bug.ts` to break a `forge-tools → phase-guard → fix-bug → forge-tools` circular import). `fix-bug.ts` re-exports for backwards compatibility.
- `@entelligentsia/forge-compress` integration (pre-approved separate work bundled in this release) — `compressWithTelemetry` wraps `forge_store` read/list, `forge_validate_store`, and `forge_store_query` results; `cumCompression` surfaced in phase summaries.

### Changed

- `CallerContext` extended from string union to discriminated union: `{ kind: "orchestrator" } | { kind: "subagent"; phase: PhaseRole }`. `CallerContextStore.asSubagent(phase, fn)` requires a `PhaseRole` argument — this is now the single setter of phase context for any subagent dispatch.
- `fix-bug.ts` and `run-task.ts` phase loops wrap `runForgeSubagent(...)` in `CallerContextStore.asSubagent(phase.role, ...)`. Task-mode pipelines are protected against the same defect class.
- `composeBugBody` triage hint trimmed — route-field requirement and Path A/B criteria now live natively in `triage.md`.
- **Per-iteration subagent transcripts (FORGE-BUG-040 follow-up).** The per-subagent transcript filename now carries an ISO-compact timestamp prefix (`<ISO>__<entity>__<phase>.json`) so successive dispatches of the same phase during review loops (`plan → review → plan → review`) all persist instead of overwriting. Directory listings sort chronologically by default. Payload schema gains `startedAt` + `finishedAt` (replacing the prior single `timestamp` field).

### Added (additional)

- **Orchestrator transcript (FORGE-BUG-040 follow-up).** New JSONL log per pipeline run capturing `pipeline-start`, `phase-start`, `phase-end`, `phase-loopback`, `pipeline-end` events plus every `ctx.ui.notify` line teed from the orchestrator. Written to `.forge/transcripts/<entity>/<ISO>__<entity>__orchestrator.jsonl`. Wired into both `runBugPipeline` (`fix-bug.ts`) and `runTaskPipeline` (`run-task.ts`) with a `try/finally` so the notify wrapper is always restored. New module: `subagent/orchestrator-transcript.ts` (`OrchestratorTranscriptWriter` class + `OrchestratorEvent` discriminated union).

## [1.0.0] — 2026-05-26

### Breaking Changes

- **v1.0 CLI command surface (FORGE-S26-T10):** 7 command renames + 6 command removals matching plugin v1.0.0.
  Old command names emit deprecation notices and redirect to the new names.
  - Renamed: `forge:sprint-intake` → `forge:new-sprint`, `forge:sprint-plan` → `forge:plan-sprint`, `forge:retrospective` → `forge:retro`, `forge:regenerate` → `forge:rebuild`, `forge:store-query` → `forge:search`, `forge:store-repair` → `forge:repair`, `forge:quiz-agent` → `forge:check-agent`
  - Removed (stubs): `forge:update-tools`, `forge:materialize`, `forge:enhance`, `forge:calibrate`, `forge:migrate`
- **Bundled forge plugin updated to v1.0.0.**

### Added

- **Pipeline step guards (FORGE-S26-T11):** pre-flight guards visible in `run-task`/`run-sprint`, mirrors plugin T06
- **Revision loop visibility (FORGE-S26-T11):** iteration counter in phase announcements, mirrors plugin T07
- **`/forge:status`** — re-exported from bundled plugin payload (mirrors plugin T09)
- **Plugin ↔ CLI parity gate (FORGE-S26-T12):** bidirectional command surface parity check (`test/extensions/forgecli/parity-gate.test.ts`) wired into CI

### Changed

- All 20 bundled command `.md` files now have explicit handlers or deprecation stubs; auto-stub loop registers 0 commands (all slots in `EXPLICITLY_REGISTERED_NAMES`)

## [0.21.0] — 2026-05-26

### Added

- **Task.summaries carry-forward between phases (forge-cli#19).** Each
  downstream phase in `/forge:run-task` and `/forge:fix-bug` now receives a
  compact "Prior phase summaries" block in its prompt, built from
  `task.summaries` written by earlier phases. Gives downstream personas
  the gist (objective, verdict, key changes, artifact ref) before they
  decide whether to re-read full artifacts from disk. Verified: review
  phases skip artifact re-reads entirely when summaries are sufficient.
- **carry_forward_injected debug log entry.** Logs the full summaries
  block to the per-task debug JSONL for observability and verification.

### Changed

- Bundled forge-plugin updated to v0.51.4 (meta-enhance rejections sidecar
  path fix, update.md config refresh fix, manage-config backfill).

## [0.20.3] — 2026-05-25

### Fixed

- **update.md Row 1: config refresh always runs.** Row 1 ("up to date, no
  pending migrations") previously said "exit" — causing the agent to skip
  Step 4 entirely, including the config refresh (forgeRoot, forgeRef,
  backfill). Missing config fields accumulate across version boundaries;
  backfill ensures the config stays structurally complete after every
  `/forge:update` invocation. Row 1 now executes Step 4 config refresh
  before proceeding to Step 5.

## [0.20.2] — 2026-05-25

### Added

- **`manage-config backfill` subcommand** — schema-validated config field backfill.
  Reads `$FORGE_ROOT/schemas/config.schema.json`, compares against current
  `.forge/config.json`, and writes defaults for any missing fields with
  schema-defined defaults. Also stamps the top-level `version` field from
  the bundled plugin version. Supports `--dry-run` for preview.
  Fixes the root cause of `/forge:health` config-incompleteness findings:
  the update flow now deterministically backfills missing config fields
  instead of relying on the LLM agent to compose them manually.

### Changed

- **update.md Step 4** — calls `manage-config backfill` after writing
  `paths.forgeRoot`/`paths.forgeRef`, ensuring all schema-required and
  schema-defaulted fields are present after every update.
- **forge-init Phase 4** — now writes `paths.forgeRef` (FR-010) and calls
  `manage-config backfill` after `paths.forgeRoot`, ensuring fresh inits
  also have complete config fields.
- **`parseArgs` in manage-config.cjs** — boolean flags (e.g. `--dry-run`)
  without a following value are now treated as `true` instead of being
  silently dropped.

## [0.20.1] — 2026-05-25

### Fixed

- **build-payload: expand schemas/ (dotless) to mirror full forge/forge/schemas/.**
  Previously only structure-manifest.json was copied to the dotless schemas/
  dir. Plugin command files (health.md, etc.) that reference
  `$FORGE_ROOT/schemas/config.schema.json` at runtime couldn't find it — the
  file only existed in `.schemas/` (dotted). The build now recursively copies
  all `.json` files from forge/forge/schemas/ into schemas/ (skipping
  `__tests__`), including enum-catalog.json, transitions/*.json, and all
  schema files. This resolves /forge:health config-validation failures in
  forge-cli projects.

## [0.20.0] — 2026-05-25

### Changed

- **`/forge:update` rewrite: monolithic TypeScript → two-layer kickoff-shim pattern.**
  The previous handler reimplemented the plugin's 7-step update workflow in
  TypeScript, missing critical features: generation-manifest guard (writes to
  user-edited files without checking), snapshot replay, pipeline audit, KB
  refresh, breaking-change confirmation, and model-alias suppression. The new
  architecture delegates to the plugin's own `update.md` via `sendKickoff` with
  surgical text patches for forge-cli context differences (FORGE-BUG-039, closes
  Entelligentsia/forge-cli#33).
  - **Gap 1 (baseline derivation):** `deriveBaseline()` reads per-project
    `.forge/update-check-cache.json` `migratedFrom` field instead of
    `localVersion`.
  - **Gap 2 (5-row decision table):** `evaluateUpdateDecision()` implements
    the full plugin decision table (Row 1–5), not just the two-row subset.
  - **Gap 3 (regeneration after migration):** Previously, the handler applied
    migrations but never regenerated generated artifacts. Now delegates to
    plugin-native `regenerate.md` (with generation-manifest guard).
  - **Gap 4 (post-migration steps):** Previously missing: structure check,
    `calibrationBaseline` refresh, schema/tool regeneration. All delegated to
    plugin-native Step 4.
  - **Gap 5 (migration hint in CLI):** `forge update` bin now shows a hint
    directing users to `/forge:update` after a CLI upgrade.
  - **Kickoff patches:** 8 surgical text substitutions for forge-cli context:
    (1) `CLAUDE_PLUGIN_ROOT` → bundled payload path, (2) `CLAUDE_PLUGIN_DATA`
    → bundled payload path, (3) IS_CANARY always true, (4) DISTRIBUTATION
    always `forge@forge`, (5) `$FORGE_ROOT/migrations.json` →
    `$FORGE_ROOT/.schemas/migrations.json`, (6) CLI preflight result injected
    before Step 1, (7) FORGE_ROOT resolution instruction for nested commands,
    (8) `--base-pack` path hint for `substitute-placeholders.cjs`.

### Removed

- **`migration-post-migration.ts`** — 431-line post-migration handler deleted;
  baseline derivation, decision table, and post-migration steps all handled
  by plugin-native flow via kickoff-shim.

## [0.18.0] — 2026-05-23

### Changed

- **pi runtime: 0.75.3-forge.1 → 0.75.4-forge.1** — 70 upstream commits:
  adaptive thinking for Anthropic-compatible aliases, Bedrock support (Smithy
  HTTP handler, default max tokens), OpenCode session headers, OAuth
  device-code refactor, git/path-handling fixes, export-HTML attribute escaping.
  Upstream migrated to `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`;
  fork preserves `auth-guidance` and `migrations` exports.
- **Forge plugin: 0.45.0 → 0.51.1** — sprints S25-T15 through T28:
  hook polish (mtime sentinel, swallowed-error log, `CLAUDE_PLUGIN_ROOT`, timeout),
  catalog generator + FSM canonicalization, catalog-loader/catalog-types +
  catalog-driven TRANSITIONS, guardrails CI (manifest-drift + enum-catalog-drift
  `--check` gates, knip dead-code gate, two-layer guard test).

## [0.17.1] — 2026-05-23

### Added

Guardrails CI consolidation (FORGE-S25-T28):

- **knip dead-code gate** — `knip.config.ts` added; `npm run dead-code` script
  and `Dead-code gate (knip)` step in `.github/workflows/tests.yml`. Catches
  unused exports and dead files in `src/` on every PR. Known false-positives
  (pi-framework dynamic dispatch, public API types) suppressed in
  `knip.config.ts` with inline justification comments.
- **Two-layer guard test** — `test/extensions/forgecli/two-layer-guard.test.ts`
  statically scans `scripts/build-payload.cjs` source text to verify no
  copy expression references hardcoded `engineering/` or `.forge/` paths that
  would accidentally bundle private sprint data into the npm package payload.
- **CI Gates documentation** — `CLAUDE.md` extended with `## CI Gates` section
  summarising the four gates in `tests.yml` and knip fix instructions.

## [0.15.1] — 2026-05-22

### Removed

Eight dead-code modules retired after the round-2 organization scan
(FORGE-S25-T05). Each removal carries paste-ready grep evidence in its
commit; no production caller existed for any of them. The two
`build-payload.cjs` directory copies for `prompts/` and `schemas/` now
exercise their fail-soft `existsSync` branches and emit a
`"… not found — skipping"` line at build time — expected, not a defect.

- **B-3** — `src/bin/forgecli.ts` stub (no `bin` map entry pointed at it;
  all three aliases resolve to `dist/bin/forge.js`).
- **S-5** — `src/extensions/forgecli/schemas/task-list.schema.json` plus
  the now-empty `schemas/` directory.
- **S-6** — `src/extensions/forgecli/prompts/sprint-plan-prompt.md` plus
  the now-empty extension-internal `prompts/` directory. The clone-root
  `forge-cli/prompts/tomoshibi.md` is unaffected.
- **S-8 / Pass-3** — `src/extensions/forgecli/loaders/template-render.ts`
  and its sole test `test/extensions/forgecli/loaders/template-render.test.ts`.
- **C-10** — `discoverForgeRoot` wrapper export from
  `src/extensions/forgecli/forge-root.ts`. The live `discoverForgeConfig`
  function stays; `test/forge-root.test.ts` was rewritten case-for-case to
  exercise `discoverForgeConfig` and assert against its `.forgeRoot` field.
- **ST-8** — `test/poc/subagent-imports.ts` (vestigial spike type-check
  probe; `test/poc/**` is already excluded by vitest).
- **ST-5** — `tsconfig.spike.json` (no script, workflow, or tool invokes
  it; spike-r3..r6 directories remain in place, flagged for a future
  archive sweep).
- **N-S-A** — `src/extensions/forgecli/config-tui/index.ts` barrel
  (all consumers import directly from internal modules).

## [0.15.0] — 2026-05-22

> **The SkillOS release.** Forge now treats its own skill library as a
> living, signal-driven asset. The model's actual frictions — what it
> reached for, what worked, what didn't — feed back into the project
> through a five-subkind taxonomy, an LLM-judge rubric, a compression
> gate, and a per-task curator queue drained as one batched review at
> sprint close. The result: your `.forge/skills/` tracks the codebase as
> it evolves, instead of calcifying into a directory of well-intentioned
> instructions nobody opens.
>
> This release also closes the packaging gaps that were silently
> shipping every Forge install: missing structural checks, missing
> SkillOS tools in the payload, a `/forge:update` that upgraded the
> CLI but skipped project migrations, a version banner that lied about
> the bundled plugin. The deterministic-check infrastructure
> (`check-structure.cjs`, `verify-integrity.cjs`) is finally live
> end-to-end and would now flag a missing skill file the moment it
> happens. The plugin payload is now coherent enough to drive its own
> auditing.

### Added — SkillOS curation pipeline (FORGE-S24)

- **`skill-retriever.ts`** (T08, ac90659). New BM25 retriever using
  `lunr.js` (pinned exact) over skill frontmatter + description fields.
  Returns deterministic top-k for a known corpus and emits a
  `skill_usage` event with `retrieved: true` and a populated
  `retrieval_score` for every hit. The signal that tells Phase 2 which
  skills the model actually saw.
- **`skill-usage-tracker.ts`** (T09, 394125c). Diffs tool-call trajectories
  against retrieved skills; emits `skill_usage` events with `used: true`
  and `tool_call_success_rate` populated. Three discriminator cases
  (overlap → used, no-overlap → unused, reasoning-only → used) covered
  by failing-first tests. Telemetry-actor split: the orchestrator owns
  emission; subagents never call this module directly.
- **`skill-curator-subagent.ts`** (T10, ea29079). Per-task curator —
  takes retrieval + usage signals, dispatches a `runForgeSubagent` with
  the composed task body, parses proposals out, and writes them to the
  append-only queue at
  `.forge/enhancement-proposals/queue/<sprint>/<task>-<ts>.json`. One
  curator run per task; Phase 2 collects them at sprint close.
- **`friction-emit.ts`** (T11, b4d3526). Auto-emits friction events with
  five skill subkinds — `skill_unused` (retrieved but not used on success),
  `skill_failed` (used on failure), `skill_missing` (not retrieved on
  success with ≥2 tool errors), `skill_stale` (unused 3 consecutive
  sprints), `skill_redundant` (>0.8 overlap pair). The diagnostic
  vocabulary that lets a project tell you which of its skills are
  carrying weight and which aren't.
- **`forgeCli.skillCuration.enabled` flag** (T12, 7904c4b). Gated rollout
  — default OFF. Layered resolution: env override
  `FORGE_CLI_SKILL_CURATION_ENABLED` → project
  `<cwd>/.pi/forge-cli/config.json` → global
  `~/.pi/forge-cli/config.json` → `false`. All four emission modules
  no-op silently when the flag is off, so a flag-off install is
  byte-identical to pre-FORGE-S24 behaviour. The pure classifier helpers
  (`computeFrictionSignals`, `classifySkillUsage`, `buildSkillIndex`,
  `retrieveTopK`, `composeCuratorTask`, `parseProposalsFromOutput`) are
  **not** gated — they have no side effects and remain callable for
  downstream consumers.

### Added — bundled forge-plugin pipeline (paired with v0.46.1)

Forge-cli now bundles `forge-plugin@0.46.1` with the full FORGE-S24
machinery, regenerated into the installable base-pack:

- **`queue-drain.cjs`** (T07). Append-only queue under
  `.forge/enhancement-proposals/queue/<sprint>/`; dedupe key is
  `{op, target_path, sha256(diff_body)}`; drain at sprint close produces
  a single batched review prompt instead of one prompt per task — the
  SkillOS §3.2.1 grouped-reward pattern.
- **`compression-gate.cjs`** (T06). Rejects `update_skill` proposals that
  grow a target skill by >20% unless backed by ≥3 supporting friction
  events. Closes the unbounded-growth failure mode where every friction
  pastes another paragraph of trajectory copy into a skill file. Strict
  byte-wise (UTF-8) growth check; insert/delete pass through;
  recurrence-supported growth is allowed.
- **`judge-proposal.cjs`** (T03). Sonnet-class LLM-judge rubric applied
  to every surviving proposal; drops `<3/5`. Rejections persist to
  `.forge/enhancement-proposals/queue/<sprint>/phase2-<ts>-rejections.json`
  so every drop stays traceable.
- **`delete-candidate-detector.cjs`** (T05). Scans trailing 3 sprints
  of `skill_usage` events. Any skill with zero retrieval AND zero
  invocation across the window emits a `delete_skill` proposal at
  Phase 2 entry. The only mechanism by which the skill repo shrinks.
- **`replay-scoring.cjs`** (T04). Cross-task recurrence — same
  `{subkind, skillId}` across tasks t..N gets a `recurrence_count` boost
  that the judge consumes as a specificity score. "This friction
  happened three times" beats "this friction happened once."
- **Proposal schema with op classification** (T02). `proposal.schema.json`
  enforces `op ∈ {insert_skill, update_skill, delete_skill}` with
  required `target_path` and `diff_body`. Legacy inserts back-compat
  via `proposal-normalize.cjs`. Strict `additionalProperties: false`.
- **`skill_usage` event variant** (T01). `event.schema.json` gained a
  conditional `allOf` branch for `type: "skill_usage"` requiring
  `{eventId, sprintId, taskId, skillId, retrieved, used,
  tool_call_success_rate, retrieval_score}`. Strict.

### Fixed — packaging gaps that broke deterministic checks

- **`/forge:update` skipped the migration step entirely** (fc40f4a,
  closes forge-cli#32). The handler implemented the full 5-step guided
  upgrade — detect install → fetch changelog → confirm → npm install →
  apply migrations — but the registration in `index.ts` omitted the
  migration-side options, so the handler returned early before reaching
  the migration block. Projects upgrading the CLI never received
  schema/workflow/template migrations. Fixed by wiring
  `currentBundledForgeVersion` + `migrationProjectRoot` at registration.
- **`/forge:update` migration block unreachable when CLI was already at
  latest** (31796d5, follow-up on #32). The "already at latest" branch
  early-returned BEFORE the migration check at line 373. Decoupled the
  two orthogonal gates — npm-upgrade and project-migration — so a
  locally-built CLI ahead of npm's published version (or a fresh clone
  with a stale drift cache) still fires the migration prompt when
  `fromVersion !== toVersion`.
- **`structure-manifest.json` + `integrity.json` not bundled** (cd732d2).
  Both files exist in plugin source (`forge/forge/schemas/`,
  `forge/forge/integrity.json`) and the consuming tools
  (`check-structure.cjs`, `verify-integrity.cjs`) shipped in
  `TOOLS_TO_COPY`, but `build-payload.cjs` never copied the artifacts.
  Result: `/forge:health`'s structural-check and integrity-verify
  gates silently passed on every install ("× not found" → exit 0).
  Bundle now ships `dist/forge-payload/schemas/structure-manifest.json`
  (non-dot path matching what `check-structure.cjs` resolves) and
  `dist/forge-payload/integrity.json` at bundle root. After install,
  `verify-integrity.cjs` correctly reports `〇 Plugin integrity — all
  25 files unmodified`, and `check-structure.cjs` flags any missing
  expected file in the user's `.forge/` tree.
- **`hooks/` and `agents/` not bundled** (625fbb1, continuation of
  cd732d2). `integrity.json` tracks 25 files including 4 hooks
  (`check-update.js`, `forge-permissions.js`, `triage-error.js`,
  `validate-write.js`) and 2 agents (`tomoshibi.md`,
  `store-query-validator.md`). None were copied. The TS ports
  (`hook-dispatcher.ts`, `hooks/*.ts`) are the actual runtime path —
  the `.js`/`.cjs` files are integrity ballast that satisfy plugin
  tampering detection. Bundled to satisfy
  `verify-integrity.cjs`. Hooks intentionally bundle only top-level
  `*.js` (4 files); `lib/`, `__tests__/`, and `*.cjs` (post-init,
  post-sprint) are excluded — none are integrity-tracked and the TS
  ports own the runtime channel.
- **5 FORGE-S24 plugin tools missing from `TOOLS_TO_COPY`** (commit
  in the build-payload cluster). `queue-drain.cjs`,
  `compression-gate.cjs`, `judge-proposal.cjs`,
  `delete-candidate-detector.cjs`, `replay-scoring.cjs` — the new Phase 2
  workflow `require()`s them from `$FORGE_ROOT/tools/`. Without them
  bundled, `/forge:enhance` would fail with
  `Cannot find module './forge/tools/queue-drain.cjs'` (and four more).
  Added to the allowlist with a comment block flagging the dependency.
- **Version banner reported stale `bundledVersion`** (ae520f8). Both
  readers (`src/bin/forge.ts printVersion`, `src/extensions/forgecli/
  index.ts readPkgVersions`) sourced the value from `package.json`
  `forge.bundledVersion` — a hand-maintained mirror that nobody
  updated when the plugin moved 0.45.0 → 0.46.0 → 0.46.1. Both readers
  now prefer `dist/forge-payload/.claude-plugin/plugin.json` as the
  single source of truth. After fix:
  `@entelligentsia/forgecli@0.15.0 (forge-plugin@0.46.1, pi@…)` reads
  the truth. The mirror in package.json is now informational only.

### Changed

- **Bundled forge-plugin: v0.44.5 → v0.46.1.** Two minor bumps. v0.45.x
  shipped the FORGE-S24 SKILL-CURATION machinery (event variant,
  proposal schema, queue drain, compression gate, judge, recurrence,
  delete-candidate); v0.46.0 was the sprint-completion marker; v0.46.1
  is the build fix that regenerated `init/base-pack/workflows/
  enhance.md` from the meta source so projects migrating to 0.46.x
  actually receive the new Phase 2 algorithm.
- **`forge_verify_apply` MCP tool ships in the bundle** (b971596,
  closes forge-cli#31). Detects hallucinated `Edit` calls — when an
  assistant proposes an edit that doesn't match any file on disk, the
  tool flags it at apply time instead of silently no-op'ing.

### Documented

- **`hook-dispatcher.ts` scope clarification** (7d513ca). New header
  comment block stating the write-guard is a soft fence for honest
  mistakes, not a security boundary against adversarial bash escape.
  See `doc/analysis/write-guard-scope-and-model-behavior.md` in the
  forge-engineering repo for the testbench evidence (two pi-session
  recordings of the same rogue-write prompt — one model surrendered on
  the first block, another escalated three times until succeeding via
  `echo > file`).

### Migration notes

After upgrading via `npm i -g @entelligentsia/forgecli@0.15.0`:

1. `4ge` from your project root.
2. `/forge:update` will now actually apply project migrations (the
   wire-up + decoupling fixes above). Accept the migration prompt.
3. To enable SkillOS curation, set
   `forgeCli.skillCuration.enabled: true` in
   `<cwd>/.pi/forge-cli/config.json` (or
   `FORGE_CLI_SKILL_CURATION_ENABLED=1` for one-shot use). Until you
   enable it, the four emission modules no-op — the install is
   byte-identical to pre-FORGE-S24 behaviour.
4. `/forge:health` now reports through the bundled
   `verify-integrity.cjs` and `check-structure.cjs` — expect cleaner
   output than prior releases, and real signal if your `.forge/` tree
   diverges from the manifest's expectations.

## [0.14.0] — 2026-05-22

### Added

- **`forgeCli.skillCuration.enabled` config flag — gated rollout for SKILL-CURATION pipeline (FORGE-S24-T12).** Adds `forgeCli.skillCuration.enabled` (boolean, **default `false`**) to `forge-cli-schema.json` under a new top-level `forgeCli` object (`additionalProperties: false` preserved). New module `src/extensions/forgecli/skill-curation-flag.ts` exporting `isSkillCurationEnabled(cwd?)` resolves the flag in priority order: env override `FORGE_CLI_SKILL_CURATION_ENABLED` (accepts `1`/`true`/`0`/`false` case-insensitive; unrecognised values fall through) → project config (`<cwd>/.pi/forge-cli/config.json`) → global config (`~/.pi/forge-cli/config.json`) → `false`. The four SKILL-CURATION modules from T08–T11 now check the flag at the top of their public emission/dispatch entry points and no-op when off — `emitSkillUsageEvents` (T08), `emitSkillUsageTrackingEvents` (T09), `emitFrictionEvents` (T11) return `{emitted: 0, failed: 0, stderrs: []}` and make **zero** `spawnSync` calls; `runSkillCurator` (T10) returns `{exitCode: 0, written: 0}` and dispatches **no** subagent, writes **no** queue file. The gate runs BEFORE TypeBox `Value.Parse`, so a flag-off run with malformed runtime input is also a silent no-op (matches the "default OFF ⇒ byte-identical to pre-FORGE-S24 behaviour" acceptance criterion). The orchestrator-side friction channel (non-skill subkinds emitted via `forge/tools/friction-emit.cjs`) is **not** gated by this flag — only the auto-emit module landed in T11 (the five skill subkinds: `skill_unused`, `skill_failed`, `skill_missing`, `skill_stale`, `skill_redundant`). Pure classifier helpers (`computeFrictionSignals`, `classifySkillUsage`, `buildSkillIndex`, `retrieveTopK`, `clampRetrievalScore`, `composeCuratorTask`, `parseProposalsFromOutput`) are **not** gated — they have no side effects and remain callable for downstream consumers that want to compute signals without emitting. Test-first per Iron Law 2: `skill-curation-flag.test.ts` (14 cases — `parseEnvFlag` accepts on/off variants and rejects unrecognised, `isSkillCurationEnabled` defaults to false with all layers empty (AC2), env override wins over both disk layers in both directions, project config wins over global, global used when project absent, malformed env falls through to disk; flag-off no-op guarantee for all four modules — zero `spawnSync` for emit modules, no `runForgeSubagent` dispatch for curator, no queue directory created (AC3); flag-on smoke for `emitSkillUsageEvents` — exactly one argv-array spawn per hit with `["emit", sprintId, json]` shape (IL6)). Pre-existing skill-pipeline tests (`skill-retriever.test.ts`, `skill-usage-tracker.test.ts`, `friction-emit.test.ts`, `skill-curator-subagent.test.ts`) now set `FORGE_CLI_SKILL_CURATION_ENABLED=1` in their `beforeEach` to exercise the flag-on path; the default-off contract is covered by the dedicated gate suite. Full forge-cli test surface unchanged in count: 1733 passed / 7 skipped (3 pre-existing failures in `test/bin/doctor.test.ts` are environmental and unrelated to T12). `npm run typecheck` green. **Operator action required** to enable: upgrade to ≥ 0.14.0 AND set `forgeCli.skillCuration.enabled: true` in `<cwd>/.pi/forge-cli/config.json` (or `FORGE_CLI_SKILL_CURATION_ENABLED=1` for one-shot use). Until both conditions hold, the pipeline is silent — `skill_usage` events are not emitted, friction events for the five skill subkinds are not emitted, and the per-task curator subagent is not dispatched. Pairs with plugin v0.46.0 (convergent sprint marker; no plugin source change in that bump). Closes FORGE-S24-T12 and the SKILL-CURATION sprint.

### Changed

- **`config-layer.ts`** — `GlobalConfig` and `ProjectConfig` interfaces gain an optional `forgeCli?: ForgeCliFeatureFlags` field carrying the `skillCuration` sub-object. Schema-level addition (`additionalProperties: false` was already in force on the root); existing configs continue to validate unchanged.

---

## [0.13.4] — 2026-05-22

### Added

- **`friction-emit.ts` — auto-emit friction events with 5 skill subkinds (FORGE-S24-T11).** New module under `src/extensions/forgecli/` that, at task close, classifies the orchestrator's per-task signals (retrieved skills with T08 retrieval verdicts + T09 usage verdicts, task success outcome, observed tool-error count, per-skill historical "consecutive unused sprints" counter, optional pairwise retrieval-overlap measurements) and emits one `friction` event per matching gate via `node <storeCli> emit <sprintId> <json>` (argv-array, Iron Law 6). Public surface: `computeFrictionSignals(inputs)` → pure `FrictionSignal[]` (no IO, no subprocess); `emitFrictionEvents(signals, runtime)` → `FrictionEmitResult` (`emitted`, `failed`, `stderrs`). Five gating rules per FORGE-S24-T11 acceptance criteria: `skill_unused` (retrieved && !used && task.success), `skill_failed` (retrieved && used && !task.success), `skill_missing` (!retrieved && task.success && tool_errors ≥ 2 — one signal per task, no skillId attribution), `skill_stale` (retrieved && !used across ≥ 3 consecutive sprints, per-skill history supplied by caller), `skill_redundant` (pairwise retrieval overlap strictly > 0.8, attributed to skillA, paired-with skillB recorded in evidence). Each emitted event carries the schema's required `{type: "friction", workflow, persona, issue}` trio plus `subkind`, `skillId` (when applicable), and an `evidence` blob (retrievalScore, toolErrorCount, consecutiveUnusedSprints, or `{pairedWith, overlap}` as appropriate per subkind). Telemetry-actor split (IL10) honoured — runtime attribution (`model`, `provider`, `startTimestamp`, `endTimestamp`, `durationMinutes`) is caller-supplied, never fabricated inside the module; subagents never invoke this emitter directly. Non-zero `store-cli emit` exits increment `failed` and capture stderr without throwing (IL7). Subkind enum matches the plugin event schema (forge v0.45.0+) — no plugin schema change required for this task. Wiring into `run-task.ts` / `fix-bug.ts` is gated on FORGE-S24-T12 feature flag.

---

## [0.13.3] — 2026-05-22

### Added

- **`skill-curator-subagent.ts` — per-task curator dispatch (FORGE-S24-T10).** New module under `src/extensions/forgecli/` that, at task close, hands the task trajectory summary, the retrieved-skill bodies (from T08), and the task outcome verdict to a curator subagent, then writes the curator's enhancement proposals to the project-local enhancement-proposals queue at `.forge/enhancement-proposals/queue/<sprintId>/<taskId>-<ts>.json` (T07 layout — the sprint-close queue-drain consumes this path). Public surface: `runSkillCurator(input)` → typed `CuratorResult` (`exitCode`, `written`, `queueFile?`, `errorMessage?`); `parseProposalsFromOutput(text)` → `Proposal[]` (preferred: fenced ```json``` block, fallback: bare JSON array, items that fail TypeBox validation are dropped); `composeCuratorTask(input)` → first-user-message string carrying sprint/task header, trajectory summary, retrieved-skill bodies, task outcome, and the proposal schema. Dispatch goes through `runForgeSubagent({persona: defaultCuratorPersona(), task, cwd, exportTag})` — fresh in-process pi session, isolated context (Iron Law 10). The curator persona is **inline** (no new file under `forge/forge/meta/personas/` — Iron Law 1 forge-cli boundary respected, no plugin version bump, no security-scan trigger). Proposals are deduped by `{op, target_path, sha256(diff_body)}` (mirrors T07's `dedupeKey`) before write; the empty-array case writes NO file (zero-noise invariant); if the canonical path already exists, the curator retries with a `-N` suffix on the ts (append-only invariant — T07's queue-drain is read-only and never deletes). The subagent NEVER calls `store-cli emit`, writes to `forge/forge/meta/skills/`, or invokes write-mutating tools — these are forbidden in the persona system prompt and enforced by Slice 2 contract (orchestrator emits the canonical phase event AFTER `runSkillCurator` returns, using its own runtime telemetry). Failures (subagent `exitCode !== 0`, parse errors) surface as a typed result with `written: 0` and a non-empty `errorMessage` — no throw, no silent continuation (IL7). Wiring into `run-task.ts` / `fix-bug.ts` is gated on FORGE-S24-T12 feature flag.

---

## [0.13.2] — 2026-05-22

### Added

- **`skill-usage-tracker.ts` — post-task usage classification + emission (FORGE-S24-T09).** New module under `src/extensions/forgecli/` that, after a task closes, diffs the observed tool-call trajectory against each retrieved skill's declared workflow steps and emits a follow-up `skill_usage` event per skill with `used: true | false` and a populated `tool_call_success_rate`. Public surface: `classifySkillUsage(skill, trajectory)` → pure `UsageVerdict` (`used`, `signal: "overlap" | "reasoning" | "none"`, `tool_call_success_rate ∈ [0,1]`); `emitSkillUsageTrackingEvents(retrieved, trajectory, runtime)` writes one event per retrieved skill via `node <storeCli> emit <sprintId> <json>` (argv-array, Iron Law 6). Heuristic per FORGE-S24-T09 acceptance criteria: skill name appears in agent reasoning → `used: true` (signal `reasoning`); ≥2 distinct workflow steps overlap with executed tool calls → `used: true` (signal `overlap`); otherwise → `used: false`. `tool_call_success_rate` is the fraction of declared steps observed in the trajectory (distinct overlaps / total steps), clamped to `[0,1]`. Step matching is case-insensitive substring against tool call names to tolerate qualified MCP-style names (e.g. `mcp__store__store-cli-query` matches workflow step `"store-cli query"`). Emitted events conform to the `skill_usage` schema variant landed in forge plugin v0.45.0 (FORGE-S24-T01) with `retrieval_score: 0` — the populated retrieval score was already emitted at retrieval time by T08; this is a tracking-time follow-up. Runs in **orchestrator context** (telemetry-actor split honoured — subagent never invokes the tracker; runtime attribution `model/provider/timestamps/durationMinutes` is caller-supplied, never fabricated). Module owns classification + emission only — assembling the retrieved-skill list, trajectory, and runtime attribution is the orchestrator handler's responsibility (wiring into `run-task.ts`/`fix-bug.ts` is gated on FORGE-S24-T12 feature flag).

---

## [0.13.1] — 2026-05-22

### Added

- **`skill-retriever.ts` — BM25 skill retrieval (FORGE-S24-T08).** New module under `src/extensions/forgecli/` that ranks the project skill corpus by relevance to a task description using `lunr.js` Okapi-BM25 scoring. Public surface: `buildSkillIndex(corpus)` → opaque `SkillIndex` handle; `retrieveTopK(index, query, k)` → deterministic `RetrievalHit[]`; `emitSkillUsageEvents(hits, runtime)` writes one `skill_usage` event per hit via `node <storeCli> emit <sprintId> <json>` (argv-array, Iron Law 6). Indexed fields: skill `name` (boost 4), `description` (boost 2), and selected frontmatter (`name`, `tags`, `aliases`, boost 1). Raw BM25 scores are squashed via `s / (1 + s)` before being written to `retrieval_score` (schema constraint `[0,1]`). Emitted events conform to the `skill_usage` variant landed in forge plugin v0.45.0 (FORGE-S24-T01): required `eventId, sprintId, taskId, skillId, retrieved=true, used=false, tool_call_success_rate=0, retrieval_score`, plus the canonical attribution fields supplied by the orchestrator (`role, action, startTimestamp, endTimestamp, durationMinutes, model, provider`). Module owns ranking + emission only — corpus construction (parsing `SKILL.md` frontmatter) remains the caller's responsibility and is delegated to `loaders/persona-skill-loader.ts`. Behaviour is gated downstream by `forgeCli.skillCuration.enabled` (FORGE-S24-T12).

### Dependencies

- **`lunr@2.3.9`** added as a runtime dependency, pinned exact (no `^`/`~`) per Iron Law 3 dependency discipline. Pure-JS, MIT-licensed, zero runtime dependencies — SBOM impact is a single direct entry. `@types/lunr@2.3.7` added as dev dependency.

---

## [0.13.0] — 2026-05-21

### Added

- **`forge_verify_apply` MCP tool** detects hallucinated Edit calls. The agent is instructed to call it AFTER applying Phase 2 enhancement edits and BEFORE invoking `manage-versions add-snapshot`. The tool runs `generation-manifest.cjs check` on each claimed file path and returns structured buckets: `modified` (verified ✓), `unchanged` (Edit silently no-op'd — usually `old_string` mismatch), `untracked` (no manifest entry), `missing` (file gone). If `unchanged.length > 0`, the agent MUST re-apply via Edit/Write and re-verify before snapshotting. Closes [forge-cli#31](https://github.com/Entelligentsia/forge-cli/issues/31).

  Background: hello testbench session 17:48 UTC showed the agent's UI claimed 5 file modifications; the snap-4 archive captured by add-snapshot afterwards contained pristine content for 4 of 5 files. The Edit tool had failed silently and the agent reported success regardless. The verification logic is now in forge-cli code (deterministic, testable) rather than relying on agent self-inspection.

### Changed

- **`enhance.ts` Phase 2 kickoff** restructured: previous Step 5 (snapshot) split into Step 5 (VERIFY via `forge_verify_apply`) and Step 6 (snapshot after verify). Snapshot is now explicitly gated on verification completing with no `unchanged` files.

---

## [0.12.1] — 2026-05-21

### Fixed

- **`enhance.ts` — explicit `add-snapshot` instruction in Phase 2 kickoff.** Previously the kickoff said nothing about snapshots; agents had to discover the requirement buried in `meta-enhance.md` step 8. In practice many agents applied edits but skipped the snapshot call, breaking the entire durability story — replay (v0.12.0) had nothing to restore from. Kickoff now explicitly instructs: after applying any approved edits, MUST call `node "$FORGE_ROOT/tools/manage-versions.cjs" add-snapshot --source post-sprint:<SPRINT_ID> --enhanced-elements <paths>`. Discovered via hello testbench transcript: `currentSnapshot` stayed at 3 after a Phase 2 apply session, leading to silent data loss on the next regenerate. Closes part 1 of [forge-cli#30](https://github.com/Entelligentsia/forge-cli/issues/30).
- **`regenerate.ts` — modification guard now fires on untracked files.** Previously only fired on `generation-manifest check` exit 1 (modified hash mismatch); exit 2 (untracked — no manifest entry) was ignored. After a prior regenerate ran `clear-namespace` without re-recording, files end up in untracked state — and the next regenerate silently overwrote them. Guard now surfaces both "modified" and "untracked" states with state-aware prompt text. `ModifiedFile` interface extended with a `state: "modified" | "untracked"` field. Closes part 2 of [forge-cli#30](https://github.com/Entelligentsia/forge-cli/issues/30).

---

## [0.12.0] — 2026-05-21

### Added

- **`regenerate.ts` — snapshot replay (Approach A layer 3).** Mirrors the new plugin behaviour in forge v0.45.0. After `substitute-placeholders.cjs` writes fresh base-pack content over `.forge/{personas,skills,workflows,templates}/`, the handler now invokes `manage-versions replay --target <category>` for each of the four structural-element categories. Restores user-enhanced files captured by `/forge:enhance` Phase 2 snapshots from `.forge/archive/snap-N/`. Pure additive — no-op when no snapshots match. Skipped when `--force` is used (force == "I want pristine base-pack content, no overlay"). Closes [forge-cli#27](https://github.com/Entelligentsia/forge-cli/issues/27).

### Changed

- **Modification guard text softened** to reflect the new replay behaviour. The pre-write prompt now states that snapshot-captured edits will be restored automatically post-regenerate, and only manual edits NOT captured in any snapshot are at risk. Guard remains as defence-in-depth.

- Bundled forge-plugin advanced to **0.45.0** (replay subcommand + regenerate replay step).

---

## [0.11.6] — 2026-05-21

### Fixed

- **`enhance.ts` — Phase 2 kickoff no longer over-restricts friction discovery to `forge_store_query`.** The kickoff previously instructed agents to discover friction events "ONLY via the `forge_store_query` tool — do NOT raw-read `.forge/store/events/`". But the underlying NLP engine matches by keyword-on-title heuristics, not by `type === 'friction'` exactly — a testbench with 10 friction events on disk returned only 6 via NLP and zero in one agent's path, producing `frictionCount: 0` Phase 2 outputs despite events being present. Kickoff now: (a) keeps `forge_store_query` as **preferred** path, (b) explicitly instructs the agent to **fall back to the workflow body's filesystem walk** (`meta-enhance.md` Step 1's `e.type === 'friction'` filter) when MCP returns suspiciously low / zero, (c) zero-friction guard fires only when **both paths** are empty. Closes [forge-cli#29](https://github.com/Entelligentsia/forge-cli/issues/29).
- Bundled forge-plugin advanced to **0.44.10**, which includes the fix for `manage-versions add-snapshot` silently failing to archive files ([forge#108](https://github.com/Entelligentsia/forge/issues/108)) — layer 2 of the composition contract is now functional. Unblocks future Approach A work (forge#107 / forge-cli#27).

---

## [0.11.5] — 2026-05-21

### Fixed

- **`index.ts` — `process.env.FORGE_ROOT` now exported on main-thread activation.** When forge-cli activates inside a Forge project, `process.env.FORGE_ROOT` is set to the absolute path resolved from `.forge/config.json`'s `paths.forgeRoot`, alongside the existing `before_agent_start` orientation injection. Subagent dispatch via `runForgeSubagent` already set this (forge-subagent.ts:200), but kickoff handlers (`/forge:enhance`, `/forge:health`, `/forge:calibrate`, etc.) bypass the subagent path — so `$FORGE_ROOT/...` in their workflow bodies' bash command literals previously substituted to an empty string, producing the symptom "Snapshot: not written (Forge manage-versions not available in this context)" during `/forge:enhance` Phase 2. Closes [forge-cli#28](https://github.com/Entelligentsia/forge-cli/issues/28). Phase 1 of the snapshot-replay durability story tracked in forge#107 / forge-cli#27.

---

## [0.11.4] — 2026-05-21

### Fixed

- **`regenerate.ts` — pre-write modification guard for `/forge:regenerate`.** Companion to [forge#106](https://github.com/Entelligentsia/forge/issues/106) (FORGE-BUG-037) and the forge plugin v0.44.9 markdown fix. Before invoking `substitute-placeholders.cjs`, the handler now enumerates files in `.forge/{personas,skills,workflows,templates}/` and runs `generation-manifest.cjs check` on each. Any file whose hash no longer matches the recorded manifest — typically applied by `/forge:enhance` Phase 2 — triggers a `ctx.ui.confirm` prompt listing the modifications. On decline, regenerate is cancelled and the edits are preserved. New `--force` flag bypasses the prompt for CI / dogfood reset.

  The plugin-level markdown fix (forge v0.44.9) covered the Claude Code plugin flow which executes the command markdown body. forge-cli has a self-contained TypeScript handler that bypasses the markdown body entirely; this commit closes that vector. See [forge-cli#26](https://github.com/Entelligentsia/forge-cli/issues/26).

- Bundled forge-plugin advanced to **0.44.9** (was 0.44.6 / 0.44.8 in 0.11.3 builds depending on rebuild timing).

---

## [0.11.3] — 2026-05-21

### Fixed

- **`ask-user-tool.ts` — chip strip no longer steals arrow keys from `forge_ask_user` dialogs.** `ctx.ui.confirm`/`select`/`input` are pi's built-in overlay dialogs but `forge_ask_user` never called `pushOverlay`/`popOverlay` on the `ForgeInputRouter`. The thread-switcher's arrow-key handler (registered with `skipWhenOverlayActive`) was never suppressed because `overlayDepth` stayed at 0. All three dialog calls are now wrapped in `router.pushOverlay()` / `router.popOverlay()` (try/finally), matching the pattern in `config-command.ts`.

- **`run-task.ts` — chip strip no longer appears before task ID is resolved.** `registry.startSession(taskId)` was called with the raw user arg (e.g. `"T01"`) before `resolveToCanonicalId` had a chance to disambiguate ambiguous matches. The chip strip appeared showing `T01` before the user answered the `ctx.ui.select` choice dialog — and arrow keys were stolen by the strip. `startSession` is now deferred to after `resolveToCanonicalId` and all resume-detection `ctx.ui.confirm` prompts, right before pipeline delegation.

---

## [0.11.2] — 2026-05-20

### Fixed

- **`package.json.bundledVersion` actually advanced to `0.44.6`.** The 0.11.1 CHANGELOG entry claimed bundled 0.44.6 but the manifest still read 0.44.5; downstream `/forge:update` heuristics that key off `bundledVersion` were stale.
- **`thread-switcher.ts` — hide viewport footer when no orchestrator session is active.** `ViewportFooterComponent.render()` previously kept the row visible across sessions; now returns `[]` unless at least one session is `running` or `cancelling`, removing a permanent blank line in the editor area between sessions.

---

## [0.11.1] — 2026-05-20

### Fixed

**P1 bug-fix batch (forge-cli#25 — defects A and B) — payload packaging gaps.**

- **Defect A — meta/ directory missing from bundled payload.** `scripts/build-payload.cjs` now copies `forge/forge/meta/` (personas + skills source-of-truth) into `dist/forge-payload/meta/`. Without this directory, `build-persona-pack.cjs` hashed an empty input tree and produced SHA `e3b0c4...` for every install, causing `/forge:health` to permanently flag "persona pack stale" on fresh installs.

- **Defect B — three health-check tools missing from bundled payload.** `check-structure.cjs`, `list-skills.js`, and `verify-integrity.cjs` are now included in `TOOLS_TO_COPY` in `build-payload.cjs`. Previously these tools were absent from `dist/forge-payload/tools/`, causing `/forge:health` to silently skip 3 of its 14 checks on every install (reported as "(skipped — `<tool>` not available in this Forge version)").

**Bundled plugin version**: 0.44.6 (defects C, D, E fixes included).

---

## [0.11.0] — 2026-05-20

### Added

**FORGE-S23: Full /forge:\* surface port + migration runner + thread cancellation**

- **Migration runner (`/forge:update`)** (FORGE-S23-T01): `runMigrations()` deterministic engine. Executes pending migrations in version order, idempotent, integrated with the `/forge:update` upgrade flow. Migrations are defined in `forge-cli/dist/forge-payload/.schemas/migrations.json` and applied automatically on `forge update`.

- **Validate-write hook** (FORGE-S23-T02): Port of `forge/forge/hooks/validate-write.js` as a pi `PostToolUse` hook. Full FS-level schema guard — rejects JSON writes to forge-owned paths (`.forge/store/**`, `.forge/config.json`) that violate their schema. Schema errors are surfaced in the pi notification strip.

- **Triage-error hook** (FORGE-S23-T03): Port of `forge/forge/hooks/triage-error.js`. When a Bash tool call exits non-zero and matches Forge-related patterns (11 regexes), emits a `FORGE_ERROR_TRIAGE` notify suggesting `/forge:report-bug`. Non-Forge commands and successful exits are silent.

- **Forge-permissions hook** (FORGE-S23-T04): Port of `forge/forge/hooks/forge-permissions.js`. Pattern-match auto-allow for forge-owned tool invocations; surfaces a permission prompt for unknown patterns.

- **Check-update hook** (FORGE-S23-T05): Port of `forge/forge/hooks/check-update.js`. Full parity (5 functions): version fetch, stale-check, banner injection, changelog delta, and auto-dismiss on upgrade.

- **`/forge:retrospective`** (FORGE-S23-T06): Kickoff shim. Reads the retrospective workflow and injects into the LLM conversation with the sprint context.

- **`/forge:health` programmatic checks** (FORGE-S23-T07): 3 new checks added: schema integrity scan (validates `.forge/schemas/` JSON Schemas), store referential integrity (detects orphaned task/bug references), forgeRef drift detection (compares `paths.forgeRef` vs bundled plugin version). Health output now includes structured check results with pass/fail/warning states.

- **`/forge:calibrate`** (FORGE-S23-T08): Orchestrator handler. Drift detection + patch proposal: reads `.forge/config.json`, compares against expected schema, proposes a patch for stale or missing fields. Allows one-shot config repair from within pi.

- **`/forge:materialize` + `/forge:migrate`** (FORGE-S23-T09): Two new atomic handlers. `materialize` regenerates `.forge/` from the bundled plugin source (calls `forge:regenerate` logic). `migrate` applies pending schema migrations to the active `.forge/store/`.

- **`/forge:update-tools`, `/forge:store-query`, `/forge:status`** (FORGE-S23-T10): Three new atomic handlers. `update-tools` refreshes `.forge/schemas/` from the bundled plugin. `store-query` exposes store inspection (list sprints, tasks, bugs with filters). `status` renders a sprint-status widget in the main viewport.

- **6 kickoff-shim commands** (FORGE-S23-T11): `/forge:add-task`, `/forge:add-pipeline`, `/forge:quiz-agent`, `/forge:remove`, `/forge:report-bug`, `/forge:store-repair` — all now have real handlers (previously advisory stubs that fell back to the Claude Code plugin).

- **Thread cancellation** (`feat/thread-cancellation`): User can cancel an in-progress orchestrator run (`/forge:run-task`, `/forge:run-sprint`, `/forge:fix-bug`) from the session-monitor strip UI. Between-phase cancellation gate in `run-task.ts` and `fix-bug.ts`. State file preserved on cancellation so runs are resumable (ADR-S21-01). Cancellation status tracked in bug state (`status: "cancelled"` vs `"halted"`).

- **Structured transcript paths**: Subagent transcripts now land in `.forge/transcripts/<entityId>/<entityId>__<phase>.json` (previously `forge-subagent-<timestamp>__<persona>__<tag>.json`). Deterministic, overwrite-on-rerun, gitignored via the existing `.forge/` entry in `.gitignore`.

### Changed

- **`forge.bundledVersion` updated to `0.44.5`**: New installs via `/forge:init` materialize at Forge plugin 0.44.5 (was 0.44.3 since v0.10.0).

### Notes

- All 36 `/forge:*` commands now have real handlers. Zero advisory stubs remain.
- Smoke matrix gate (113/113 structural checks) passes on all T06–T12 handlers for both `openai-compatible` and `anthropic` model classes (FORGE-S23-T14).
- Sprint parity audit (FORGE-S23-T12) documents command coverage against the plugin's workflow surface.
- Versions 0.10.4–0.10.11 were internal pre-release version bumps during sprint development; they were never published to npm. This release (0.11.0) supersedes all of them.

## [0.10.3] — 2026-05-20

### Added
- **Triage-error hook — post-Bash-failure context injection** (FORGE-S23-T03).
  When a Bash tool call exits non-zero and the command matches Forge-related patterns
  (`FORGE_PATTERNS` — 11 regexes ported verbatim from `triage-error.js:10-20`),
  `hook-dispatcher.ts` now calls `ctx.ui.notify` with a `FORGE_ERROR_TRIAGE` message
  suggesting the user run `/forge:report-bug`. Non-Forge commands and successful exits
  are silent. Port of `forge/forge/hooks/triage-error.js` for the pi extension context.

## [0.10.2] — 2026-05-20

## [0.10.1] — 2026-05-19

### Fixed
- **Thread-switcher no longer crashes on session replacement** (FORGE-BUG-003
  surfaced this). The input-router handler registered by
  `forgecli/thread-switcher.ts` closed over the `ctx` captured at the first
  `session_start`. After any subsequent `ctx.newSession()` / `ctx.fork()` /
  `ctx.switchSession()` / `ctx.reload()` — which `/forge:fix-bug` triggers
  on phase transitions — the captured ctx was stale, and the next ↓ keypress
  hit `ctx.ui.getEditorText()` on a dead ctx, causing pi's `assertActive`
  guard to throw an uncaught `extension ctx is stale` error and exit the
  process. Fix tracks `currentCtx` via a closure ref refreshed on every
  `session_start`; the input handler and `commitFocus` / `setFocusToMain`
  now read the live ctx with defensive try/catch. Same hazard had been
  spot-fixed earlier for `ctx.model` in the viewport footer factory; the
  input-router handler had been missed.

### Changed
- **Config TUI now uses the running session's `ModelRegistry`** for provider-aware
  model discovery instead of creating a fresh registry. This surfaces
  extension-registered providers (e.g. `ollama-cloud`) in the TUI's model list.

## [0.10.0] — 2026-05-19

### Changed
- **User-level data layout consolidated under `~/.pi/forge-cli/`**
  (FORGE-S20-T11). Pre-v0.10.0 installs scattered runtime state across
  `~/.pi/agent/forge-cli/` (config) and `~/.cache/forgecli/` (probe
  caches), colliding with pi's `agent/settings.json` namespace. The new
  layout is:
  ```
  ~/.pi/forge-cli/
    config.json                   (replaces ~/.pi/agent/forge-cli/config.json)
    cache/                        (replaces ~/.cache/forgecli/)
      update-banner.json
      whats-new-seen.json
      seen.json                   (foundry-collision dismissals)
      drift-seen.json
    state/                        (reserved for future use)
    .migrated-from-legacy         (idempotency marker)
  ```
- **One-shot, idempotent migration on first run after upgrade.** A new
  `paths/migrator.ts` module moves legacy files into the new layout and
  writes a `.migrated-from-legacy` marker so subsequent runs short-circuit
  in O(1). Partial-success runs do NOT write the marker — the migrator
  retries on the next startup until every legacy file has been moved or
  the marker is set manually.
- **Central path resolver (`paths/paths.ts`).** Every call site under
  `src/` now reads paths through this module — no more inline
  `os.homedir()`, `XDG_CACHE_HOME`, or string-literal `.pi/forge-cli`
  paths outside the resolver. Tests and CI can override the user root
  via `FORGE_CLI_HOME`.

### Removed
- **`PI_CODING_AGENT_DIR` no longer influences forge-cli's global
  config location.** The forge-cli user root is intentionally outside
  pi's `agent/` namespace to avoid the `agent/settings.json` collision.
  Use `FORGE_CLI_HOME` to relocate the forge-cli user root.

### Migration notes
- Routine users: no action required — the migrator runs automatically
  on first launch of v0.10.0 and is fail-silent.
- Users who hand-edited `~/.pi/agent/forge-cli/config.json` can verify
  the move with `cat ~/.pi/forge-cli/config.json`.
- **Rollback** (revert to v0.9.x layout): `cp ~/.pi/forge-cli/config.json
  ~/.pi/agent/forge-cli/config.json` after downgrading.
- Themes and agents remain in pi's namespace
  (`~/.pi/agent/themes/`, `~/.pi/agent/agents/`) because pi loads them
  before forge-cli's extension hook runs — that boundary is unchanged.

## [0.9.4] — 2026-05-19

### Fixed
- **`forge update` no longer emits "Detected unsettled top-level await"
  warning** while blocked at the `[y/N]` upgrade prompt. The bin entry
  point's subcommand dispatch is now wrapped in an async function
  invoked from a non-awaited `.catch()` chain at module scope, so the
  long-running interactive readline never sits at a top-level `await`.
  Pre-existing behaviour bug since long-prompt subcommands shipped;
  surfaced loudly on Node v22+.

## [0.9.3] — 2026-05-19

### Changed
- **Vendor-pi bumped to upstream 0.75.3** — weekly upstream sync from
  earendil-works/pi @ 29b3417a. coding-agent vendored as
  `0.75.3-forge.1` with the three forge-owned patches reapplied
  (PI_SKIP_PACKAGE_UPDATE_CHECK, PI_SKIP_CHANGELOG, pre-release strip
  in changelog.ts).
- **coding-agent dep normalized to `file:` ref** — eliminates the
  registry lookup that fails for `-forge.N` versions that are never
  published upstream.

## [0.9.2] — 2026-05-19

### Fixed
- **`forge update` version detection** — the command previously queried
  the Entelligentsia/forge-cli GitHub releases endpoint for the latest
  version, which had stalled at `v0.1.0`. It now probes the npm
  `dist-tags.latest` field (the same authoritative source the startup
  update-check banner already used correctly). The changelog body is
  still fetched from the tag-specific GitHub release URL; if no release
  exists for the tag, the notes section is shown as empty rather than
  failing the upgrade.
- **`forge update` error message** — corrected two user-facing strings
  that blamed a GitHub outage when the npm registry probe fails.

## [0.9.1] — 2026-05-18

### Changed
- **README: Model setup documentation** — new section walks users through
  the three-knob tier setup (Heavy / Standard / Light) with screen-by-screen
  examples, scope toggle, verification, advanced overrides, and
  non-interactive CLI alternatives.

## [0.9.0] — 2026-05-18

### Added
- **Per-persona model routing** — Forge now routes each pipeline phase
  (plan, review-plan, implement, review-code, validate, approve, writeback,
  commit) to a specific AI model via persona-model assignments resolved
  through a four-level cascade: per-step override → per-persona override →
  tier baseline → pi current. The cascade is invisible to the user;
  plain-English labels ("Heavy tier (global)", "Step override") replace
  internal L1/L2/L3/L4 jargon everywhere it appears.
- **Tiered-baseline config TUI** — `/forge:config` (and `forge config`)
  now opens a three-knob landing screen: pick **Heavy** (architect,
  supervisor), **Standard** (engineer, bug-fixer, qa-engineer,
  product-manager), or **Light** (collator, librarian, orchestrator) —
  one model per tier and all nine personas are configured in under 30
  seconds. Tier selections commit immediately (no separate save step).
  Scope toggles between project and global per tier-pick.
- **`forge config show --resolved`** — prints a phase-by-phase table
  showing which model runs each step, which persona handles it, and where
  the assignment comes from (tier baseline, persona override, step
  override, or pi-current fallback).
- **`forge config dispatch [--pipeline=<name>] [--json]`** — per-phase
  dispatch trace without making an LLM call. Shows the resolved model
  and source for every phase of the chosen pipeline.
- **`forge config show --strict-models`** — validates that every
  resolved model exists in the authenticated provider catalog. Exits
  non-zero if any persona or step resolves to an unavailable model.
- **Advanced menu** — per-persona and per-step overrides are reachable
  from a dedicated "Advanced" screen, clearly separated from the
  primary tier knobs. Explanation banners explain that most users
  don't need these.
- **Observability** — each phase now logs `requested_model` and
  `model_observed` so users can verify that the intended model ran.

### Changed
- **Bug-fix pipeline uses same persona routing** — `runBugPipeline`
  now dispatches via `resolveModelForPhase` for every phase, consistent
  with the task pipeline.
- **Config TUI theming + width safety** — all screens use the pi TUI
  theme (accent, muted, warning, border, etc.) and truncate to
  terminal width via `safeLines`. Adaptive-width confirm-quit dialog.
- **Config TUI `top-menu` removed** — replaced entirely by the tier-menu
  landing screen. The `isEmpty` state snapshot is now a selector
  (`isConfigEmpty`) derived from the buffer.

### Fixed
- **Forge-project detection** — `forge config` detects a Forge project
  by the presence of `.forge/config.json` (not `.pi/`).
- **Dirty tracking + confirm-quit** — save clears dirty; quit while
  dirty opens a themed modal instead of exiting immediately.
- **Scroll for long pickers** — provider and model pickers window
  around the cursor when lists exceed the viewport.

## [0.8.4] — 2026-05-18

### Changed
- **`/changelog` always shows all three tabs** — pi, forge-plugin, and forge-cli
  chips now appear in the strip and detail view regardless of whether each
  component has a new version since the last session. Components that haven't
  advanced show their current-version release notes; components that have
  advanced show the full `from → to` range.

## [0.8.3] — 2026-05-18

### Fixed
- **`/changelog` autocomplete conflict resolved** — vendored pi bumped to
  `0.75.1-forge.4`, which removes `changelog` from `BUILTIN_SLASH_COMMANDS`.
  The forge `/changelog` extension command now registers cleanly without the
  "conflicts with built-in interactive command. Skipping in autocomplete."
  warning and appears in the autocomplete list.

## [0.8.2] — 2026-05-18

### Changed
- **`/changelog` overrides pi's built-in** — pi `0.75.1-forge.3` allows
  extension commands to shadow the built-in `/changelog` handler. The forge
  three-component TUI strip (pi + forge-plugin + forge-cli with ←→ chip
  navigation and Enter→detail view via `setOutputSource`) is now what runs
  when users type `/changelog`.
- **`/whats-new` retired** — `/changelog` is the single entry point for the
  forge changelog widget.

## [0.8.1] — 2026-05-18

### Fixed
- **Pi changelog banner loop fixed** — vendored pi bumped to `0.75.1-forge.2`.
  `getNewEntries` now strips pre-release suffixes (e.g. `-forge.1`) before
  numeric parsing. Without this, `"1-forge"` parsed as `NaN → 0`, recording
  the last-seen version as `0.75.0` every session so the `0.75.1` entry
  perpetually re-qualified as new.
- **Pi changelog banner suppressed** — `PI_SKIP_CHANGELOG=1` set
  unconditionally at bin startup. forge-cli ships the `/changelog` TUI widget
  (`whats-new-widget.ts`) covering all three components; pi's single-component
  banner is redundant.

## [0.8.0] — 2026-05-18

### Added
- **`forge update` CLI subcommand** — guided upgrade (`npm i -g`) at the bin
  layer alongside the existing `/forge:update` slash command. Supports
  `--check` (exit 2 if upgrade available), `--yes` (skip confirm),
  `--version <spec>` (pin to a specific release).
- **Forge-owned update banner** — `update-check.ts` now advertises
  `forge update` as the primary upgrade path in addition to the raw
  `npm i -g` form, so the suggested command is always reachable.

### Changed
- **Pi update banners suppressed** — `PI_SKIP_VERSION_CHECK=1` and
  `PI_SKIP_PACKAGE_UPDATE_CHECK=1` are set unconditionally at bin startup.
  Pi's "Run pi update" advice is unreachable for forge users (bundled-dep
  bins are not linked at the OS level). Forge owns the only update surface.
- **Vendored pi bumped to 0.75.1-forge.1** — adds `PI_SKIP_PACKAGE_UPDATE_CHECK`
  env-var gate to `checkForPackageUpdates`. Other three pi packages remain
  at plain `0.75.1`.

## [0.7.11] — 2026-05-18

### Changed
- **Vendored pi bumped to 0.75.1** (from 0.74.2). Absorbs 30 upstream
  commits from `earendil-works/pi` including the v0.75.0 and v0.75.1
  releases. Notable upstream fixes: OpenAI Responses HTTP status
  prefixing (auto-retry on 5xx/429), Bedrock unknown-content-block
  resilience, Azure OpenAI status normalization, Windows npm-shim
  spawn fix, compaction streamFn routing, OpenAI Codex model-list
  refresh, copilot gpt minimal-thinking mapping. Our
  `setOutputSource` divergence preserved end-to-end.

## [0.7.10] — 2026-05-17

### Fixed
- **FORGE-BUG-036 (critical):** Bundled `dist/forge-payload/tools/lib/`
  now includes `suggest.cjs`. Without it, every invocation of the bundled
  `store-cli.cjs` crashed with `Error: Cannot find module './suggest.cjs'`
  because `validate.js` requires it. Root cause: `LIB_ALLOWLIST` in
  `scripts/build-payload.cjs` was not updated when FORGE-S22-T03 added the
  suggest module. All store operations (read/write/emit/update-status) from
  forge-cli now work; agents no longer have to fall back to manual JSON
  writes that bypass schema validation.
- **bundledVersion alignment.** `package.json` `forge.bundledVersion` now
  reports `0.43.19` (matches actual bundled plugin source).

### Added
- **Regression test** `test/extensions/forgecli/bug-036-payload-lib-completeness.test.ts`
  walks every `require('./X')` in bundled `tools/lib/` and asserts each target
  exists in the bundle. Catches future LIB_ALLOWLIST omissions on every build.

## [0.7.9] — 2026-05-17

### Added
- **What's New strip.** Single-row interactive widget below the editor
  (same surface as the thread-switcher) that summarizes change counts
  across pi, forge-plugin, and forge-cli since last login. Auto-mounts
  on `session_start` when any of the three has advanced; ↓ activates,
  ←→ navigates between component chips, Enter expands the focused
  component's full changelog into the chat viewport, Esc dismisses and
  collapses the replay baseline.
- **`/whats-new` slash command.** Echoes the overall summary into the
  main chat container and re-mounts the strip for drill-down. Falls
  back to a text-only notify in headless / RPC mode. Subcommands:
  `/whats-new dismiss` clears the replay baseline.
- **Dual-baseline replay state.** `~/.cache/forgecli/whats-new-seen.json`
  tracks `seen` (auto-dismiss versions), `prev*` (replay baseline before
  explicit dismiss), and `lastShownFrom*` (frozen from-versions of the
  most recently shown set). `/whats-new` after dismissal replays the
  last-shown set indefinitely until the next version bump refreshes it.
- **Bundled CHANGELOG sources.** `build-payload.cjs` now copies
  `forge/CHANGELOG.md` → `dist/CHANGELOG-forge-plugin.md` and the
  installed `@earendil-works/pi-coding-agent/CHANGELOG.md` →
  `dist/CHANGELOG-pi.md`, pinning changelog content to the bundled
  versions and avoiding `node_modules` archaeology at runtime.

## [0.7.8] — 2026-05-17

### Changed
- **Docs:** README links to the 4ge.sh marketing site and `curl | sh`
  installer one-liner.
- **Internal:** reverted the experimental `@entelligentsia/pi-*`
  rescope in vendor-pi; bundled tarballs keep the upstream
  `@earendil-works/pi-*` namespace so weekly pi-mono syncs stay
  conflict-free.

## [0.7.7] — 2026-05-16

### Added
- **4ge brand identity in the CLI banner.** The startup header now
  renders the pixel `4ge` wordmark in place of the previous ANSI-Shadow
  "FORGE" block letters, aligning the terminal experience with the
  README/npm hero art.
- **Two new themes shipped — forge-mono and forge-matrix.** Auto-
  installed into `~/.pi/agent/themes/` on session start, so pi's
  `/settings > theme` picker lists all three (forge-dark default,
  forge-mono refined monochrome, forge-matrix phosphor-green Matrix
  aesthetic).
- **Slim README with brand assets.** Marketing-facing README rebuilt
  around the 4ge hero image and a categorized command grid; deep
  technical content (CLI flags, hook safety net, custom tools,
  publishing) moved to `docs/`.

### Changed
- Tightened vertical spacing around the header (removed redundant
  leading Spacer, exactly one blank line above and below the wordmark).
- Theme install step is now generalized: every JSON under
  `forge-cli/themes/` is copied to the pi global theme dir (previously
  only `forge-dark.json` was).

## [0.7.6] — 2026-05-16

### Fixed
- `build-payload` now bundles the forge plugin command markdowns
  (`forge/forge/commands/*.md`) into `dist/forge-payload/commands/`.
  Without this step, `/forge:health`, `/forge:config`, and any other
  command routed via `delegateMarkdownCommand` failed with `ENOENT`
  against the installed payload.

### Changed
- `assertAudience` now treats `subagent` audience as advisory. Users
  can invoke every chain step manually (`/forge:review-plan`,
  `/forge:review-code`, `/forge:approve`, `/forge:commit`,
  `/forge:validate`) from the CLI — orchestrators are an auto-mode
  convenience, not the sole legitimate caller. `orchestrator-only`
  workflows still refuse subagent invocation as before. Workflow
  front-matter is unchanged; the audience field remains for
  documentation.

## [0.7.5] — 2026-05-16

### Changed
- `run-workflow` now narrates each phase to the main viewport: the engine
  emits `↪ <role>: "<first meaningful line>"` when the subagent first
  speaks, and `↩ <role>: "<last meaningful line>"` after the phase
  terminal — plus `◆ <summary>` when the node emitted one. The chip strip
  stays compact (glyph + role only); the narrative lives in chip[0] /
  main viewport so the user can scroll the story of the run.

### Reverted
- 0.7.4's chip-strip preview enrichment (`"<first>" … "<last>"`). The
  registry still captures `firstTurnPreview` / `lastTurnPreview` on each
  `PhaseSummary` — useful for future per-phase rendering — but the strip
  reverts to showing only `session.currentTurnPreview`.

## [0.7.4] — 2026-05-16

### Changed
- (Superseded by 0.7.5.) Thread-switcher strip preview was changed to
  show `"<first turn>" … "<last turn>"` from the most-recent phase. The
  intended UX target was the main viewport, not the chip strip — the
  strip change is reverted in 0.7.5. The `PhaseSummary.firstTurnPreview`
  / `lastTurnPreview` fields survive.

## [0.7.3] — 2026-05-16

### Added
- Workflow engine sessions now flow into the shared `SessionRegistry`, so
  `/forge:run-workflow` instances appear in the live thread-switcher chip
  strip alongside `/forge:run-task`, `/forge:run-sprint`, and `/forge:fix-bug`.
  Engine emits `startSession`/`startPhase`/`bumpTurn`/`setTurnPreview`/
  `recordToolStart`/`recordToolEnd`/`appendTail`/`completePhase`/
  `completeSession` at the right boundaries; LLM tool-use events are
  forwarded from the worker via the existing `onEvent` callback.
- Each node iteration is its own phase (`<nodeId>#<iter>` for loop bodies)
  so the chip strip shows per-iteration progress.

## [0.7.2] — 2026-05-15

### Fixed
- `/forge:run-workflow` now resolves `<workflowId>` against `CWD/workflows/<id>` first,
  then falls back to the bundled `PKG_ROOT/workflows/<id>`. Previously the install dir
  was the only search path, so user-authored workflows in their project tree were
  ignored.

## [0.7.1] — 2026-05-15

### Added
- Workflow engine: conditional edges via `when: "<path> <op> <literal>"` — first matching
  success edge wins, falls back to unconditional edge. Supports `==`, `!=`, `<`, `<=`, `>`, `>=`
  against dotted paths into `state.*` or `loop.item.*`.
- Workflow engine: `loop.group` + `loop.head` for per-item pipelines. Multiple nodes
  sharing a `group` share one cursor — execution flows item-by-item through the
  pipeline rather than node-by-node across all items. Group exit is expressed as
  `edges: - { from: <head>, on: exhausted, to: <next> }`.
- `workflows/lead-qualifier/` — demo workflow exercising both features. Intake produces
  N leads; each lead flows `enrich → score → (warm: draft-outreach | cold: mark-cold)` per
  the `score >= 4` predicate; final `digest` writes `BRIEF.md`.

## [0.7.0] — 2026-05-15

### Added
- Generic workflow execution engine (`/forge:run-workflow <workflowId> [args]`) — PoC.
  Reads workflow.yaml + prompts/*.md from `workflows/<workflowId>/`. Runs a node graph
  with LLM workers. Persists state, events, and artifacts under `.forge-wf/runs/<instanceId>/`.
  Includes the `research-brief` example workflow (5 nodes, 3 in a loop).
  Plan 14.

## [0.6.6] — 2026-05-15

Sprint finalization ceremony (Plan 12). Pairs with forge-plugin 0.43.16.

### Added

- `dispatchSprintCeremony` helper in `run-sprint.ts` dispatches architect subagent
  against the materialized `architect_review_sprint_completion` workflow for sprint
  finalization. The orchestrator (not the subagent) owns event emission (Slice-2
  contract). Three exit branches per the Plan 12 truth table:
  - **Clean-complete**: architect ceremony in `mode: "complete"`, sprint transitions
    to `completed`, emit `sprint-complete` event with `verdict: "complete"`.
  - **User-paused** (>=1 task done): architect ceremony in `mode: "partial"`, sprint
    transitions to `partially-completed`, emit `sprint-complete` event with
    `verdict: "partial"` and `pausedAfterTaskIndex`.
  - **User-paused** (0 tasks done): no ceremony, no event, state persisted.
  - **Halted-on-failure**: no ceremony, emit `sprint-halted` event with
    `haltedAtTaskIndex`, `haltedAtTaskId`, `lastError`; state persisted with
    `halted: true`.
- `sprint-halted` event emission on task failure (no ceremony dispatch, per Plan 12 section 3).
- Schema-validated `sprint-complete` and `sprint-halted` events with forward-compat
  `waveCount` and `maxConcurrency` fields (always 1 for sequential).

### Changed

- Removed broken `sprint-collate-complete` event type (was rejected by schema
  validation). Replaced with schema-valid `sprint-complete` and `sprint-halted`
  variants via conditional `allOf`/`if`/`then` branches in `event.schema.json`.
- Workflow `architect_review_sprint_completion` step-4 now gates status transition
  on verdict: `Approved` -> `completed`, `Revision Required` + `partial` ->
  `partially-completed`, `Revision Required` + `complete` -> no transition.
- `validate-store.cjs` allOf interpreter now supports `enum` predicates in
  `if.properties` (not just `const`). Required for the task-scoped event type
  branch that uses an enum list instead of a single const.

### Bundled

- forge-plugin: 0.43.15 -> **0.43.16** (schema variants, workflow gating, validator
  enum support).

## [0.6.5] — 2026-05-14

Telemetry contract Slice 2 — the runtime emit site. Pairs with
forge-plugin 0.43.14 (workflow + fragment + friction-emit + backfill).

### Changed

- `runForgeSubagent` now surfaces `provider` on its `SubagentResult` alongside `model` and `usage`. The provider is captured directly from the per-turn `AssistantMessage.provider` field on the pi event stream — no env-var dance, no global state. Composes recursively: depth N records depth N+1's runtime attribution. Auto-exported transcripts include the resolved provider in the JSON header.
- `run-task.ts` becomes the orchestrator side of the new event-emission contract. After each `runForgeSubagent` returns successfully, the orchestrator:
  1. Reads the task record once to resolve `sprintId`.
  2. Composes the canonical phase event from runtime telemetry (`result.model`, `result.provider`, `result.usage`), known task context (`taskId`, `sprintId`, `phase`, `iteration`), bracketed wall times, and the judgement blob the subagent wrote to `task.summaries.{key}`.
  3. Emits via `node $FORGE_ROOT/tools/store-cli.cjs emit {sprintId} '{...}'` with `tokenSource: "reported"` whenever usage was non-zero.
  4. Drains `.forge/cache/FRICTION-{phase}.jsonl` (written by the new `friction-emit.cjs` tool on the subagent side), stamps each judgement-only record with the subagent's runtime attribution, emits as event type `"friction"`, and truncates the file only after all emits succeed.
- Subagents no longer call `store-cli emit` for phase events. The workflow prompts in forge-plugin 0.43.14 enforce this; this change is the runtime that takes over the emission responsibility.
- `scripts/build-payload.cjs` bundles the two new forge-plugin tools (`friction-emit.cjs`, `backfill-provider.cjs`) so they ship in the global install.

### Bundled

- forge-plugin: 0.43.13 → **0.43.14** (telemetry contract Slice 2 — workflow/fragment rewrites + `friction-emit.cjs` + `backfill-provider.cjs`).

## [0.6.4] — 2026-05-14

### Fixed

- `/forge:regenerate` now refreshes `.forge/schemas/` from the bundled `.schemas/` payload. Previously only workflows, personas, skills, templates, and commands were re-materialized — schemas were copied only at install time by `/forge:init`. With this fix, projects pick up forge-plugin schema changes (e.g. the 0.43.13 telemetry contract: `provider` required, `estimatedCostUSD` dropped) on the same `/forge:regenerate` call that updates workflows referencing them. Without this, regenerated workflows assumed the new contract while on-disk schemas still enforced the old one, causing silent validation drift. Notification text now reports the schema-refresh count.

### Bundled

- forge-plugin: 0.43.12 → **0.43.13** (telemetry contract Slice 1 + bundled-`.schemas/` runtime lookup in store-cli).

## [0.6.3] — 2026-05-14

Thread-switcher UX — single-viewport subagent tail browsing. Activates
pi-mono fork at @entelligentsia/pi-* @ 0.75.0.

### Added

- `/forge:threads` slash command + Ctrl+T shortcut. One-row chip strip
  below the editor. While active: ←→ navigate chips, Enter focuses a
  thread into the main chat viewport, Esc snaps back to main.
- Per-phase tail buffer in SessionRegistry (bounded ring, 2048 lines).
  Subagent tool events, assistant-turn previews, compaction, and retry
  events appended as one-line formatted entries `[<phase> HH:MM:SS] …`.
- Unread-warning counter per phase: subagent tool errors append with
  `warning:true`, surfacing as `◆` on the chip strip. Focusing the
  phase clears the counter.

### Changed

- `forge.bundledVersion`: unchanged (0.43.12).
- Subagent tool errors no longer surface as multi-line `⚠ … failed`
  ctx.ui.notify blocks on the main thread. They're captured in the
  per-phase tail (readable via the switcher) plus the existing debug
  JSONL + transcript dumps.
- Pi runtime: forge-cli now consumes @entelligentsia/pi-coding-agent,
  pi-ai, pi-tui (pi-mono @ 0.75.0) via local file: refs. Adds the
  ctx.ui.setOutputSource(component | null) extension API needed to
  swap the chat viewport's render source on user command.

### Notes

- Legacy `/forge:sessions` widget (two-pane session monitor) is still
  registered. Will be removed after the new switcher proves out.

## [0.6.2] — 2026-05-14

Bundled forge plugin bumped to v0.43.12 — fixes silent fragment drop
in `/forge:regenerate` output.

### Changed

- `forge.bundledVersion`: `0.43.11` → `0.43.12`. The plugin's
  `build-base-pack.cjs` previously hardcoded a 4-fragment allowlist,
  so `_fragments/store-cli-verbs.md` (forge#95) and `_fragments/friction-emit.md`
  (FORGE-S20-T01) never reached the `.base-pack/workflows/_fragments/`
  shipped to users. Workflow bodies referenced both fragments but the
  fragment files were missing after `/forge:regenerate`, regressing
  store-cli verb fumbles and event-shape iteration that #95/#87 were
  meant to kill. Both builders now enumerate fragments dynamically.
- No forge-cli source changes. Carrier-only bump.

## [0.6.1] — 2026-05-13

HLO-S01 friction-fix sweep — bundled forge plugin bumped to v0.43.11.

### Changed

- `forge.bundledVersion`: `0.43.10` → `0.43.11`. New bundle covers ten
  friction fixes batched from the 2026-05-13 testbench dogfood
  (umbrella forge#93): meta-review-plan text drift (#78/#76), event.type
  enum widening (#80), task FSM `planned → implemented` (#79), inline
  FSM transition tables (#96), store-cli verb cheat-sheet fragment
  (#95), runtime-conditional `/cost` probe (#84), surfaced
  `commands.test` in workflow bodies (#94), `--force` gated behind
  `FORGE_ALLOW_FORCE` + canonical event-shape (#87), commit_task author
  fix (#82), native `--task-suffix` / `--sprint-suffix` flags
  (forge-cli#5 tools piece).
- No forge-cli source changes in this release. Carrier-only bump.

## [0.5.7] — 2026-05-10

FORGE-S20-T04 sprint-completion gap fix (paired with forge plugin v0.43.3).

### Headline

`hello` testbench triggered `× forge:enhance — workflow not found at .forge/workflows/enhance.md; run /forge:init or /forge:regenerate first.` on every fresh init. Root cause: T04 added the native /forge:enhance kickoff shim (enhance.ts) reading `.forge/workflows/enhance.md`, but the bundled forge plugin never shipped that file. build-base-pack.cjs only handled commands/enhance.md via the ENHANCE_AGENT_SENTINEL path; the workflow side was absent. The T04 spec line — "resolves meta-enhance.md from bundled payload" — was not honoured by the implementation.

### Fixed

- Bumped bundled forge plugin from `0.43.2` → `0.43.3`. The new bundle ships `init/base-pack/workflows/enhance.md` (generated from `meta-enhance.md` via the standard transformWorkflow path) carrying the four Pack-06 markers required by the kickoff shim (Iron Laws, Store-Write Verification, `forge_store` token, `engineer.md` persona path). enhance.md remains `audience: orchestrator-only` and is exempt from the 4KB phase-file byte budget.
- `/forge:enhance` now dispatches successfully on fresh init.

### Added

- `bundled-base-pack-markers.test.ts` — third assertion exercising `dist/forge-payload/.base-pack/workflows/enhance.md` against `enhance.checkMaterialization`. Catches future bundle bumps that drop enhance.md or its markers.

### Notes

- Existing projects on `0.43.2` need `/forge:regenerate` after `/forge:update` to materialize `.forge/workflows/enhance.md`.

## [0.5.6] — 2026-05-10

Pack-06 materialization-marker regression fix (paired with forge plugin v0.43.2).

### Headline

`hello` testbench observed `/forge:plan` (and `/forge:implement`) hard-failing every fresh init with `× workflow regression: Store-Write Verification not found in /home/.../.forge/workflows/plan_task.md` plus three siblings (`Iron Laws`, `forge_store`, `persona file path (architect)`). Root cause: FORGE-S20-T05/T06 added kickoff-shim materialization preconditions but the corresponding meta sources (`forge/forge/meta/workflows/meta-plan-task.md`, `meta-implement.md`) never gained those sections. The base-pack regen produced workflows that the kickoff shim refused to dispatch.

### Fixed

- Bumped bundled forge plugin from `0.43.1` → `0.43.2`. The new bundle ships `plan_task.md` + `implement_plan.md` with all four Pack-06 markers (Iron Laws, Store-Write Verification, `forge_store` token, `architect.md`/`engineer.md` persona path).
- `/forge:plan` and `/forge:implement` kickoff shims now successfully validate the bundled workflows on fresh init.

### Added

- `test/extensions/forgecli/bundled-base-pack-markers.test.ts` — regression guard that runs `checkMaterialization` against the real bundled `dist/forge-payload/.base-pack/workflows/{plan_task,implement_plan}.md` (not a fixture). Catches future bundle bumps that drop markers.

### Notes

- Existing projects on `0.43.1` need to run `/forge:regenerate` after `/forge:update` to pick up the new markers in their `.forge/workflows/`.

## [0.5.5] — 2026-05-10

Hot-fix: 0.5.4 shipped with the source-side verify code accidentally reverted by an in-conversation `git checkout` during testing. The CHANGELOG, package.json bump, and test updates all landed but `forge-init.ts` did not. v0.5.5 lands the actual implementation.

### Added

- All v0.5.4 changes per CHANGELOG below — for real this time. `verifyPhase1/2/3` helpers + Phase 1+2 retry-once-then-confirm loop + Phase 3 hard-fail + final report banner gated on cross-phase verify.
- `non-interactive mode` describe block beforeEach updated to match outer beforeEach defaults (was overriding with old null-config setup).

## [0.5.4] — 2026-05-10

`/forge:init` per-phase verify + retry + recover.

### Headline

`hello` testbench observed `/forge:init` printing "complete" while `.forge/workflows/` was empty — `forge:sprint-intake` then died with `workflow not found at .forge/workflows/architect_sprint_intake.md`. Root cause: Phase 1 fired-and-forgot. When the agent skipped the deliverable (model said "I don't have a subagent tool"), Phase 3's `substitute-placeholders.cjs` ran against a missing config and silently produced zero workflows; Phase 4 still printed "complete".

### Added

- **Per-phase verifiers** in `src/extensions/forgecli/forge-init.ts`:
  - `verifyPhase1(cwd)` — `.forge/config.json` exists + parses + has `version`, `project.{name,prefix}`, `stack`, `commands`, `paths.{engineering,store,workflows}`.
  - `verifyPhase2(cwd, kbPath)` — all 7 architecture docs present.
  - `verifyPhase3(cwd)` — all 4 materialized dirs (`.forge/{workflows,personas,skills,templates}`) non-empty.
- **Phase 1 + Phase 2 verify-retry-confirm loop**: on first verify fail, send a corrective steer ("write the file now using `write` tool, do NOT call subagents"), wait idle, re-verify. On second fail in interactive mode, prompt user to abort or continue with partial init. In non-interactive mode, hard-fail with explicit error.
- **Phase 3 hard-fail**: `substitute-placeholders.cjs` is invoked via `runToolAdvisory` (no exception on failure); the post-phase `verifyPhase3` now catches the silent-zero-output case and aborts the pipeline with a recovery hint (`/forge:regenerate`).
- **Final report banner** gated on cross-phase verify (`verifyPhase1 + verifyPhase3`). When either fails, banner reads `/forge:init incomplete — see gaps below` and lists the specific missing artifacts plus recovery commands. The "complete" banner is no longer a lie.

### Changed

- Test harness `beforeEach` defaults updated to keep the verify path passing for tests that don't exercise it: `mockFs.existsSync` returns true for `config.json` only; `readFileSync` returns a complete sample config; `readdirSync` returns one stub entry for each `.forge/{workflows,personas,skills,templates}` dir.
- 4 existing tests' `forge:init complete` string-match relaxed to `Knowledge base:` (more robust to banner text changes; the `Knowledge base:` line appears in both complete and incomplete banners).
- `bug-023-prompt-blocking` test reset to use the new flow; `G3-custom-folder` test now uses `mockImplementation(() => true)` instead of `mockReturnValue(true)` (clearer intent; avoids the impl-vs-returnValue stacking quirk).

### Tests

406/406 vitest pass. New verify branches covered transitively by the existing 38 forge-init tests.

## [0.5.3] — 2026-05-10

UX: KB-folder confirm question rephrased so default-Yes is the safe path.

### Changed

- `forge-init.ts:528` — KB-folder gate question changed from `Does "engineering" conflict with an existing folder in this project?` (default-Yes meant unsafe path: trigger custom-name flow) to `Use "engineering" as the folder name?` (default-Yes = use default; pick No only if a real conflict exists). Pi's `ctx.ui.confirm` exposes no `defaultValue` option, so the question text has to align with the highlighted default. Updated 2 tests in `forge-init.test.ts` G3 group.

## [0.5.2] — 2026-05-10

Hot-patch: `forge_ask_user` UI rendering — text/choice prompts now show the question.

### Headline

Cartographer testbench: `/forge:sprint-intake` interview "got stuck — no Q visible". Root cause: `ask-user-tool.ts` passed the constant tag `"forge:ask_user"` as the dialog title for every type. Pi's `ctx.ui.input(title, placeholder)` rendered the question as faded ghost-text in the placeholder slot (vanished on first keystroke); `ctx.ui.select(title, options)` has no question slot at all, so users only saw the option list. Only `confirm` worked because pi's confirm signature is `(title, message)` and the question landed in the message body.

### Changed

- `src/extensions/forgecli/ask-user-tool.ts` — every type now passes `params.question` as the dialog title:
  - `confirm(question, "", opts)`
  - `select(question, options, opts)`
  - `input(question, default ?? "", opts)` — `default` becomes the placeholder hint.
- Added `ctx.ui.notify("forge:ask_user — <question>", "info")` before the dialog so the source-tag provenance is visible without crowding the dialog title.
- Updated 2 existing test assertions (test 5 select, test 8 input) to match new arg shape. 14/14 tests pass; 406/406 full suite.

## [0.5.1] — 2026-05-10

Hot-patch: direct-exec contract for forge tools. Pairs with forge-plugin v0.43.1.

### Headline

Cartographer testbench observed haiku-4-5 burning 26-220s per `bash forge store ...` shell-out — each invocation cold-started a fresh pi/agent loop because `forge` had no `store` subcommand. Native MCP `forge_store` tool also failed on 3-arg `write sprint <id> <json>` form (store-cli requires 2-arg). Net: 600x perf regression on store-write-heavy workflows.

### Added

- **Bin fast-path subcommands** (`src/bin/argv.ts`, `src/bin/forge.ts`) — `forge {store|collate|validate-store|store-query} <args>` now bypasses pi entirely and exec's the bundled `.tools/<name>.cjs` directly via `spawnSync`. Cold-start drops from ~26s to ~50ms. Whitelist defined in `FAST_PATH_SUBCOMMANDS`. 7 new vitest cases on the parser.
- **System-prompt tool-discipline block** (`src/extensions/forgecli/forge-tools.ts:registerForgeToolDiscipline`) — appended to every system prompt via `pi.on("before_agent_start", ...)`. Prescribes: prefer named MCP tools over bash, canonical 2-positional `forge_store` write shape, `forge_store_template` before write, no `bash forge store ...` shell-out.

### Changed

- **`forge_store` MCP description + parameters** (`forge-tools.ts`) — rewritten to enumerate every store-cli subcommand with exact arg counts and worked examples. Highlights the common 3-arg-write footgun.
- **Kickoff prompts** rewritten to instruct named MCP tool calls instead of colloquial `forge_store ...` text:
  - `sprint-intake.ts:56` — explicit `{command:'write', args:['sprint','<json>']}` with template-first guidance.
  - `sprint-plan.ts:76` — same for task-write loop.
  - `plan.ts:166-167`, `implement.ts:171-172`, `enhance.ts:206` — `update-status` and Pack-06 refs rewritten to canonical MCP-call form.

### Bundled

- Forge plugin bumped 0.43.0 → **0.43.1** (`forge.bundledVersion`). Brings `init/base-pack/workflows/*.md` and `_fragments/*.md` rewrites: all `/forge:store ...` slash refs replaced with `node "$FORGE_ROOT/tools/store-cli.cjs" ...` direct-cjs form.

## [0.5.0] — 2026-05-10

Headline: Foundation finish — central loaders + 3 native kickoff handlers + FS-level boundary guard. SDLC core path self-hosted on pi.

### △ Breaking

- **`/forge:plan` and `/forge:implement` legacy markdown-stub fallback DELETED** (FORGE-S20-T05, T06). The pre-S20 path injected a workflow markdown body into the user's prompt when no native handler was registered. With T05 (`plan.ts`) and T06 (`implement.ts`) shipping native Kickoff Shims, the fallback is removed. Users on a custom fork that still relied on stub injection must port to the native handler API. Stock forge-cli users see no behaviour change beyond improved kickoff reliability.

### Added

- **Central persona/skill loader** (FORGE-S20-T02) — `loaders/persona.ts`, `loaders/skill.ts`. Single source for resolving `meta-<persona>.md` / `meta-<skill>.md` from the bundled payload. Reused by all native kickoff handlers.
- **Shared template-render helper** (FORGE-S20-T03) — `helpers/template-render.ts`. Mustache-style placeholder substitution for kickoff message composition; centralizes formatting across enhance/plan/implement.
- **`/forge:enhance` Phase 2 native kickoff handler** (FORGE-S20-T04) — `enhance.ts`. Replaces the prior `/forge:enhance` markdown stub with a native Kickoff Shim. Argv parses `--phase` and free-form text; composes kickoff via T02+T03; calls `pi.sendUserMessage()` with `deliverAs:"steer"`.
- **`/forge:plan` native kickoff handler** (FORGE-S20-T05) — `plan.ts`. Native port; legacy fallback deleted (see Breaking).
- **`/forge:implement` native kickoff handler** (FORGE-S20-T06) — `implement.ts`. Native port mirroring T05; materialization-marker check pre-dispatch; legacy fallback deleted (see Breaking).
- **FS-level two-layer boundary guard hook** (FORGE-S20-T07) — `hooks/two-layer-guard.ts`. Blocks tool calls that would write to `forge/forge/meta/` or non-`.forge/` paths owned by the Forge plugin from inside forge-cli runtime. Issue #24 enforcement promoted from engineer-discipline to FS layer.
- **Bundled-tools regression test** (FORGE-S20-T08) — extends BUG-029 layout-detection coverage. Smoke gate ensures all four affected MCP tools (`forge_config`, `forge_store`, `forge_validate_store`, `forge_collate`) succeed against the flat bundled layout.
- **forge-plugin bundled bump 0.41.0 → 0.43.0** — picks up the friction-emit channel (workflows + event schema + validate-store) from FORGE-S20 T00/T01 and the v0.42.0 catch-up content (substitute-placeholders `--target pi`, store-cli `describe`/`template`, validate hint).
- **`forge_store_describe` MCP tool** — returns the raw JSON Schema for a Forge store entity (sprint/task/bug/event/feature). Wraps `store-cli.cjs describe`. Enables LLMs to inspect schema before writing.
- **`forge_store_template` MCP tool** — returns a canonical sample record with all required fields populated (enum first-value, ISO date-time, ID placeholders). Wraps `store-cli.cjs template`. Reduces write→reject→retry friction. See forge#3 for phase 2/3 (per-entity TypeBox tools + harness one-shot injection).
- **`forge_store_query` MCP tool** — natural-language and structured queries over the Forge store. Wraps `store-cli.cjs` query/nlp/schema dispatch (delegates to `store-query.cjs`). Closes the tool-gap surfaced in forge-cli#2 — non-Anthropic models can now find tasks/bugs/sprints/features by intent without scanning JSON manually. Bundled deps: `store-query.cjs` + `lib/{store-facade,store-nlp,store-query-exec}.cjs`.

### Fixed

- **forge-tools layout detection (FORGE-BUG-029)** — `forge_config`, `forge_store`, `forge_validate_store`, and `forge_collate` MCP tools failed with "Cannot find module" when `paths.forgeRoot` pointed at the flat bundled payload (`dist/forge-payload/.tools/`). `forge-tools.ts` was unconditionally appending a `tools/` segment, valid only for the Claude-plugin nested layout. New `resolveToolDir()` probes for `<forgeRoot>/tools/` and falls back to flat layout when absent. Two regression tests (test 11/12) cover both layouts.
- **bundle CJS scope marker (FORGE-BUG-030)** — bundled `.tools/lib/validate.js` and `lib/result.js` failed with `ReferenceError: module is not defined in ES module scope` because forge-cli's `package.json` declares `"type":"module"`, making `.js` files in the bundle resolve as ESM. `scripts/build-payload.cjs` now writes a `package.json` scope marker (`{"type":"commonjs"}`) into `dist/forge-payload/.tools/` so `.js` files in that subtree resolve as CommonJS. New smoke gates E2E-12 (scope-marker presence) and E2E-13 (`store-cli.cjs --help` runs without ESM scope error).

### Changed

- **sprint-intake handler — LLM-driven kickoff (FORGE-BUG-031)** — retired the deterministic TUI interview shipped in FORGE-S19-T01. `sprint-intake.ts` (768 → 106 lines) now parses argv (empty | `@<file>` | free-form text), reads `.forge/workflows/architect_sprint_intake.md`, composes a kickoff message, and calls `pi.sendUserMessage()` to hand control to the LLM. The LLM drives the conversational interview using `forge_store`, `forge_ask_user`, `read`, `write`, and `forge_collate`. Removed `sprint-intake.test.ts` (14 TUI tests), retired smoke gates E2E-08/09 (`FORGE_NON_INTERACTIVE`, `FORGE_INTAKE_ANSWERS_FILE`). Motivation: TUI captured raw input as sprint dir name producing malformed dirs (`Add/`, `S02/`, `"add/`) and lost the elicitation intelligence of the Claude-plugin flow.
- **sprint-plan handler — LLM-driven kickoff (FORGE-BUG-032)** — retired the deterministic JSON-mode subagent call shipped in FORGE-S19-T02. `sprint-plan.ts` (606 → 138 lines) now parses argv (`<SPRINT_ID> [@<file> | <text>]`), reads `SPRINT_REQUIREMENTS.md` or `REQUIREMENTS.md` alias, composes a kickoff with `architect_sprint_plan.md`, and calls `pi.sendUserMessage()`. LLM drives task decomposition conversationally, writing tasks via `forge_store write task` one at a time — no rigid JSON-array contract, no 2-attempt retry cap. Removed `sprint-plan.test.ts` and retired E2E-10 / `FORGE_SPRINT_PLAN_FIXTURE`. Motivation: emberglow testbench hit cascading failures with glm-5.1:cloud returning non-array output, plus accepted bare/wrong-prefix sprint IDs and lacked filename alias.

## [0.4.0] — 2026-05-09

Headline: Native sprint-intake + sprint-plan handlers — forge-cli takes over the SDLC entry path for S20+.

### Added

- **`usage-hook.ts`: Pi-runtime token telemetry hook** (FORGE-S19-T03 / FORGE-BUG-028).
  Registers `pi.on("message_end")` listener that accumulates per-turn token usage
  from `AssistantMessage.usage` (`input`, `output`, `cacheRead`, `cacheWrite`,
  `cost.total`). Closes the 3-sprint `source=missing` regression (S15–S18).
  `registerUsageHook(pi, opts)` returns an accumulator `Map<phaseKey, UsageAccumulator>`.
  `flushPhaseUsage(opts)` writes `store-cli record-usage` sidecar with `source=reported`.
  Phase key via `FORGE_PHASE_KEY` env var. Non-blocking: subprocess failure → stderr
  warn; non-assistant messages silently skipped. Iron Law 6: `spawnSync` argv array.
  Wired in `index.ts` alongside `registerHookDispatcher`. 8 auth-free vitest tests.

- **`/forge:sprint-plan` native TS handler** (FORGE-S19-T02).
  Full LLM-driven sprint decomposition. Pre-flight: reads `SPRINT_REQUIREMENTS.md`
  from `{engineeringDir}/sprints/{SPRINT_ID}/` (config-resolved); verifies sprint is
  in `planning` status. Persona self-load from `.forge/personas/architect.md` (🗻).
  LLM invocation via vendored subagent spawn pattern (`./subagent/index.js`) — confirmed
  correct by SPIKE_NOTES.md after scanning `@entelligentsia/pi-coding-agent` types
  (`pi.invokeLLM` absent on ExtensionAPI). Prompt loaded from
  `dist/forge-payload/.tools/prompts/sprint-plan-prompt.md` (new).
  JSON output validated against `dist/forge-payload/.tools/schemas/task-list.schema.json`
  (new TypeBox-compatible schema). First failure retries once with error context
  appended; second failure writes raw output to `.forge/cache/sprint-plan-failure-{ID}.json`
  and aborts. Kahn's algorithm cycle detection after validation, before store writes.
  Per-task records written via `store-cli write task` (argv array form, Iron Law 6).
  `SPRINT_PLAN.md` rendered inline with mermaid dep graph (zero-dependency case
  emits valid node-only graph). Per-task `TASK_PROMPT.md` written under
  `engineering/sprints/{SPRINT_ID}/{TASK_ID}/`. Sprint status `planning → planned`
  via `store-cli update-status`. `sprint-plan-complete` event emitted.
  `forge:sprint-plan` added to `EXPLICITLY_REGISTERED_NAMES` (renamed from
  `REAL_HANDLERS`) in `forge-commands.ts`. Registered in `index.ts` before
  `registerAllForgeCommands`. `scripts/build-payload.cjs` updated with Pass 2g to
  copy `src/extensions/forgecli/prompts/` and `schemas/` into
  `dist/forge-payload/.tools/`. 14 vitest tests. E2E-10 (`FORGE_SPRINT_PLAN_FIXTURE`
  scripted fixture run) added to `test/e2e/smoke.sh`.

- **`/forge:sprint-intake` native TS handler** (FORGE-S19-T01).
  Full multi-turn TUI interview for sprint requirements capture. Adapts
  `meta-sprint-intake.md` 4-step algorithm to pi `ctx.ui.input/confirm/select`
  calls. Pre-flight reads `paths.engineering` from `.forge/config.json`; aborts
  if no `.forge/` found. Persona self-load from `.forge/personas/product-manager.md`.
  Context load: `MASTER_INDEX.md`, `architecture/stack.md`, open bugs and features.
  Captures: working title, theme, goals (loop with severity via `ctx.ui.select` and
  per-goal ACs), out-of-scope items, constraints, risks (with likelihood select),
  carry-over items (auto-detected from previous `SPRINT_RETROSPECTIVE.md`).
  Resumable via `.forge/cache/sprint-intake-{SPRINT_ID}.json` checkpoint.
  Non-interactive mode (`FORGE_NON_INTERACTIVE=1` / `FORGE_YES=1`) refuses with
  actionable error. `SPRINT_REQUIREMENTS.md` rendered via template substitution
  from `.base-pack/templates/SPRINT_REQUIREMENTS_TEMPLATE.md`. Sprint manifest
  record written via `store-cli write sprint` (argv array, Iron Law 6 compliant).
  `sprint-intake-complete` event emitted via `store-cli emit`. 14 vitest tests.
  E2E-08 (non-interactive abort) and E2E-09 (`FORGE_INTAKE_ANSWERS_FILE` scripted
  run) gates added to `test/e2e/smoke.sh`.

- **`scripts/verify-readme-changelog.cjs`: README↔CHANGELOG diff verifier** (FORGE-S19-T04).
  Hard release gate at `scripts/verify-readme-changelog.cjs` — pure CJS, zero npm
  dependencies. Reads `package.json:version`, `README.md`, `CHANGELOG.md` from CWD
  or `--root <path>`. Asserts every `## [X.Y.Z]` CHANGELOG heading since `[0.1.0]`
  (baseline exempt) has at least one mention in README. Asserts README roadmap
  `Shipped (X.Y.Z)` matches `package.json:version`; warns (not fails) if no roadmap
  section. Hard FAIL with actionable diff output on first mismatch. `--allow-section-skip`
  escape hatch suppresses roadmap check. Wired into `test/e2e/smoke.sh` as E2E-11.
  5 vitest tests with synthetic fixtures.

- **`scripts/verify-publish.cjs`: post-publish npm-view check** (FORGE-S19-T05).
  Mandatory post-publish verifier at `scripts/verify-publish.cjs` — pure CJS, zero
  npm dependencies. Accepts `--version <VERSION>` (required), `--package <PKG>`
  (defaults to `package.json:name`), `--allow-non-latest`, `--root <path>`. Runs
  `npm view <PKG>@<VERSION> version` and asserts trimmed output matches `<VERSION>`.
  Runs `npm view <PKG> dist-tags --json` and asserts `latest === <VERSION>` (hard
  fail without `--allow-non-latest`; warn-only with flag). On any npm non-zero exit
  or network failure: logs `[warn] registry check failed — verify manually:
  npm view <PKG>@<VERSION>` and exits 1. Iron Law 6 compliant: `spawnSync` argv
  array, no shell interpolation. 4 vitest tests covering success, version mismatch,
  network failure, and `--allow-non-latest` behaviour.

---

## [0.3.0] — 2026-05-09

Headline: Pi-runtime parity adapters — interactive UX + hook safety net.
`forge:ask_user` delivers real TUI prompts for all `/forge:init` gate sites;
the hook safety net enforces store-cli write validity and legal status
transitions at runtime. Fixes BUG-026 (non-blocking Y/N prompts) and BUG-027
(unguarded store-cli writes under pi runtime).

### Added

- **`forge:ask_user` custom tool** (FORGE-S18-T04).
  Registers `forge_ask_user` via `pi.registerTool`. Accepts `{question, type, options?, default?}`
  where `type` is `confirm` (Y/N), `choice` (select from list), or `text` (free-form input).
  Uses `ctx.ui.confirm / select / input` from the pi `ExtensionContext` — no raw pi-tui
  component wiring needed. Blocks the model loop until the user responds. Non-interactive
  bypass: `FORGE_YES=1`, `--non-interactive`, or headless mode returns the default
  immediately. Cancellation surfaces as `isError: true`. 14 Vitest tests.

- **`registerHookDispatcher` wired to `tool_call` / `tool_result`** (FORGE-S18-T02).
  Replaces the 7-line empty shim with a real implementation. Subscribes both pi events
  (wired to tool_call/tool_result; enforcement layer added by T03).
  Exports `parseStoreCLIInvocation()` + `StoreCLICall` interface for T03 to layer
  validation on top. Hook inventory document produced at
  `engineering/sprints/FORGE-S18/FORGE-S18-T02/HOOK_INVENTORY.md`.

- **Store-cli pushback correction loop + audit-log mode** (FORGE-S18-T03).
  Extends the T02 hook-dispatcher scaffold from audit-only to enforcement.
  `store-validator.ts` spawns `store-cli validate` synchronously on every write call;
  `transition-guard.ts` enforces the legal status-transition table for task/sprint/bug
  records. Returns `{ block: true, reason }` on violation. `FORGE_HOOK_AUDIT=1` logs
  every decision (would-block/would-allow) with timestamp, entity, reason — returns
  `undefined` (allow-through) regardless, enabling observation without disruption.
  Closes FORGE-BUG-027.

### Changed

- **Gate sites in `/forge:init` now use `forge:ask_user`** (FORGE-S18-T05). G2
  (pre-flight phase selector) and G3 (KB folder prompt) replaced from
  `sendToAgent+waitForIdle` to `ctx.ui.confirm / ctx.ui.input`. Operator receives a
  real TUI prompt instead of model-generated text. Gate audit captured in
  `GATE_AUDIT.md`.

### Fixed

- **BUG-026** — Pi runtime: TUI Y/N prompts in command bodies don't wait for user
  input. Fixed by `forge:ask_user` tool (T04) + gate-site retrofit (T05). `/forge:init`
  gate sites G2 and G3 now use `ctx.ui.confirm/input` and block until the operator
  responds.
- **BUG-027** — Pi runtime: validation hooks not wired — store-cli writes unguarded,
  no pushback correction loop. Fixed by hook adapter (T02) + enforcement layer (T03).
  `registerHookDispatcher` intercepts `store-cli write` and `store-cli update-status`
  calls, validates against schema and transition table, returns `{ block: true, reason }`
  on violation.

---

## [0.2.1] — 2026-05-09

Headline: Non-interactive mode for CI and scripted use. `FORGE_YES=1` and
`forge --non-interactive` both bypass every Y/N gate in `/forge:init`, resolving
each to its documented default. Unblocks scripted adoption immediately (BUG-026
short-circuit; T04/T05 deliver the real interactive TUI path).

### Added

- **`--non-interactive` CLI flag** (FORGE-S18-T01). Parsed by `argv.ts`,
  sets `FORGE_NON_INTERACTIVE=1`. Documented in `--help` output.
- **`FORGE_YES=1` environment variable** (FORGE-S18-T01). Ergonomic shorthand
  for scripts (`FORGE_YES=1 forge`). Checked alongside `FORGE_NON_INTERACTIVE`.
- **`isNonInteractive()` helper** in `forge-init.ts`. Bypasses G1 (resume
  confirm), G2 (pre-flight phase selector), G3 (KB folder name), G4 (CLAUDE.md
  create confirm) when active.
- **README non-interactive mode section** — flag, env var, and default-resolution
  table for all four gate sites.
- **Vitest gate coverage** — 12 new test cases covering each gate under
  interactive, `FORGE_NON_INTERACTIVE=1`, and `FORGE_YES=1` arms.
- **E2E smoke gates E2E-04/05/06** — auth-free checks that flag and env vars
  are accepted without errors.

## [0.2.0] — 2026-05-09

Headline: `/forge:init` is now a real implementation. The 0.1.0 stub at
`src/extensions/forgecli/index.ts:77-82` is replaced with a full-parity port of
the Claude-Code plugin's `/forge:init` flow. Default payload trimmed by 35.8%
unpacked. Tarball size-budget gate enforced in smoke + CI.

### Added

- **`/forge:init` real implementation** (FORGE-S17-T02). Full parity to the
  plugin: 4-phase flow, `--fast` / `--full` flags, resume detection via
  `.forge/init-progress.json`, hero banner with project-name discovery, idempotent
  re-run. Consumes `dist/forge-payload/`, substitutes placeholders against user
  project context, writes `.forge/{personas,skills,workflows,templates,config.json,project-context.json}`.
- **Tarball size-budget gate** (FORGE-S17-T05) at
  `test/e2e/lib/tarball-size-gate.sh` (sourceable) plus
  `test/e2e/size-budget.test.sh` (18 boundary assertions). Smoke gate runs after
  `npm pack` with PASS / WARN (>35 MB) / FAIL (>50 MB) status. Thresholds
  env-overridable via `FORGE_TARBALL_SIZE_*`.
- **`scripts/build-payload.cjs --include-full`** flag and `--help`
  (FORGE-S17-T04). Opt-in to the legacy un-trimmed payload for forensic /
  round-trip verification — round-trip verified byte-exact.
- **Mid-sprint runtime fixes** (FORGE-BUG-017..025) — `/forge:init` runtime
  defects discovered during init-port adaptation review; pi-aware
  `paths.forgeRoot`; skip Claude-Code-only command output during init.

### Changed

- **Default payload trimmed by 35.8% unpacked** (FORGE-S17-T03 audit applied
  by FORGE-S17-T04). Files 175 → 105, unpacked 704,388 → 452,445 bytes,
  forge-payload tar.gz 194,067 → 123,505 bytes (−36.4%). Trim sites:
  - top-level `personas/skills/workflows/templates/` removed (Pass 1 vestige,
    never read at runtime),
  - `.tools/lib/` allowlisted to runtime-loaded subset
    (`forge-root, paths, pricing, project-root, result.js, validate.js`),
  - `.init/generation/` reduced to `generate-kb-doc.md`,
  - `.schemas/` reduced to `*.schema.json`.
- **Full `npm pack` output** (the published artifact, with bundled pi runtime
  as bulk): 30.42 MB compressed, 19.58 MB headroom under the 50 MB hard gate.

### Documentation

- README updated with size-budget tuning surface and trimmed-payload note.

### Bundled / pinned (unchanged from 0.1.0)

- `@entelligentsia/pi-coding-agent@0.74.0`,
  `@entelligentsia/pi-ai@0.74.0`,
  `@entelligentsia/pi-tui@0.74.0` via `bundledDependencies`.
- `forge.bundledVersion: 0.40.3` (`Entelligentsia/forge@v0.40.3`) — drift audit
  clean, no upstream movement during sprint.

## [0.1.0] — 2026-05-08

First public stable release of `@entelligentsia/forgecli` — the Forge SDLC
ported onto `@entelligentsia/pi-coding-agent`.

### Added

- **Three bin entries** (`forge`, `forgecli`, `4ge`) all routing to the same
  launcher. `4ge` and `forgecli` exist as collision-free aliases when the
  Foundry `forge` is on `$PATH`.
- **Bundled pi runtime.** `@entelligentsia/pi-coding-agent@0.74.0`,
  `@entelligentsia/pi-ai@0.74.0`, and `@entelligentsia/pi-tui@0.74.0` are
  shipped via `bundledDependencies`, insulating installs from upstream
  npm-scope churn.
- **Bundled forge plugin payload** at `Entelligentsia/forge@v0.40.3`,
  re-shaped from the Claude-Code source layout via
  `substitute-placeholders.cjs --target pi`. Pin captured in
  `package.json:forge.bundledVersion`.
- **Five `/forge:*` slash commands** registered as native pi commands
  (FORGE-S16-T04): `/forge:ask`, `/forge:plan`, `/forge:run-task`,
  `/forge:run-sprint`, `/forge:health`.
- **Forge tools as pi custom tools** (FORGE-S16-T03): TypeBox-typed wrappers
  over `forge/tools/*.cjs` with argv-array invocation (no shell-string
  interpolation).
- **Curated provider/model registry** (FORGE-S16-T16) at
  `registry/models.json` covering six providers; missing-credentials banner
  surfaces the exact env var to set on first launch.
- **Default-on update-check probe and banner** (FORGE-S16-T14) — checks npm
  registry for newer `@entelligentsia/forgecli` and the GitHub releases API
  for newer `Entelligentsia/forge`. Two outbound URLs only; opt-out via
  `FORGE_NO_UPDATE_CHECK=1` or `--no-update-check`.
- **`/forge:update` guided upgrade** (FORGE-S16-T15) — surfaces the upgrade
  command for forge-cli itself and prompts for project migrations when the
  installed forge plugin drifts from the bundled version.
- **Functional pre-publish E2E smoke gate** (FORGE-S16-T11) — auth-free
  gates mandatory; auth-required gates run when `ANTHROPIC_API_KEY` is
  present.

### Distribution

- License: **MIT**.
- Stable-only `latest` dist-tag on npm; no `next` or `dev` channels (Q20).
- Public, scoped under `@entelligentsia` (Q22).
- Node.js `>=20.6.0` (matches pi-coding-agent's engines requirement).

### Out of scope for 0.1.0

- Multi-platform / multi-Node-version smoke matrix (deferred to v1.0).
- Telemetry / phone-home of any kind (Q21: none).
- `claude-agent-sdk` plan-limit support (deferred to S17+).
- Cost telemetry surfacing in `/forge:*` (waived for S16).

[0.5.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.5.0
[0.4.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.4.0
[0.3.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.3.0
[0.2.1]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.2.1
[0.2.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.1.0
