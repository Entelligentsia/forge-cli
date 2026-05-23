# forge-cli `lib/` Layer — Module Reference

This document describes the shared utility modules under
`src/extensions/forgecli/lib/`. These modules were extracted in FORGE-S25
sprints T16–T18 to eliminate code duplication, centralise shared logic, and
improve testability. FORGE-S25-T22 also closed two root-level consolidations:
`store-error-remediation.ts` moved from `lib/` to root (S-7), and
`forge-tools.ts` adopted `resolveToolDir` from `store-resolver.ts` (N-C-D).

---

## Overview

The `lib/` directory contains **pure utility modules** — no pi runtime context,
no UI calls, no event emission. Each module has a corresponding unit test file
under `test/extensions/forgecli/lib/`.

| Module | Landing task | Findings closed |
|--------|-------------|-----------------|
| `catalog-helpers.ts` | T16 | H-4, N-H-G |
| `frontmatter-parser.ts` | T16 | H-4 |
| `manifest-checker.ts` | T16 | — |
| `orchestrator-preflight.ts` | T17 | — |
| `orchestrator-types.ts` | T17 | — |
| `spawn-store-cli.ts` | T17 | — |
| `state-helpers.ts` | T17 | — |
| `store-cli-timeouts.ts` | T17 | — |
| `shared-fs-utils.ts` | T18 | C-16, S-3 |
| `forge-config.ts` | T18 | C-3, S-13 |
| `exec-helpers.ts` | T18 | N-C-E |
| `versions.ts` | T18 | B-1 |

**Root-level module (not in `lib/`):**

| Module | Landing task | Findings closed | Notes |
|--------|-------------|-----------------|-------|
| `store-error-remediation.ts` | T22 | S-7 | Moved from `lib/` — single-file dir not justified |

**Consolidation (T22):**

| Change | Finding | Notes |
|--------|---------|-------|
| `forge-tools.ts` imports `resolveToolDir` from `store-resolver.ts` | N-C-D | Private duplicate deleted; `runCjs` kept separate (incompatible signature) |

---

## Modules (T18)

### `lib/shared-fs-utils.ts`

Exports `isFile(p: string): boolean` and `isDirectory(p: string): boolean`.

Both helpers wrap `fs.statSync` in a try/catch and return `false` on any error
(ENOENT, EACCES, etc.). Use for path-existence probes where the caller does not
need to distinguish error kinds.

**Consumers:** `forge-root.ts`, `subagent/agents.ts`, `forge-tools.ts`,
`store-resolver.ts`, `migration-engine.ts`.

**Note for `migration-engine.ts`:** The original code rethrew non-ENOENT
errors from `statSync`. After migration, `isFile()` silently swallows all
errors. This is intentional in the migration engine context (optional file
copies must never crash the engine).

---

### `lib/forge-config.ts`

Exports:
- `discoverForgeConfigCached(cwd?: string): ForgeConfig | null` — memoized wrapper
  around `discoverForgeConfig()` from `forge-root.ts`. Caches `ForgeConfig | null`
  per `cwd` key in a module-level `Map`.
- `clearForgeConfigCache(): void` — clears all cache entries. Call in
  `beforeEach`/`afterEach` during tests to prevent cache bleed.

**CRITICAL INVARIANT:** Only `ForgeConfig | null` is cached — the result of
the directory walk-up phase. `LayeredConfig` (produced by `loadLayeredConfig`)
is NOT cached here. T20 retains full access to `LayeredConfig.errors` for the
N-B-E fix.

**Consumers:** `run-task.ts`, `run-sprint.ts`, `fix-bug.ts`,
`loaders/persona-skill-loader.ts`, `index.ts`.

---

### `lib/exec-helpers.ts`

Exports:
- `execFileAsync` — `promisify(execFile)`, the standard async execFile wrapper.
- `ExecFileAsyncType` — type alias for `typeof execFileAsync`.

**Not migrated:** `forge-update-command.ts` (uses an injectable `runner`
parameter for test isolation — a different architectural concern).

**Consumers:** `forge-tools.ts`, `store-resolver.ts`.

---

### `lib/versions.ts`

Exports version-reading utilities shared by `src/extensions/forgecli/index.ts`
and `src/bin/forge.ts`. All functions accept a `pkgRoot: string` parameter
(the resolved package root directory) so each caller can pass in the root it
has already resolved via `import.meta.url` or `__dirname`.

| Export | Type | Description |
|--------|------|-------------|
| `readForgeCliVersion(pkgRoot)` | `string` | CLI version from `package.json` |
| `readBundledPluginVersion(pkgRoot)` | `string` | Plugin version from `dist/forge-payload/…/plugin.json` (falls back to `package.json` mirror) |
| `readPiVersionAsync()` | `Promise<string>` | pi-coding-agent version via `import.meta.resolve` |
| `readPkgVersionsSync(pkgRoot)` | `{ cliVersion, bundledForgeVersion }` | Sync pair for module-load init |
| `readForgeCliPkg(pkgRoot)` | `ForgePkg` | Raw parsed `package.json` |

**`index.ts` path:** `PKG_ROOT` = 3 levels up from `dist/extensions/forgecli/`.

**`bin/forge.ts` path:** `BIN_PKG_ROOT` = 2 levels up from `dist/bin/`.

---

## Adding a new lib module

1. Create `src/extensions/forgecli/lib/<module>.ts`.
2. Create `test/extensions/forgecli/lib/<module>.test.ts` with at least one
   regression test.
3. Add an entry to this document.
4. The module is automatically picked up by vitest (covered by
   `test/extensions/forgecli/**/*.test.ts` in `vitest.config.ts`).

---

## Test isolation

`forge-config.ts` maintains a module-level cache. Tests that exercise config
discovery MUST call `clearForgeConfigCache()` in `beforeEach`/`afterEach` to
prevent cache bleed. See `test/extensions/forgecli/lib/forge-config.test.ts`
for the pattern.
