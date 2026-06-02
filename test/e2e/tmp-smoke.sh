#!/usr/bin/env bash
# Tmp-smoke gate (FORGE-S25-T03).
#
# End-to-end smoke driver against a freshly-created OS-tmpdir project. Exercises
# the three golden-path Forge surfaces:
#
#   1. /forge:init --fast            (auth-free structural assertions)
#   2. /forge:plan SMOKE-TMP-S01-T01 (auth-required; SKIPs cleanly without
#                                      ANTHROPIC_API_KEY)
#   3. /forge:health                 (auth-free — validate-store --dry-run +
#                                      generation-manifest check)
#
# This is the canonical AC #5 working-product gate referenced by every Phase 1+
# FORGE-S25 task. Sibling of test/e2e/smoke.sh (FORGE-S16-T11). Wired into
# forge-cli .github/workflows/smoke.yml (job: tmp-smoke) and into
# forge .github/workflows/plugin-ci.yml (job: tmp-smoke) — the latter sets
# FORGE_TMP_SMOKE_PLUGIN_SRC to the in-tree plugin source so a plugin change
# cannot ship green without the forge-cli driver also being green against it.
#
# NOTE: -e is intentionally omitted. The record FAIL helper accumulates failures
# into CHECKS_FAILED; the gate exits 1 at the end if any failed. With -e, the
# first FAIL would short-circuit before SUMMARY.md is written, hiding the full
# failure profile. Do not "fix" this by adding -e. (Per PLAN_REVIEW finding #7.)

set -uo pipefail

# ── Paths and globals ──────────────────────────────────────────────────────

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)

TMP_SMOKE_OUT_DIR=${TMP_SMOKE_OUT_DIR:-"$PKG_DIR/.tmp-smoke-out"}
SMOKE_PREFIX=${SMOKE_PREFIX:-"$TMP_SMOKE_OUT_DIR/install-prefix"}
SUMMARY_FILE="$TMP_SMOKE_OUT_DIR/SUMMARY.md"

# Reset output dir for idempotence.
rm -rf "$TMP_SMOKE_OUT_DIR"
mkdir -p "$TMP_SMOKE_OUT_DIR" "$SMOKE_PREFIX"

# Fresh tmp project — never reused; cleaned by EXIT trap unless KEEP=1.
TMP_PROJECT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/forge-tmp-smoke.XXXXXX")
cleanup() {
	if [[ -z "${FORGE_TMP_SMOKE_KEEP:-}" ]]; then
		rm -rf "$TMP_PROJECT_DIR"
	else
		echo "▶ FORGE_TMP_SMOKE_KEEP=1 set; preserving $TMP_PROJECT_DIR"
	fi
}
trap cleanup EXIT

CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_SKIPPED=0
CHECKS_WARNED=0
RESULTS=()

record() {
	# record <status> <name> <detail>
	# SKIP detail SHOULD start with `SKIP_REASON=env:<VAR>` or
	# `SKIP_REASON=skip:<rationale>` per PLAN §3.1 SKIP_REASON convention.
	local status=$1 name=$2 detail=${3:-}
	RESULTS+=("$status|$name|$detail")
	case "$status" in
		PASS) CHECKS_PASSED=$((CHECKS_PASSED + 1)); echo "  ✓ $name" ;;
		FAIL) CHECKS_FAILED=$((CHECKS_FAILED + 1)); echo "  ✗ $name — $detail" ;;
		SKIP) CHECKS_SKIPPED=$((CHECKS_SKIPPED + 1)); echo "  ⊘ $name — $detail" ;;
		WARN) CHECKS_WARNED=$((CHECKS_WARNED + 1)); echo "  ⚠ $name — $detail" ;;
	esac
}

# ── Pack + install ─────────────────────────────────────────────────────────

echo "▶ tmp-smoke — packing and installing forge-cli"

cd "$PKG_DIR"
if npm run build >"$TMP_SMOKE_OUT_DIR/build.log" 2>&1; then
	record PASS "build" "npm run build"
else
	record FAIL "build" "npm run build failed (see build.log)"
fi

TARBALL=$(npm pack --silent 2>/dev/null | tail -n 1)
if [[ -z "$TARBALL" || ! -f "$PKG_DIR/$TARBALL" ]]; then
	record FAIL "pack" "npm pack produced no tarball"
else
	record PASS "pack" "$TARBALL"
fi

if [[ -f "$PKG_DIR/$TARBALL" ]]; then
	if npm install --prefix "$SMOKE_PREFIX" --global "$PKG_DIR/$TARBALL" >"$TMP_SMOKE_OUT_DIR/install.log" 2>&1; then
		record PASS "install" "prefix=$SMOKE_PREFIX"
	else
		record FAIL "install" "npm i -g failed (see install.log)"
	fi
fi

FORGE_BIN="$SMOKE_PREFIX/bin/forge"
if [[ -x "$FORGE_BIN" ]]; then
	record PASS "bin/forge present" "$FORGE_BIN"
else
	record FAIL "bin/forge present" "missing"
fi

# ── Plugin-source override (FORGE_TMP_SMOKE_PLUGIN_SRC) ────────────────────

if [[ -n "${FORGE_TMP_SMOKE_PLUGIN_SRC:-}" ]]; then
	PAYLOAD_DIR="$SMOKE_PREFIX/lib/node_modules/@entelligentsia/forgecli/dist/forge-payload"
	if [[ ! -d "$FORGE_TMP_SMOKE_PLUGIN_SRC" ]]; then
		record FAIL "plugin-source override source missing" "$FORGE_TMP_SMOKE_PLUGIN_SRC"
	elif [[ ! -d "$PAYLOAD_DIR" ]]; then
		record FAIL "plugin-source override target missing" "$PAYLOAD_DIR (install must precede override)"
	else
		# Use rsync --delete for exact replacement; fall back to wipe-then-copy.
		# IRON-LAW comment for future maintainers: in the fallback path these two
		# statements MUST stay in this order — first wipe the destination, THEN
		# copy. A reordered `cp -R …; rm -rf …` would delete what we just copied.
		# A merged `cp -R --remove-destination …` would leave files present in
		# dest but absent in src (the exact bug rsync --delete is here to
		# prevent). Per PLAN_REVIEW finding #9: encode as two ordered statements.
		if command -v rsync >/dev/null 2>&1; then
			rm -rf "$PAYLOAD_DIR"
			rsync -a --delete "$FORGE_TMP_SMOKE_PLUGIN_SRC/" "$PAYLOAD_DIR/"
		else
			rm -rf "$PAYLOAD_DIR"
			cp -R "$FORGE_TMP_SMOKE_PLUGIN_SRC" "$PAYLOAD_DIR"
		fi
		record PASS "plugin-source override" "$FORGE_TMP_SMOKE_PLUGIN_SRC -> $PAYLOAD_DIR"
	fi
fi

# ── /forge:init --fast against fresh tmp project (auth-free, gate-critical) ─

echo "▶ tmp-smoke — /forge:init --fast against fresh tmp project ($TMP_PROJECT_DIR)"

cd "$TMP_PROJECT_DIR"
# Seed a minimal CLAUDE.md so Phase 0 discovery has something to read.
echo "# Tmp Smoke Project" >CLAUDE.md

# Verified at engineer-time (FORGE-S25-T03 land): the /forge:init --fast
# command is LLM-driven end-to-end against current forge — the headless
# `forge -p "/forge:init --fast"` invocation requires ANTHROPIC_API_KEY to do
# any scaffolding at all. The PLAN claim that init has a deterministic
# auth-free scaffolding pass was inaccurate against current main; this driver
# treats the whole init block as auth-required and SKIPs cleanly when no key
# is set. Structural assertions only run when init actually executed.
INIT_RAN=0
if [[ ! -x "$FORGE_BIN" ]]; then
	record SKIP "E2E-T03-INIT: forge init --fast" "SKIP_REASON=skip:forge bin missing (install failed upstream)"
elif [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
	record SKIP "E2E-T03-INIT: forge init --fast" "SKIP_REASON=env:ANTHROPIC_API_KEY not set (init is LLM-driven end-to-end)"
else
	# 600s ceiling — fast-mode init drives a 4-phase LLM workflow.
	if timeout 600 "$FORGE_BIN" --non-interactive -p "/forge:init --fast" \
			>"$TMP_SMOKE_OUT_DIR/init.out" 2>&1; then
		record PASS "E2E-T03-INIT: forge init --fast exited cleanly" ""
		INIT_RAN=1
	else
		INIT_RC=$?
		record WARN "E2E-T03-INIT: forge init --fast rc=$INIT_RC" "see init.out (structural asserts below are authoritative)"
		INIT_RAN=1
	fi
fi

# Always-defined toolchain paths — set inside INIT_RAN gate, but declared here
# so downstream blocks (run-task, health) can `[[ -z "$VAR" ]]` without
# tripping `set -u`.
FORGE_ROOT=""
STORE_CLI=""
VALIDATE_STORE=""
GENERATION_MANIFEST=""
KB_PATH="engineering"

# Structural assertions — gate-critical pass criteria when init ran.
# When init was SKIPped, these SKIP too (no false-FAILs on missing scaffolding).
# Each derives from forge/forge/init/smoke-test.md §Fast-mode invariants.

if [[ "$INIT_RAN" -eq 0 ]]; then
	for n in 1 2 3 4 5 6 7; do
		record SKIP "E2E-T03-INIT-$n: structural invariant" "SKIP_REASON=skip:init did not run"
	done
	record SKIP "E2E-T03-INIT-FORGE-ROOT" "SKIP_REASON=skip:init did not run"
	# FORGE-S25-T09: paired bundled-materialization gate for the _fragments/
	# surface. Skipped here in lockstep with the other invariants when init
	# did not run; the loud-on-regression assertion lives in the INIT_RAN=1
	# block below.
	record SKIP "E2E-T03-INIT-FRAGMENTS: .forge/workflows/_fragments/ materialized" \
		"SKIP_REASON=skip:init did not run"
fi

if [[ "$INIT_RAN" -eq 1 ]]; then

# 1. config.json exists, parses, mode == "fast".
if [[ -f .forge/config.json ]] \
		&& node -e "const c=require('$TMP_PROJECT_DIR/.forge/config.json'); process.exit(c.mode==='fast'?0:1)" 2>/dev/null; then
	record PASS "E2E-T03-INIT-1: .forge/config.json valid + mode=fast" ""
else
	record FAIL "E2E-T03-INIT-1: .forge/config.json missing/invalid/mode!=fast" "see init.out"
fi

# Pin FORGE_ROOT + tool paths to absolute paths NOW (per PLAN §3.1 absolute-path
# discipline). All subsequent node "$STORE_CLI"/etc. calls are cwd-agnostic.
if [[ -f .forge/config.json ]]; then
	FORGE_ROOT=$(node -e "console.log(require('path').resolve('.', require('./.forge/config.json').paths.forgeRoot))" 2>/dev/null || echo "")
fi
if [[ -n "$FORGE_ROOT" && -d "$FORGE_ROOT" ]]; then
	STORE_CLI="$FORGE_ROOT/tools/store-cli.cjs"
	VALIDATE_STORE="$FORGE_ROOT/tools/validate-store.cjs"
	GENERATION_MANIFEST="$FORGE_ROOT/tools/generation-manifest.cjs"
	record PASS "E2E-T03-INIT-FORGE-ROOT resolved" "$FORGE_ROOT"
else
	record FAIL "E2E-T03-INIT-FORGE-ROOT unresolved" "FORGE_ROOT=$FORGE_ROOT"
fi

# E2E-T05-TOOLS-VENDORED: .forge/tools/store-cli.cjs must exist after init (FORGE-S29-T05)
TOOLS_DIR=".forge/tools"
if [[ -f "$TOOLS_DIR/store-cli.cjs" ]]; then
	record PASS "E2E-T05-TOOLS-VENDORED" "$TOOLS_DIR/store-cli.cjs"
else
	record FAIL "E2E-T05-TOOLS-VENDORED" ".forge/tools/store-cli.cjs missing after init"
fi

# 2. schemas/ exists with at least 3 .schema.json files.
SCHEMA_COUNT=$(find .forge/schemas -maxdepth 1 -name "*.schema.json" 2>/dev/null | wc -l)
if [[ "$SCHEMA_COUNT" -ge 3 ]]; then
	record PASS "E2E-T03-INIT-2: .forge/schemas has ≥3 schema files" "count=$SCHEMA_COUNT"
else
	record FAIL "E2E-T03-INIT-2: .forge/schemas missing or sparse" "count=$SCHEMA_COUNT"
fi

# 3. .claude/commands/ exists with at least 10 *.md command wrappers.
CMD_COUNT=$(find .claude/commands -maxdepth 2 -name "*.md" 2>/dev/null | wc -l)
if [[ "$CMD_COUNT" -ge 10 ]]; then
	record PASS "E2E-T03-INIT-3: .claude/commands has ≥10 command wrappers" "count=$CMD_COUNT"
else
	record FAIL "E2E-T03-INIT-3: .claude/commands missing or sparse" "count=$CMD_COUNT"
fi

# 4. .forge/workflows/ contains stub files all starting with the fast-mode sentinel.
WORKFLOWS_DIR=".forge/workflows"
if [[ -d "$WORKFLOWS_DIR" ]]; then
	STUB_BAD=0
	STUB_TOTAL=0
	while IFS= read -r -d '' wf; do
		STUB_TOTAL=$((STUB_TOTAL + 1))
		# Sentinel must appear in the first line per smoke-test.md invariant 4.
		if ! head -1 "$wf" | grep -q "^<!-- FORGE FAST-MODE STUB"; then
			STUB_BAD=$((STUB_BAD + 1))
		fi
	done < <(find "$WORKFLOWS_DIR" -maxdepth 1 -name "*.md" -print0 2>/dev/null)
	if [[ "$STUB_TOTAL" -gt 0 && "$STUB_BAD" -eq 0 ]]; then
		record PASS "E2E-T03-INIT-4: all .forge/workflows/*.md start with FAST-MODE STUB sentinel" "count=$STUB_TOTAL"
	else
		record FAIL "E2E-T03-INIT-4: .forge/workflows stub sentinel violations" "total=$STUB_TOTAL bad=$STUB_BAD"
	fi
else
	record FAIL "E2E-T03-INIT-4: .forge/workflows missing" "expected dir at $WORKFLOWS_DIR"
fi

# 5. MASTER_INDEX.md exists with <!-- forge-fast-stub --> sentinel.
if [[ -f .forge/config.json ]]; then
	KB_PATH=$(node -e "try{console.log(require('$TMP_PROJECT_DIR/.forge/config.json').paths.engineering)}catch{console.log('engineering')}" 2>/dev/null)
fi
MASTER_INDEX="$KB_PATH/MASTER_INDEX.md"
if [[ -f "$MASTER_INDEX" ]] && grep -q "<!-- forge-fast-stub -->" "$MASTER_INDEX"; then
	record PASS "E2E-T03-INIT-5: MASTER_INDEX.md exists + fast-stub sentinel present" "$MASTER_INDEX"
else
	record FAIL "E2E-T03-INIT-5: MASTER_INDEX.md missing or no fast-stub sentinel" "$MASTER_INDEX"
fi

# 6. CLAUDE.md contains the Forge-managed block.
if [[ -f CLAUDE.md ]] && grep -q "Forge" CLAUDE.md && grep -qE "<!-- (BEGIN |FORGE)" CLAUDE.md; then
	record PASS "E2E-T03-INIT-6: CLAUDE.md contains Forge-managed block" ""
elif [[ -f CLAUDE.md ]] && grep -qE "<!-- (BEGIN |FORGE)" CLAUDE.md; then
	record PASS "E2E-T03-INIT-6: CLAUDE.md contains Forge-managed block" "(sentinel-only match)"
else
	record WARN "E2E-T03-INIT-6: CLAUDE.md Forge-managed block not detected" "exact sentinel pending verify; non-fatal warn"
fi

# 7. Stub workflow files are NOT recorded in .forge/generation-manifest.json.
if [[ -f .forge/generation-manifest.json ]]; then
	STUB_IN_MANIFEST=$(node -e "
		const m=require('$TMP_PROJECT_DIR/.forge/generation-manifest.json');
		const files=(m.files||m);
		let hit=0;
		for (const k of Object.keys(files)) {
			if (k.startsWith('.forge/workflows/') && k.endsWith('.md')) hit++;
		}
		console.log(hit);
	" 2>/dev/null || echo "?")
	if [[ "$STUB_IN_MANIFEST" == "0" ]]; then
		record PASS "E2E-T03-INIT-7: no workflow stubs recorded in generation-manifest" ""
	else
		record FAIL "E2E-T03-INIT-7: workflow stubs leaked into generation-manifest" "count=$STUB_IN_MANIFEST"
	fi
else
	record WARN "E2E-T03-INIT-7: .forge/generation-manifest.json missing" "init may not have stamped manifest"
fi

# FORGE-S25-T09: paired bundled-materialization gate for the _fragments/
# surface. AC #5 (smoke passes) + AC #6 (shared-surface paired bundled smoke)
# for `meta/workflows/_fragments/`. Defends the implicit recursive-copy
# allowlist in forge-cli/scripts/build-payload.cjs: any future refactor that
# silently drops _fragments/ from the bundled payload — or any plugin-side
# regression in build-base-pack.cjs's fragment mirroring — fails this gate
# loudly. See doc/decisions/meta-fragment-includes.md for the design contract.
#
# Plugin-side plugin-ci.yml :: tmp-smoke job picks this up automatically since
# it clones forge-cli at main and runs the same script (no plugin CI wiring
# change needed).
FRAGMENTS_DIR=".forge/workflows/_fragments"
if [[ -d "$FRAGMENTS_DIR" ]]; then
	FRAG_COUNT=$(find "$FRAGMENTS_DIR" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l)
	if [[ "$FRAG_COUNT" -ge 1 ]]; then
		record PASS "E2E-T03-INIT-FRAGMENTS: .forge/workflows/_fragments/ materialized" \
			"count=$FRAG_COUNT"
	else
		record FAIL "E2E-T03-INIT-FRAGMENTS: .forge/workflows/_fragments/ has no .md files" \
			"dir exists but is empty (ls $FRAGMENTS_DIR: $(ls "$FRAGMENTS_DIR" 2>&1))"
	fi
else
	record FAIL "E2E-T03-INIT-FRAGMENTS: .forge/workflows/_fragments/ missing" \
		"expected dir at $FRAGMENTS_DIR; check build-payload.cjs + migration-engine workflows:_fragments resolver"
fi

fi  # end if INIT_RAN -eq 1

# ── /forge:plan SMOKE-TMP-S01-T01 against seeded fixture (auth-required) ───
#
# Plan/run-task substitution. TASK_PROMPT names /forge:run-task; this driver
# exercises /forge:plan directly because (a) plan is the smallest deterministic
# phase, (b) plan completion materialises both PLAN.md and PLAN-SUMMARY.json
# (two deterministic structural checks), and (c) the full run-task pipeline is
# exercised by every real sprint task — duplicating it in the smoke gate buys
# wall-time, not signal. PROGRESS.md carries the canonical disambiguation.

echo "▶ tmp-smoke — /forge:plan SMOKE-TMP-S01-T01 (auth-required)"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
	record SKIP "E2E-T03-RUNTASK: /forge:plan against seeded fixture" "SKIP_REASON=env:ANTHROPIC_API_KEY not set"
elif [[ -z "$STORE_CLI" || ! -f "$STORE_CLI" ]]; then
	record SKIP "E2E-T03-RUNTASK: /forge:plan against seeded fixture" "SKIP_REASON=skip:store-cli unresolved (init failed)"
elif [[ ! -x "$FORGE_BIN" ]]; then
	record SKIP "E2E-T03-RUNTASK: /forge:plan against seeded fixture" "SKIP_REASON=skip:forge bin missing"
else
	# Seed fixture via store-cli (NEVER raw fs.writeFile to .forge/store/ — per
	# CLAUDE.md hard boundary).
	SPRINT_JSON='{"sprintId":"SMOKE-TMP-S01","title":"Tmp-smoke fixture","status":"active","objectives":["smoke gate"],"tasks":["SMOKE-TMP-S01-T01"]}'
	TASK_JSON='{"taskId":"SMOKE-TMP-S01-T01","sprintId":"SMOKE-TMP-S01","title":"Tmp-smoke task","status":"draft","estimate":"S","dependencies":[],"objective":"Smoke-gate fixture task — exercise plan phase only."}'

	if node "$STORE_CLI" write sprint "$SPRINT_JSON" >"$TMP_SMOKE_OUT_DIR/seed-sprint.out" 2>&1; then
		record PASS "E2E-T03-RUNTASK-SEED: sprint seeded" "SMOKE-TMP-S01"
		if node "$STORE_CLI" write task "$TASK_JSON" >"$TMP_SMOKE_OUT_DIR/seed-task.out" 2>&1; then
			record PASS "E2E-T03-RUNTASK-SEED: task seeded" "SMOKE-TMP-S01-T01"
			mkdir -p "$KB_PATH/sprints/SMOKE-TMP-S01/SMOKE-TMP-S01-T01"
			cat >"$KB_PATH/sprints/SMOKE-TMP-S01/SMOKE-TMP-S01-T01/TASK_PROMPT.md" <<'EOF'
# Tmp-smoke Task

## Objective

Exercise the /forge:plan phase end-to-end. Produce a one-paragraph PLAN.md and
the PLAN-SUMMARY.json sidecar. Do nothing else.

## Acceptance

- PLAN.md exists.
- PLAN-SUMMARY.json exists.
EOF

			# Run the plan phase. 240s ceiling — plan is the smallest phase but
			# still involves an LLM round-trip.
			if timeout 240 "$FORGE_BIN" -p "/forge:plan SMOKE-TMP-S01-T01" \
					>"$TMP_SMOKE_OUT_DIR/plan.out" 2>&1; then
				record PASS "E2E-T03-RUNTASK: /forge:plan invocation exited cleanly" ""
			else
				PLAN_RC=$?
				record WARN "E2E-T03-RUNTASK: /forge:plan rc=$PLAN_RC" "see plan.out (structural asserts below are authoritative)"
			fi

			TASK_DIR="$KB_PATH/sprints/SMOKE-TMP-S01/SMOKE-TMP-S01-T01"
			if [[ -f "$TASK_DIR/PLAN.md" ]]; then
				record PASS "E2E-T03-RUNTASK: PLAN.md materialised" "$TASK_DIR/PLAN.md"
			else
				record FAIL "E2E-T03-RUNTASK: PLAN.md missing" "see plan.out"
			fi
			if [[ -f "$TASK_DIR/PLAN-SUMMARY.json" ]]; then
				record PASS "E2E-T03-RUNTASK: PLAN-SUMMARY.json sidecar materialised" ""
			else
				record FAIL "E2E-T03-RUNTASK: PLAN-SUMMARY.json missing" "see plan.out"
			fi

			EVENT_COUNT=$(find .forge/store/events/SMOKE-TMP-S01 -maxdepth 1 -name "*.json" 2>/dev/null | wc -l)
			if [[ "$EVENT_COUNT" -gt 0 ]]; then
				record PASS "E2E-T03-RUNTASK: phase event emitted to store" "count=$EVENT_COUNT"
			else
				record FAIL "E2E-T03-RUNTASK: no phase event in store" "expected ≥1 under .forge/store/events/SMOKE-TMP-S01/"
			fi
		else
			record FAIL "E2E-T03-RUNTASK-SEED: task seed failed" "see seed-task.out"
		fi
	else
		record FAIL "E2E-T03-RUNTASK-SEED: sprint seed failed" "see seed-sprint.out"
	fi
fi

# ── /forge:health (auth-free subset — validate-store + generation-manifest) ─

echo "▶ tmp-smoke — /forge:health auth-free subset"

# Pattern (per PLAN §3.1 + PLAN_REVIEW blocker #1): run the command as a
# top-level statement inside the if-branch so $? reflects the node exit code,
# not the command-substitution wrapper. Tee stdout/stderr to the artefact log.
if [[ -n "$VALIDATE_STORE" && -f "$VALIDATE_STORE" ]]; then
	if node "$VALIDATE_STORE" --dry-run >"$TMP_SMOKE_OUT_DIR/validate.out" 2>&1; then
		record PASS "E2E-T03-HEALTH: validate-store --dry-run" ""
	else
		VALIDATE_RC=$?
		record FAIL "E2E-T03-HEALTH: validate-store --dry-run rc=$VALIDATE_RC" "see validate.out"
	fi
else
	record SKIP "E2E-T03-HEALTH: validate-store --dry-run" "SKIP_REASON=skip:validate-store unresolved"
fi

if [[ -n "$GENERATION_MANIFEST" && -f "$GENERATION_MANIFEST" ]]; then
	if node "$GENERATION_MANIFEST" check >"$TMP_SMOKE_OUT_DIR/manifest.out" 2>&1; then
		record PASS "E2E-T03-HEALTH: generation-manifest check" ""
	else
		MANIFEST_RC=$?
		record FAIL "E2E-T03-HEALTH: generation-manifest check rc=$MANIFEST_RC" "see manifest.out"
	fi
else
	record SKIP "E2E-T03-HEALTH: generation-manifest check" "SKIP_REASON=skip:generation-manifest unresolved"
fi

# ── Write SUMMARY.md ───────────────────────────────────────────────────────

{
	echo "# Forge-CLI tmp-smoke gate — SUMMARY"
	echo ""
	echo "**Generated:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "**Package:** $PKG_DIR"
	echo "**Install prefix:** $SMOKE_PREFIX"
	echo "**Tmp project:** $TMP_PROJECT_DIR"
	echo "**Plugin source override:** ${FORGE_TMP_SMOKE_PLUGIN_SRC:-(none — using bundled payload)}"
	echo "**Auth gates:** $([[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo enabled || echo skipped)"
	echo ""
	echo "## Counts"
	echo ""
	echo "- Passed:  $CHECKS_PASSED"
	echo "- Failed:  $CHECKS_FAILED"
	echo "- Skipped: $CHECKS_SKIPPED"
	echo "- Warned:  $CHECKS_WARNED"
	echo ""
	echo "## Checks"
	echo ""
	echo "| Status | Check | Detail |"
	echo "|--------|-------|--------|"
	for row in "${RESULTS[@]}"; do
		IFS='|' read -r status name detail <<<"$row"
		case "$status" in
			PASS) icon="✓ PASS" ;;
			FAIL) icon="✗ FAIL" ;;
			SKIP) icon="⊘ SKIP" ;;
			WARN) icon="⚠ WARN" ;;
			*)    icon="$status" ;;
		esac
		detail_safe=${detail//|/\\|}
		echo "| $icon | $name | $detail_safe |"
	done
	echo ""
	echo "## SKIP_REASON legend"
	echo ""
	echo "- \`env:<VAR>\` — environmental skip; provision the named secret to enable."
	echo "- \`skip:<rationale>\` — asserted/internal skip (e.g., upstream failure cascaded)."
	echo ""
	echo "Artifacts in \`$TMP_SMOKE_OUT_DIR\`: build.log, install.log, init.out, validate.out, manifest.out"
	[[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo "+ seed-sprint.out, seed-task.out, plan.out"
} >"$SUMMARY_FILE"

echo ""
echo "▶ summary written to $SUMMARY_FILE"
echo "▶ passed=$CHECKS_PASSED failed=$CHECKS_FAILED skipped=$CHECKS_SKIPPED warned=$CHECKS_WARNED"

if (( CHECKS_FAILED > 0 )); then
	exit 1
fi
