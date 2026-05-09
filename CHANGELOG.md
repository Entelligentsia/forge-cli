# Changelog

All notable changes to `@entelligentsia/forgecli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.3.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.3.0
[0.2.1]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.2.1
[0.2.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/Entelligentsia/forge-cli/releases/tag/v0.1.0
