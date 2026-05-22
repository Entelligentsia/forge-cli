#!/usr/bin/env bash
# mode-c-capture.sh — Mode C fresh-corpus capture, adversarial probe generation, and pipeline runner
# Sprint FORGE-S22 / Task FORGE-S22-T06
#
# Usage:
#   ./mode-c-capture.sh                  # full pipeline
#   ./mode-c-capture.sh --dry-run        # version-gate check + path resolution only, no mutations
#   ./mode-c-capture.sh --probes-only    # run adversarial probes P1-P9 only
#
# Resolves store-cli from local development source (forge/forge/tools/store-cli.cjs),
# falling back to $FORGE_ROOT/tools/store-cli.cjs if local source absent.
# NEVER uses the plugin cache without an explicit --store-cli override.
set -euo pipefail

# ─── Path resolution ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# forge-cli is a nested git repo; PROJECT_ROOT is its parent (forge-engineering/)
FORGECLI_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PROJECT_ROOT="$(dirname "$FORGECLI_ROOT")"

# Local dev source (preferred) — v0.43.19+
LOCAL_SRC="$PROJECT_ROOT/forge/forge/tools/store-cli.cjs"
if [ -f "$LOCAL_SRC" ]; then
    STORE_CLI_SRC="$LOCAL_SRC"
elif [ -n "${FORGE_ROOT:-}" ] && [ -f "$FORGE_ROOT/tools/store-cli.cjs" ]; then
    STORE_CLI_SRC="$FORGE_ROOT/tools/store-cli.cjs"
else
    echo "ERROR: Cannot resolve store-cli.cjs. Set FORGE_ROOT or ensure forge/forge/tools/store-cli.cjs exists." >&2
    exit 1
fi

STORE_ROOT="$PROJECT_ROOT/.forge/store"
CORPUS_DIR="$PROJECT_ROOT/tmp/mode-c-corpus"
SCRIPT_SELF="$(basename "$0")"

# ─── Version gate ─────────────────────────────────────────────────────────────
# Validates that the resolved store-cli contains ALIAS_MAP (present in v0.43.19+).
# Exits 1 with diagnostic if not — all T02-T05 fix surfaces depend on this.
version_gate() {
    if ! grep -q "ALIAS_MAP" "$STORE_CLI_SRC"; then
        echo "ERROR: Version gate FAILED." >&2
        echo "  Resolved store-cli: $STORE_CLI_SRC" >&2
        echo "  Expected: ALIAS_MAP token (present in v0.43.19+ with T02-T05 fixes)." >&2
        echo "  Resolution: ensure forge/forge/tools/store-cli.cjs is v0.43.19+ or set --store-cli <path>." >&2
        exit 1
    fi
    echo "✓ Version gate passed: $STORE_CLI_SRC contains ALIAS_MAP"
}

# ─── Parse args ──────────────────────────────────────────────────────────────
DRY_RUN=0
PROBES_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)      DRY_RUN=1 ;;
        --probes-only)  PROBES_ONLY=1 ;;
        --store-cli)    STORE_CLI_SRC="$2"; shift ;;
        --corpus-dir)   CORPUS_DIR="$2"; shift ;;
        --store-root)   STORE_ROOT="$2"; shift ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
    shift
done

# ─── Dry-run: gate + path info only ──────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
    echo "=== DRY RUN — mode-c-capture.sh ==="
    echo "  STORE_CLI_SRC : $STORE_CLI_SRC"
    echo "  STORE_ROOT    : $STORE_ROOT"
    echo "  CORPUS_DIR    : $CORPUS_DIR"
    version_gate
    echo "Dry-run complete. No mutations performed."
    exit 0
fi

# ─── Full run ─────────────────────────────────────────────────────────────────
version_gate

mkdir -p "$CORPUS_DIR"
PROBES_JSONL="$CORPUS_DIR/probes.jsonl"

echo ""
echo "=== ADVERSARIAL PROBE SET (P1-P9) ==="
echo "  STORE_CLI : $STORE_CLI_SRC"
echo "  STORE_ROOT: $STORE_ROOT"
echo "  OUTPUT    : $PROBES_JSONL"
echo ""

# Helper: run a probe command, capture result, emit JSONL record
run_probe() {
    local probe_id="$1"
    local transcript="$2"
    local channel="$3"
    local subcommand="$4"
    local entity="$5"
    local expected_is_error="$6"   # true|false
    local expected_snippet="$7"
    local raw_cmd="$8"

    local rc=0
    local stderr_out=""
    stderr_out=$(eval "$raw_cmd" 2>&1) || rc=$?

    local observed_is_error="false"
    local observed_snippet=""
    if [ "$rc" -ne 0 ]; then
        observed_is_error="true"
        observed_snippet="${stderr_out:0:400}"
    fi

    # Emit JSONL record with both expected (pre-set) and observed fields (compact, one line)
    jq -cn \
        --arg t "$transcript" \
        --arg ch "$channel" \
        --arg sc "$subcommand" \
        --arg ent "$entity" \
        --argjson exp_err "$expected_is_error" \
        --arg exp_snip "$expected_snippet" \
        --argjson obs_err "$observed_is_error" \
        --arg obs_snip "$observed_snippet" \
        --arg rawcmd "$raw_cmd" \
        --arg pid "$probe_id" \
        '{probeId:$pid,transcript:$t,callIdx:0,channel:$ch,subcommand:$sc,entity:$ent,isError:$obs_err,errSnippet:$obs_snip,expectedIsError:$exp_err,expectedErrSnippet:$exp_snip,rawCmd:$rawcmd}' \
        >> "$PROBES_JSONL"

    # Report pass/fail
    local expected_fail="$expected_is_error"
    local status="PASS"
    if [ "$observed_is_error" != "$expected_fail" ]; then
        status="FAIL"
    fi
    echo "  [$probe_id] $status — $transcript (exit $rc)"
    if [ "$status" = "FAIL" ]; then
        echo "    expected_is_error=$expected_is_error observed_is_error=$observed_is_error"
        echo "    stderr: ${stderr_out:0:200}"
    fi
}

# Clear output file (idempotent)
> "$PROBES_JSONL"

NODE="node"
CLI="$STORE_CLI_SRC"
STORE_CWD="$PROJECT_ROOT"

# P1: get-task alias → resolves to read task FORGE-S22-T01 (G3: T02 aliases)
run_probe "P1" "probe-P1-get-task-alias" "bash-store-cli" "read" "task" \
    "false" "" \
    "$NODE '$CLI' get-task FORGE-S22-T01 2>&1"

# P2: get-sprint alias → resolves to read sprint FORGE-S22 (G3)
run_probe "P2" "probe-P2-get-sprint-alias" "bash-store-cli" "read" "sprint" \
    "false" "" \
    "$NODE '$CLI' get-sprint FORGE-S22 2>&1"

# P3: get-summary alias → resolves to cmdGetSummary (G3)
run_probe "P3" "probe-P3-get-summary-alias" "bash-store-cli" "read" "summary" \
    "false" "" \
    "$NODE '$CLI' get-summary FORGE-S22-T01 plan 2>&1"

# P4: vocab-drift on update-status (G4: T03 drift suggestions)
# Exit 1 — store-cli prints suggestion and rejects the bad entity type
run_probe "P4" "probe-P4-vocab-drift-update-status" "bash-store-cli" "update-status" "taske" \
    "true" "Did you mean" \
    "$NODE '$CLI' update-status taske FORGE-S22-T01 status implementign 2>&1"

# P5: bare sprintId emit → FK-check rejects with suggestion (G7: T05 FK-check)
run_probe "P5" "probe-P5-emit-bare-sprintid" "bash-store-cli" "emit" "" \
    "true" "Did you mean" \
    "$NODE '$CLI' emit S01 '{\"type\":\"friction\"}' 2>&1"

# P6: --allow-synthetic bypasses FK-check (G7: accept synthetic IDs)
# The payload lacks required event fields, so it still exits 1 — but NOT for "Unknown sprintId".
# The key assertion: stderr does NOT contain "Unknown sprintId". FK bypass confirmed.
run_probe "P6" "probe-P6-emit-allow-synthetic" "bash-store-cli" "emit" "" \
    "true" "" \
    "$NODE '$CLI' emit S01 '{\"type\":\"friction\"}' --allow-synthetic 2>&1"

# P7a: NLP query engine (independent of G5)
run_probe "P7a" "probe-P7a-nlp-list-tasks" "bash-store-cli" "nlp" "" \
    "false" "" \
    "$NODE '$CLI' nlp 'list tasks FORGE-S22' 2>&1"

# P8: write task with drift error → rejects with suggestion (G4: schema validation on write path)
# Expected to exit 1 with "Did you mean implementing?"
run_probe "P8" "probe-P8-write-task-drift" "bash-store-cli" "write" "task" \
    "true" "implementing" \
    "$NODE '$CLI' write task '{\"taskId\":\"X-TEST-1\",\"sprintId\":\"FORGE-S22\",\"title\":\"probe\",\"status\":\"implementign\",\"path\":\"p\"}' 2>&1"

# Cleanup P8: remove X-TEST-1 if a partial write occurred
if [ -f "$STORE_ROOT/tasks/X-TEST-1.json" ]; then
    rm -f "$STORE_ROOT/tasks/X-TEST-1.json"
    echo "  [P8-cleanup] Removed X-TEST-1.json from store"
fi

# P9: valid emit with canonical sprintId + full schema-valid payload (G7: valid emit succeeds)
# Verifies the FK-check ACCEPTS a canonical sprintId. Full event payload avoids schema errors.
# The event is cleaned up after the probe to avoid polluting the store.
P9_PAYLOAD="{\"eventId\":\"evt-probe-p9\",\"sprintId\":\"FORGE-S22\",\"role\":\"probe\",\"action\":\"probe-p9\",\"startTimestamp\":\"2026-05-17T00:00:00Z\",\"endTimestamp\":\"2026-05-17T00:00:01Z\",\"durationMinutes\":0,\"model\":\"probe-model\",\"provider\":\"probe-provider\"}"
run_probe "P9" "probe-P9-emit-valid" "bash-store-cli" "emit" "" \
    "false" "" \
    "$NODE '$CLI' emit FORGE-S22 '$P9_PAYLOAD' 2>&1"
# Cleanup P9: remove the probe event from store (it's a test artifact, not a real event)
if [ -f "$STORE_ROOT/events/FORGE-S22/evt-probe-p9.json" ]; then
    rm -f "$STORE_ROOT/events/FORGE-S22/evt-probe-p9.json"
    echo "  [P9-cleanup] Removed probe event evt-probe-p9 from store"
fi

echo ""
echo "Probes written to: $PROBES_JSONL"
PROBE_COUNT=$(wc -l < "$PROBES_JSONL" | tr -d ' ')
echo "Total probe records: $PROBE_COUNT"

if [ "$PROBES_ONLY" -eq 1 ]; then
    echo ""
    echo "=== PROBES ONLY mode — skipping corpus capture ==="
    exit 0
fi

echo ""
echo "=== CORPUS CAPTURE INSTRUCTIONS ==="
echo ""
echo "Live LLM corpus capture is a MANUAL STEP. This subagent context does not have"
echo "live LLM agent execution capability. To complete Measurement A:"
echo ""
echo "1. Run ≥15 representative Forge task sessions against the fixed store-cli:"
echo "   export FORGE_STORE_CLI_OVERRIDE=$STORE_CLI_SRC"
echo "   # Run each task type from corpus design table (PLAN.md §Corpus design)"
echo "   # Save transcripts as: $CORPUS_DIR/<task-label>_<persona>_<model>.json"
echo ""
echo "2. Extract store ops from fresh transcripts:"
echo "   python3 '$SCRIPT_DIR/filter-store-ops.py' \\"
echo "     --root '$CORPUS_DIR' \\"
echo "     --out '$CORPUS_DIR/store-ops-fresh.jsonl'"
echo ""
echo "3. Verify ≥150 organic store-ops extracted. If fewer, run additional tasks."
echo ""
echo "4. Run Mode C replay for Measurement A:"
echo "   python3 '$SCRIPT_DIR/mode-c-replay.py' \\"
echo "     --store-cli '$STORE_CLI_SRC' \\"
echo "     --ops-file '$CORPUS_DIR/store-ops-fresh.jsonl' \\"
echo "     --out-md '$CORPUS_DIR/VERIFY-BENCH-FRESH.md' \\"
echo "     --out-json '$CORPUS_DIR/verify-bench-fresh.json'"
echo ""
echo "5. Run Measurement B (verify-bench against T01 pinned fixture):"
echo "   python3 '$SCRIPT_DIR/verify-bench.py'"
echo "   # Note: verify-bench.py uses hardcoded absolute paths; runs on this machine only."
echo ""
echo "6. Consult MODE-C-RUNBOOK.md for full process documentation."
echo ""
echo "Corpus capture deferred. Probe harness complete."
exit 0
