# `test/.archive/` — Spike Archive

This directory holds completed or abandoned spike artefacts that we keep on disk
for historical reference but **do not run automatically**.

## Policy

- **Read-only.** No new code, no fixes, no commentary edits beyond fixing
  broken cross-references after a move.
- **Excluded from vitest.** `vitest.config.ts` lists `test/.archive/**` under
  `test.exclude`, so nothing under here is discovered as a spec.
- **Env-gated runtime only.** If an archived spike still has a runtime entry
  point (see `spike-r1` below), it is invoked exclusively under an explicit
  `FORGE_*=1` environment flag from `src/extensions/forgecli/index.ts`. CI does
  not set those flags.
- **Not a graveyard for new code.** Anything placed here must have first lived
  in `test/poc/<name>/` as an active spike. The lifecycle is:
  1. New spike → `test/poc/<name>/` (active).
  2. Promoted → moved into `test/extensions/forgecli/…` with real specs.
  3. Archived → moved into `test/.archive/spikes/<name>/` (read-only).
  No fourth state.

## Contract for new archives

When you archive a spike:

1. Move the directory with `git mv` so history is preserved.
2. Confirm `vitest.config.ts` still lists `test/.archive/**` in `test.exclude`.
3. If the spike has a runtime caller, update that caller's path in the same
   commit; never leave dangling imports.
4. Append a one-line entry to the inventory below.

## Inventory

| Spike | Source sprint | Archived in | One-line description |
|-------|---------------|-------------|----------------------|
| `spike-r1` | FORGE-S15 | FORGE-S25-T02 | Subagent harness POC — env-gated runtime registration via `FORGE_SPIKE_R1=1` import in `src/extensions/forgecli/index.ts`. See `spike-r1/RESULT.md`. |
| `spike-r2` | FORGE-S15 | FORGE-S25-T02 | Pure documentation spike (`RESULT.md` only). No executable artefacts. |
