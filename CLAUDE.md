# forge-cli — Engineering Notes

This file documents the **test-suite policy** introduced by FORGE-S25-T02. It
is intentionally narrow: it covers only the topics this task landed
(test-suite discovery, no-skip policy, spike-archive policy, e2e gate, CI
surface). Broader forge-cli architecture and Iron Laws are documented in:

- `../CLAUDE.md` (outer `forge-engineering/CLAUDE.md`) — cross-repo
  architecture, four-repo layout, decision rules.
- `.claude/skills/forge-cli-engineer/SKILL.md` (in the outer repo) — full
  Iron Laws and skill-pack router.

## Test-suite policy

Vitest discovery is configured by `vitest.config.ts` at the clone root.

**Includes** (positive list — extend explicitly to add a new test category):

- `test/*.test.ts`
- `test/bin/**/*.test.ts`
- `test/extensions/forgecli/**/*.test.ts`

**Excludes** (defence in depth — never run automatically):

- `test/poc/**`
- `test/.archive/**`
- `test/e2e/**`
- `test/fixtures/**`
- `node_modules/**`, `dist/**`

Adding a new test category requires editing `vitest.config.ts` to extend
`test.include`. Do NOT rely on the default vitest glob — it would re-introduce
the spike-noise problem this policy fixes (finding ST-6).

## No skipped or focused tests

The committed test surface MUST NOT contain any of:

- `it.skip`, `it.only`
- `test.skip`, `test.only`
- `describe.skip`, `describe.only`
- `xit(`, `xdescribe(`

Enforced by `tools/check-no-skipped-tests.cjs` + `npm run lint:no-skip` + the
`tests.yml` CI workflow. Bypassing the gate requires a documented Iron-Law
amendment, not a one-off skip.

Secondary warn-only check: `// FIXME: skip…` and `// TODO: re-enable…` markers
are reported on stderr but do not fail CI. They signal known re-enable work.

The meta-test `test/check-no-skipped-tests.test.ts` legitimately embeds the
forbidden patterns as fixture-string literals; it is allowlisted by exact path
inside the script.

## Spike archive policy

Completed or abandoned spikes live under `test/.archive/spikes/<name>/`. They
are:

- Read-only.
- Excluded from vitest by `vitest.config.ts`.
- Runtime-invoked only under an explicit `FORGE_*=1` env flag from
  `src/extensions/forgecli/index.ts` (CI never sets those flags).

Spike lifecycle (no fourth state):

1. New spike → `test/poc/<name>/` (active).
2. Promoted → moved into `test/extensions/forgecli/…` with real specs.
3. Archived → moved into `test/.archive/spikes/<name>/` with `git mv`.

See `test/.archive/README.md` for the archive inventory and the new-archive
checklist.

## E2E gate

`test/e2e/smoke.sh` is wrapped by `npm run test:e2e` for local-developer
convenience. The script:

- Always runs auth-free gates.
- Skips auth-required gates cleanly when `ANTHROPIC_API_KEY` is unset.

**CI invocation is unchanged.** The `smoke.yml` workflow (FORGE-S16-T11)
invokes `./test/e2e/smoke.sh` directly. The `npm run test:e2e` script is
additive — a local convenience and a future migration path.

The other `test/e2e/*.test.sh` files (`friction-emit-bundled.test.sh`,
`size-budget.test.sh`) are invoked internally by `smoke.sh`; they are not
wired as separate npm scripts.

## CI surface

Two GitHub Actions workflows. Sibling, independent, both gate PRs to `main`:

| Workflow | Owns | Steps |
|----------|------|-------|
| `.github/workflows/smoke.yml` (FORGE-S16-T11) | full build + e2e | `npm ci` → sibling-forge clone → `npm run build` → `./test/e2e/smoke.sh` |
| `.github/workflows/smoke.yml :: tmp-smoke` (FORGE-S25-T03) | fresh tmp project gate | same install + `./test/e2e/tmp-smoke.sh` after `smoke` |
| `.github/workflows/tests.yml` (FORGE-S25-T02) | fast gates | `npm ci` → `npm run typecheck` → `npm run lint:no-skip` → `npm run lint:layering` → `npm test` |

The `tests.yml` workflow does **not** invoke `npm run build` or
`./test/e2e/smoke.sh` — those remain owned by `smoke.yml`. Workflow
consolidation is out of scope (deferred to FORGE-S25-T28).

## Tmp-smoke gate

`test/e2e/tmp-smoke.sh` (FORGE-S25-T03) is the canonical AC #5 working-product
gate referenced by every Phase 1+ task in FORGE-S25. Sibling of `smoke.sh`
but with a different scope: where `smoke.sh` exercises pack/install/CLI
surface against the bundled payload, `tmp-smoke.sh` provisions a fresh
OS-tmpdir project from scratch and exercises three golden-path Forge surfaces:

1. `/forge:init --fast` — auth-free structural assertions against the
   Fast-mode invariants in `forge/forge/init/smoke-test.md`.
2. `/forge:plan SMOKE-TMP-S01-T01` against a seeded fixture sprint —
   auth-required; skips cleanly without `ANTHROPIC_API_KEY` (per the
   `SKIP_REASON=env:<VAR>` convention surfaced in SUMMARY.md).
3. `/forge:health` (auth-free subset) via `validate-store --dry-run` +
   `generation-manifest check`.

Local invocation: `npm run smoke:tmp` (or `bash test/e2e/tmp-smoke.sh`).
Idempotent: every run rebuilds the install prefix and creates a fresh
`mktemp -d` project, deleted on EXIT trap unless `FORGE_TMP_SMOKE_KEEP=1`.

Plugin-source override: set `FORGE_TMP_SMOKE_PLUGIN_SRC=/path/to/forge/source`
to rsync an in-tree plugin checkout over the installed payload before init.
This is how the plugin-side `plugin-ci.yml` `tmp-smoke` job gates plugin PRs
against the latest forge-cli driver.

CI: `smoke.yml :: tmp-smoke` runs in the forge-cli repo after the `smoke`
job. `plugin-ci.yml :: tmp-smoke` runs in the plugin repo after
`tests-and-skip-gate`, clones forge-cli at `main`, and points the override
at the in-tree plugin source.

## CI Gates

Five gates run on every push/PR to `main` via
`.github/workflows/tests.yml` (`tests-and-skip-gate` job):

| Gate | Command | What it checks |
|------|---------|----------------|
| Typecheck | `npm run typecheck` | `tsc --noEmit` — no TypeScript errors |
| No skipped or focused tests | `npm run lint:no-skip` | No `it.skip`, `test.skip`, `describe.skip`, `it.only`, `describe.only`, `test.only`, `xit`, `xdescribe` in committed tests |
| Import-layering gate | `npm run lint:layering` | `src/extensions/forgecli/lib/` and `paths/` relative-import only within themselves; `parsers/` only within itself or into `lib/`. Rules live in `tools/check-import-layering.cjs` (`LAYER_RULES`) |
| Vitest | `npm test` | All unit tests under `test/*.test.ts`, `test/bin/**/*.test.ts`, `test/extensions/forgecli/**/*.test.ts` pass |
| Dead-code gate (knip) | `npm run dead-code` | No unused exports or dead files in `src/`; configuration in `knip.config.ts` |

### Fixing knip failures locally

```bash
npm run dead-code          # show findings
npm run dead-code -- --fix # auto-remove unused exports where safe
```

If a finding is a legitimate false-positive (e.g. a dynamic-dispatch entry
consumed by the pi framework), add a justified suppression to `knip.config.ts`
under `ignoreIssues` with an inline comment explaining why.

See `knip.config.ts` for the current suppression list and rationale.
