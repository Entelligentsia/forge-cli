# Fixture: `store-ops.jsonl`

Frozen JSONL recording of `bash-store-cli`, `bash-collate`, and `bash-manage-config` operations extracted from real Forge transcripts. Used by `test/extensions/forgecli/store-friction-regression.test.ts` (replay-only / Mode A).

## Provenance

| Field | Value |
|---|---|
| Source dataset | Forge engineering transcripts (109 transcripts) |
| Op count | **927** |
| Transcript count | **109** |
| SHA256 | `ab72c142eb6398a126dcdc8c5b9cb11bbff5576958ef84e0409dbbd2abe6fd14` |
| Generator commit (forge-engineering) | `cae3af418d65800ae27b27eabce7d804c24d05ee` |
| Moved | 2026-05-17 (FORGE-S22-T01) |
| Origin path | `doc/analysis/store-friction/store-ops.jsonl` (forge-engineering repo, removed at move time) |
| Generator scripts | `forge-cli/test/analysis/store-friction/*.py` (reference only, not run by CI) |

## Integrity contract

The regression test recomputes SHA256 and line count on load and asserts both match the pinned constants above. **If you change this file, the test fails by design** — that is the silent-corruption guard. To roll a new fixture, update both the constant in the test file AND this README in the same commit.

## What the fixture is NOT

- Not a live store. The regression suite never spawns `store-cli`, never reads `.forge/store/`, never mutates env. See test header for the full Mode A Iron Laws.
- Not parameterized. Per-pattern + aggregate thresholds are pinned to the empirical baseline captured in `forge-cli/test/analysis/store-friction/FINDINGS.md`.

## Publish boundary

`forge-cli/package.json` `files` field does NOT include `test/`. `npm publish` (and `npm pack --dry-run`) will not ship this fixture or the analysis scripts.
