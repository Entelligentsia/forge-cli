// store-friction-regression.test.ts — FORGE-S22-T01
//
// ============================================================================
// Mode A — REPLAY-ONLY regression harness for store-cli friction.
// ----------------------------------------------------------------------------
// Iron Laws (grep-enforceable; do NOT relax without an explicit ADR):
//
//   1. NO child_process. No spawn / exec / execSync / fork / spawnSync.
//      No `import('node:child_process')`, no `require('child_process')`.
//      This suite is REPLAY only — it never invokes `store-cli`.
//   2. NO reads of `.forge/store/`. The only data source is the frozen
//      fixture at `test/fixtures/store-ops.jsonl`.
//   3. NO env mutation. `process.env.* = …` is forbidden in this file.
//   4. NO filesystem writes outside `os.tmpdir()`. (This file writes nothing.)
//   5. SHA256 + line count of the fixture are pinned. Silent corruption fails
//      the test, not the benchmark.
//
// Drift policy (informational, not enforced by code):
//   - Per-pattern upper guards = empirical baseline + 1pp (regression).
//   - Per-pattern lower guards = baseline − 5pp triggers a "ratchet candidate"
//     warning. Test still PASSES; reviewer must update the baseline + this
//     header + FINDINGS.md in the same commit before the next regression run.
//   - Aggregate 21.8% ± 0.1pp is FROZEN. Fixture is immutable; the only way
//     this assertion can fail is if someone re-rolls the fixture without
//     updating the pinned constant (which the SHA256 check catches first).
//
// Sprint goal (≤12% aggregate) is NOT enforced by this suite. The fixture is
// historical (cae3af4 of forge-engineering, 109 transcripts, 927 ops). Live-
// mode enforcement of the ≤12% gate is deferred to a later task once live-
// replay landing in forge-cli is approved.
//
// Baseline source of truth: forge-cli/test/analysis/store-friction/FINDINGS.md
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Pinned constants — keep in sync with FINDINGS.md and store-ops.README.md.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = resolve(__dirname, "../../fixtures/store-ops.jsonl");
const FIXTURE_SHA256 =
  "ab72c142eb6398a126dcdc8c5b9cb11bbff5576958ef84e0409dbbd2abe6fd14";
const FIXTURE_LINES = 927;
const FIXTURE_TRANSCRIPTS = 109;

// Per-pattern baselines (FINDINGS.md, "Top subcommand failure rates").
const BASELINES: Record<string, { ops: number; errors: number; ratePct: number }> = {
  get: { ops: 39, errors: 35, ratePct: 89.7 },
  emit: { ops: 168, errors: 66, ratePct: 39.3 },
  "update-status": { ops: 170, errors: 59, ratePct: 34.7 },
};
const UPPER_DELTA_PP = 1.0; // regression-guard slack
const RATCHET_DROP_PP = 5.0; // "you improved — update baseline" warning

// Aggregate baseline (FINDINGS.md header: 202/927 = 21.8%).
const AGG_BASELINE_PCT = 21.8;
const AGG_TOLERANCE_PP = 0.1;

// Anti-pattern baselines (FINDINGS.md, "Shape anti-patterns").
const ANTIPATTERN_3ARG_WRITE_MAX = 0;
const ANTIPATTERN_EMIT_NONID_FIRST_MAX = 168;

// Performance budget.
const WALLCLOCK_BUDGET_MS = 5000;

// ---------------------------------------------------------------------------
// Fixture types — mirrors the producer in test/analysis/store-friction/.
// ---------------------------------------------------------------------------

interface Op {
  transcript: string;
  persona: string;
  tag: string;
  model: string;
  provider: string;
  callIdx: number;
  channel: string; // "bash-store-cli" | "bash-collate" | "bash-manage-config"
  subcommand: string; // "get" | "emit" | "update-status" | "write" | …
  entity: string | null;
  argShape: string[]; // ["ID","JSON",…]
  rawCmd: string;
  isError: boolean;
  errKeys: string[];
  errSnippet: string;
}

// ---------------------------------------------------------------------------
// Loader — performs the integrity contract before returning any data.
// ---------------------------------------------------------------------------

function loadFixture(): { ops: Op[]; raw: string } {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha !== FIXTURE_SHA256) {
    throw new Error(
      `fixture corruption: SHA256 mismatch.\n  expected ${FIXTURE_SHA256}\n  actual   ${sha}\n` +
        "If you intentionally re-rolled the fixture, update FIXTURE_SHA256, " +
        "FIXTURE_LINES, and store-ops.README.md in the same commit."
    );
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length !== FIXTURE_LINES) {
    throw new Error(
      `fixture corruption: line count ${lines.length} !== ${FIXTURE_LINES}`
    );
  }
  const ops: Op[] = lines.map((line, i) => {
    try {
      return JSON.parse(line) as Op;
    } catch (err) {
      throw new Error(`fixture corruption: line ${i + 1} is not valid JSON: ${err}`);
    }
  });
  return { ops, raw };
}

// ---------------------------------------------------------------------------
// Anti-pattern matchers — one-liners with FINDINGS.md citations.
// ---------------------------------------------------------------------------

/** 3-arg write: `store-cli write <entity> <id> <json>` (FINDINGS.md "Shape anti-patterns"). */
function isThreeArgWrite(op: Op): boolean {
  if (op.channel !== "bash-store-cli" || op.subcommand !== "write") return false;
  const s = op.argShape;
  return s.length === 3 && s[0] !== "JSON" && s[1] !== "JSON" && s[2] === "JSON";
}

/** emit with non-ID first positional: synthetic/bare-string sprintId instead of an ID-shape token (FINDINGS.md "Shape anti-patterns"). */
function isEmitNonIdFirst(op: Op): boolean {
  if (op.channel !== "bash-store-cli" || op.subcommand !== "emit") return false;
  return op.argShape.length > 0 && op.argShape[0] !== "ID";
}

// ---------------------------------------------------------------------------
// Aggregators
// ---------------------------------------------------------------------------

function aggregate(ops: Op[]) {
  // All-channel aggregate (matches FINDINGS.md header denominator).
  const total = ops.length;
  const errors = ops.filter((o) => o.isError).length;

  // Per-(channel, subcommand) breakdown for the visibility floor.
  const perKey: Record<string, { ops: number; errors: number }> = {};
  for (const op of ops) {
    const key = `${op.channel}::${op.subcommand}`;
    if (!perKey[key]) perKey[key] = { ops: 0, errors: 0 };
    perKey[key].ops += 1;
    if (op.isError) perKey[key].errors += 1;
  }

  // Per-pattern stats for the guarded subcommands.
  const perPattern: Record<string, { ops: number; errors: number; ratePct: number }> = {};
  for (const sub of Object.keys(BASELINES)) {
    const k = `bash-store-cli::${sub}`;
    const v = perKey[k] ?? { ops: 0, errors: 0 };
    perPattern[sub] = {
      ops: v.ops,
      errors: v.errors,
      ratePct: v.ops === 0 ? 0 : (v.errors / v.ops) * 100,
    };
  }

  return { total, errors, perKey, perPattern };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("store-friction regression (Mode A replay)", () => {
  it("locks the historical baseline; ratchets warn but do not fail", () => {
    const start = performance.now();

    // ----- 1. Load + integrity --------------------------------------------
    const { ops } = loadFixture();
    const transcripts = new Set(ops.map((o) => o.transcript)).size;
    expect(transcripts, "transcript count drift").toBe(FIXTURE_TRANSCRIPTS);

    // ----- 2. Aggregate gate (21.8% ± 0.1pp) ------------------------------
    const agg = aggregate(ops);
    const aggPct = (agg.errors / agg.total) * 100;
    expect(
      Math.abs(aggPct - AGG_BASELINE_PCT),
      `aggregate failure rate drift: actual ${aggPct.toFixed(2)}% vs baseline ${AGG_BASELINE_PCT}% (±${AGG_TOLERANCE_PP}pp)`
    ).toBeLessThanOrEqual(AGG_TOLERANCE_PP);

    // ----- 3. Per-pattern upper + ratchet guards --------------------------
    const ratchetWarnings: string[] = [];
    for (const [sub, baseline] of Object.entries(BASELINES)) {
      const actual = agg.perPattern[sub];
      expect(
        actual.ops,
        `pattern '${sub}' op count drift: ${actual.ops} vs baseline ${baseline.ops}`
      ).toBe(baseline.ops);

      const upper = baseline.ratePct + UPPER_DELTA_PP;
      expect(
        actual.ratePct,
        `REGRESSION: pattern '${sub}' failure rate ${actual.ratePct.toFixed(2)}% exceeds upper guard ${upper.toFixed(2)}% (baseline ${baseline.ratePct}% + ${UPPER_DELTA_PP}pp)`
      ).toBeLessThanOrEqual(upper);

      const drop = baseline.ratePct - actual.ratePct;
      if (drop >= RATCHET_DROP_PP) {
        ratchetWarnings.push(
          `ratchet candidate: ${sub} dropped ${drop.toFixed(2)}pp ` +
            `(${baseline.ratePct}% -> ${actual.ratePct.toFixed(2)}%) — ` +
            `update BASELINES[${JSON.stringify(sub)}] + FINDINGS.md before merge`
        );
      }
    }

    // ----- 4. Anti-pattern guards -----------------------------------------
    const threeArgWrites = ops.filter(isThreeArgWrite).length;
    expect(
      threeArgWrites,
      `anti-pattern '3-arg write' resurfaced (count=${threeArgWrites}, max=${ANTIPATTERN_3ARG_WRITE_MAX})`
    ).toBe(ANTIPATTERN_3ARG_WRITE_MAX);

    const emitNonId = ops.filter(isEmitNonIdFirst).length;
    expect(
      emitNonId,
      `anti-pattern 'emit non-ID first positional' regressed (count=${emitNonId}, max=${ANTIPATTERN_EMIT_NONID_FIRST_MAX})`
    ).toBeLessThanOrEqual(ANTIPATTERN_EMIT_NONID_FIRST_MAX);

    // ----- 5. Visibility summary (advisory, prints all channels) ----------
    const summary = Object.entries(agg.perKey)
      .sort((a, b) => b[1].ops - a[1].ops)
      .map(([k, v]) => {
        const pct = v.ops === 0 ? 0 : (v.errors / v.ops) * 100;
        return `  ${k.padEnd(48)}  ops=${String(v.ops).padStart(4)}  err=${String(v.errors).padStart(3)}  ${pct.toFixed(1)}%`;
      })
      .join("\n");
    // eslint-disable-next-line no-console
    console.log(
      `\n[store-friction] visibility summary (all channels::subcommands):\n${summary}\n` +
        `[store-friction] aggregate: ${agg.errors}/${agg.total} = ${aggPct.toFixed(2)}%\n` +
        `[store-friction] transcripts: ${transcripts}\n` +
        (ratchetWarnings.length
          ? `[store-friction] ${ratchetWarnings.length} ratchet warning(s):\n  ` +
            ratchetWarnings.join("\n  ") +
            "\n"
          : "")
    );

    // ----- 6. Performance budget ------------------------------------------
    const elapsed = performance.now() - start;
    expect(
      elapsed,
      `wall-clock budget exceeded: ${elapsed.toFixed(0)}ms > ${WALLCLOCK_BUDGET_MS}ms`
    ).toBeLessThan(WALLCLOCK_BUDGET_MS);
  });
});
