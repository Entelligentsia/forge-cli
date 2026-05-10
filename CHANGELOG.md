# Changelog

All notable changes to `@entelligentsia/forgecli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  correct by SPIKE_NOTES.md after scanning `@earendil-works/pi-coding-agent` types
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

- `@earendil-works/pi-coding-agent@0.74.0`,
  `@earendil-works/pi-ai@0.74.0`,
  `@earendil-works/pi-tui@0.74.0` via `bundledDependencies`.
- `forge.bundledVersion: 0.40.3` (`Entelligentsia/forge@v0.40.3`) — drift audit
  clean, no upstream movement during sprint.

## [0.1.0] — 2026-05-08

First public stable release of `@entelligentsia/forgecli` — the Forge SDLC
ported onto `@earendil-works/pi-coding-agent`.

### Added

- **Three bin entries** (`forge`, `forgecli`, `4ge`) all routing to the same
  launcher. `4ge` and `forgecli` exist as collision-free aliases when the
  Foundry `forge` is on `$PATH`.
- **Bundled pi runtime.** `@earendil-works/pi-coding-agent@0.74.0`,
  `@earendil-works/pi-ai@0.74.0`, and `@earendil-works/pi-tui@0.74.0` are
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
