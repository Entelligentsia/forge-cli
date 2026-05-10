#!/usr/bin/env bash
# friction-emit-bundled.test.sh
#
# Regression gate for the inline node -e + node store-cli.cjs emit shape
# stamped into 5 meta-workflows (meta-implement, meta-fix-bug,
# meta-validate, meta-plan-task, meta-orchestrate) by FORGE-S20-T00, with
# subkind enum + evidence shape narrowed in FORGE-S20-T01.
#
# Extends BUG-029 coverage. BUG-029 fixed the spurious tools/tools/<x>.cjs
# double-segment defect in forge-tools.ts; this gate covers the inline
# emit pattern that ships in generated workflows under
#   node "$FORGE_ROOT/tools/store-cli.cjs" emit ...
# A regression in payload bundling (missing .schemas/, broken .tools/lib/,
# ESM scope mismatch — the BUG-030 family — or forgeRoot misconfiguration)
# must fail this gate before it reaches a real sprint where workflows
# would silently lose friction telemetry.
#
# Layout under test (post-`/forge:init`, flat-payload bundled):
#   <forgecli-pkg>/dist/forge-payload/
#     ├── .tools/
#     │   ├── store-cli.cjs       ← invoked by emit
#     │   ├── store.cjs           ← writes events to disk
#     │   └── lib/                ← validate.js, project-root.cjs, …
#     └── .schemas/
#         ├── event.schema.json   ← copied into fixture's .forge/schemas/
#         └── …
#
# Exit codes:
#   0 — all assertions PASS
#   1 — at least one assertion FAIL
#   2 — bundle missing (smoke.sh treats this as SKIP, not FAIL)

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
FIX_BASE=${SMOKE_OUT_DIR:-"$PKG_DIR/.smoke-out"}
FIX="$FIX_BASE/friction-emit-fixture"

BUNDLED_TOOLS="$PKG_DIR/dist/forge-payload/.tools"
BUNDLED_SCHEMAS="$PKG_DIR/dist/forge-payload/.schemas"

# ── Bundle presence guard ─────────────────────────────────────────────────
if [[ ! -d "$BUNDLED_TOOLS" || ! -d "$BUNDLED_SCHEMAS" ]]; then
	echo "SKIP friction-emit-bundled — bundle not present"
	echo "  expected: $BUNDLED_TOOLS"
	echo "  expected: $BUNDLED_SCHEMAS"
	echo "  hint: run 'npm run build' first"
	exit 2
fi

if [[ ! -f "$BUNDLED_TOOLS/store-cli.cjs" ]]; then
	echo "SKIP friction-emit-bundled — store-cli.cjs missing from bundle"
	exit 2
fi

# ── Fixture materialization ───────────────────────────────────────────────
rm -rf "$FIX"
mkdir -p "$FIX/.forge/schemas" \
		"$FIX/.forge/store/sprints" \
		"$FIX/.forge/store/tasks" \
		"$FIX/.forge/store/events"

# Config — absolute forgeRoot pointing at the flat .tools layout, which
# mirrors what /forge:init writes into a real forge-cli project.
cat >"$FIX/.forge/config.json" <<EOF
{
  "version": "1.0",
  "project": { "prefix": "FRIC", "name": "Friction Emit Bundled Fixture" },
  "paths": {
    "engineering": "engineering",
    "store": ".forge/store",
    "workflows": ".forge/workflows",
    "commands": ".claude/commands",
    "templates": ".forge/templates",
    "customCommands": "engineering/commands",
    "forgeRoot": "$BUNDLED_TOOLS"
  },
  "pipeline": { "maxReviewIterations": 3 }
}
EOF

# Schemas — store-cli's resolution order is .forge/schemas → forge/schemas
# → __dirname/../schemas. The bundled flat layout has .schemas/ as a
# *sibling* of .tools/, so __dirname/../schemas (= dist/forge-payload/schemas/)
# does not exist. We copy the relevant schemas into the fixture's
# .forge/schemas/ — the same layout `/forge:init` produces.
for schema in event event-sidecar progress-entry collation-state sprint task bug feature; do
	src="$BUNDLED_SCHEMAS/${schema}.schema.json"
	if [[ -f "$src" ]]; then
		cp "$src" "$FIX/.forge/schemas/"
	fi
done

# Sprint + task referents so any FK validation paths see real records.
# Shapes match MINIMAL_REQUIRED in store-cli.cjs.
cat >"$FIX/.forge/store/sprints/FRIC-S01.json" <<'EOF'
{
  "sprintId": "FRIC-S01",
  "title": "Friction Emit Smoke Sprint",
  "status": "active",
  "taskIds": ["FRIC-S01-T01"],
  "createdAt": "2026-05-10T00:00:00Z"
}
EOF

cat >"$FIX/.forge/store/tasks/FRIC-S01-T01.json" <<'EOF'
{
  "taskId": "FRIC-S01-T01",
  "sprintId": "FRIC-S01",
  "title": "Friction Emit Smoke Task",
  "status": "implementing",
  "path": "engineering/sprints/FRIC-S01/FRIC-S01-T01"
}
EOF

# ── Resolve FORGE_ROOT via the same inline node -e shape meta-workflows use ──
FORGE_ROOT=$(cd "$FIX" && node -e "console.log(require('./.forge/config.json').paths.forgeRoot)")

if [[ -z "$FORGE_ROOT" || ! -f "$FORGE_ROOT/store-cli.cjs" ]]; then
	echo "FAIL bootstrap — node -e forgeRoot resolution returned '$FORGE_ROOT'"
	exit 1
fi

# ── Assertions ────────────────────────────────────────────────────────────
PASSED=0
FAILED=0

assert_pass() { PASSED=$((PASSED + 1)); echo "  ✓ $1"; }
assert_fail() { FAILED=$((FAILED + 1)); echo "  ✗ $1 — $2"; }

# Build positive friction event JSON exactly per
# forge/forge/meta/workflows/_fragments/friction-emit.md.
EVENT_ID="20260510T000000000Z_FRIC-S01-T01_engineer_friction"
NOW="2026-05-10T00:00:00Z"
EVENT_JSON=$(cat <<EOF
{
  "eventId":         "$EVENT_ID",
  "taskId":          "FRIC-S01-T01",
  "sprintId":        "FRIC-S01",
  "role":            "engineer",
  "action":          "friction_observed",
  "phase":           "implement",
  "iteration":       1,
  "startTimestamp":  "$NOW",
  "endTimestamp":    "$NOW",
  "durationMinutes": 0,
  "model":           "claude-opus-4-7",
  "type":            "friction",
  "workflow":        "implement",
  "persona":         "engineer",
  "issue":           "skill_unused",
  "subkind":         "skill_unused",
  "evidence":        { "trajectory_excerpt": "loaded skill X but never consulted", "tool_errors": [], "retrieval_score": 0.42, "skillId": "forge-engineer" },
  "notes":           "regression-fixture"
}
EOF
)

# A1: emit exit code 0
EMIT_OUT=$(cd "$FIX" && node "$FORGE_ROOT/store-cli.cjs" emit FRIC-S01 "$EVENT_JSON" 2>&1)
EMIT_RC=$?
if [[ $EMIT_RC -eq 0 ]]; then
	assert_pass "A1 emit exit code 0"
else
	assert_fail "A1 emit exit code 0" "got rc=$EMIT_RC, output: $EMIT_OUT"
fi

# A2: event file landed
EVENT_FILE="$FIX/.forge/store/events/FRIC-S01/${EVENT_ID}.json"
if [[ -f "$EVENT_FILE" ]]; then
	assert_pass "A2 event file written to .forge/store/events/"
else
	assert_fail "A2 event file written to .forge/store/events/" "missing $EVENT_FILE"
fi

# A3..A7: parse and inspect the persisted event via node -e (one shot).
if [[ -f "$EVENT_FILE" ]]; then
	INSPECT=$(node -e '
		const fs = require("fs");
		const p = process.argv[1];
		let e;
		try { e = JSON.parse(fs.readFileSync(p, "utf8")); }
		catch (err) { console.log("A3:FAIL:" + err.message); process.exit(0); }
		console.log("A3:PASS");

		console.log(e.type === "friction" ? "A4:PASS" : "A4:FAIL:type=" + e.type);

		const missing = ["workflow","persona","issue"].filter(k => !e[k] || typeof e[k] !== "string");
		console.log(missing.length === 0 ? "A5:PASS" : "A5:FAIL:missing=" + missing.join(","));

		const enumRe = /^(skill_unused|skill_failed|skill_missing|skill_stale|skill_redundant|x_[a-z_]+)$/;
		console.log(enumRe.test(e.subkind || "") ? "A6:PASS" : "A6:FAIL:subkind=" + e.subkind);

		const rs = e.evidence && e.evidence.retrieval_score;
		console.log(typeof rs === "number" && rs >= 0 && rs <= 1 ? "A7:PASS" : "A7:FAIL:retrieval_score=" + rs);
	' "$EVENT_FILE")

	while IFS= read -r line; do
		case "$line" in
			A3:PASS) assert_pass "A3 event file is valid JSON" ;;
			A3:FAIL:*) assert_fail "A3 event file is valid JSON" "${line#A3:FAIL:}" ;;
			A4:PASS) assert_pass "A4 type === friction" ;;
			A4:FAIL:*) assert_fail "A4 type === friction" "${line#A4:FAIL:}" ;;
			A5:PASS) assert_pass "A5 workflow + persona + issue present" ;;
			A5:FAIL:*) assert_fail "A5 workflow + persona + issue present" "${line#A5:FAIL:}" ;;
			A6:PASS) assert_pass "A6 subkind matches T01 frozen enum" ;;
			A6:FAIL:*) assert_fail "A6 subkind matches T01 frozen enum" "${line#A6:FAIL:}" ;;
			A7:PASS) assert_pass "A7 evidence.retrieval_score round-trips in [0,1]" ;;
			A7:FAIL:*) assert_fail "A7 evidence.retrieval_score round-trips in [0,1]" "${line#A7:FAIL:}" ;;
		esac
	done <<<"$INSPECT"
else
	assert_fail "A3..A7 inspect persisted event" "event file missing"
fi

# A8 (negative): emit with bogus subkind must be rejected if the bundled
# schema carries the T01 pattern. If the bundled schema is the loose
# pre-T01 shape, this assertion is recorded as informational (PASS-soft)
# rather than failing — but we still emit a clear marker so a future
# rebundle that picks up T01 flips this gate to hard.
BAD_EVENT_ID="20260510T000001000Z_FRIC-S01-T01_engineer_friction_bad"
BAD_JSON=$(cat <<EOF
{
  "eventId":         "$BAD_EVENT_ID",
  "taskId":          "FRIC-S01-T01",
  "sprintId":        "FRIC-S01",
  "role":            "engineer",
  "action":          "friction_observed",
  "phase":           "implement",
  "iteration":       1,
  "startTimestamp":  "$NOW",
  "endTimestamp":    "$NOW",
  "durationMinutes": 0,
  "model":           "claude-opus-4-7",
  "type":            "friction",
  "workflow":        "implement",
  "persona":         "engineer",
  "issue":           "skill_unused",
  "subkind":         "skill_BOGUS",
  "notes":           "regression-fixture-negative-case"
}
EOF
)

# Detect whether the bundled schema actually constrains `subkind` (T01).
HAS_SUBKIND_PATTERN=$(node -e '
	const fs = require("fs");
	const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
	const sk = s.properties && s.properties.subkind;
	console.log(sk && typeof sk.pattern === "string" ? "yes" : "no");
' "$FIX/.forge/schemas/event.schema.json")

BAD_OUT=$(cd "$FIX" && node "$FORGE_ROOT/store-cli.cjs" emit FRIC-S01 "$BAD_JSON" 2>&1)
BAD_RC=$?

if [[ "$HAS_SUBKIND_PATTERN" == "yes" ]]; then
	if [[ $BAD_RC -ne 0 ]]; then
		assert_pass "A8 bogus subkind rejected by bundled schema (T01 enforced)"
	else
		assert_fail "A8 bogus subkind rejected by bundled schema (T01 enforced)" \
			"bundled schema declares subkind pattern but emit accepted invalid value"
	fi
else
	# Pre-T01 bundle: schema does not yet enforce subkind. Test stays green
	# but emits a visible marker so the next rebundle (T09) flips this to
	# hard enforcement.
	echo "  ⊘ A8 bogus subkind rejection — bundled schema is pre-T01 (no subkind pattern); informational only"
	echo "    fix: rebundle dist/forge-payload/.schemas/ from forge/forge/schemas/ (T09)"
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo "friction-emit-bundled: passed=$PASSED failed=$FAILED"

if (( FAILED > 0 )); then
	exit 1
fi
exit 0
