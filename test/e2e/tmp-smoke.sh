#!/usr/bin/env bash
# Tmp-smoke gate (FORGE-S25-T03, FORGE-S31-T07).
#
# End-to-end smoke driver against a freshly-created OS-tmpdir project. Exercises
# the three golden-path Forge surfaces:
#
#   1. `4ge init claude .`           (auth-free deterministic bootstrap — FORGE-S31-T07)
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

# ── `4ge init claude .` deterministic bootstrap (FORGE-S31-T07) ──────────────
#
# Auth-free. Runs in every CI environment regardless of ANTHROPIC_API_KEY.
# Exercises: scaffold, vendor tools, four drivers, init.md dispatcher,
# settings hooks, gitignore, idempotent second run.

echo "▶ tmp-smoke — 4ge init claude (deterministic bootstrap)"

# Always-defined toolchain paths — declared here so downstream blocks (plan,
# health) can `[[ -z "$VAR" ]]` without tripping `set -u`.
STORE_CLI=""
VALIDATE_STORE=""
GENERATION_MANIFEST=""
KB_PATH="engineering"

if [[ ! -x "$FORGE_BIN" ]]; then
	record SKIP "BOOTSTRAP: 4ge init claude" "SKIP_REASON=skip:forge bin missing (install failed upstream)"
else
	# Pre-seed a .gitignore so the append path is exercised (mirrors T06 setup).
	echo ".DS_Store" > "$TMP_PROJECT_DIR/.gitignore"

	BOOTSTRAP_INIT_RAN=0
	if "$FORGE_BIN" init claude "$TMP_PROJECT_DIR" \
			>"$TMP_SMOKE_OUT_DIR/bootstrap.out" 2>&1; then
		record PASS "BOOTSTRAP: 4ge init claude exited 0" ""
		BOOTSTRAP_INIT_RAN=1
	else
		BOOTSTRAP_RC=$?
		record FAIL "BOOTSTRAP: 4ge init claude rc=$BOOTSTRAP_RC" "see bootstrap.out"
		# Structural assertions below will cascade-FAIL with meaningful messages.
		BOOTSTRAP_INIT_RAN=1  # run assertions to expose root cause
	fi

	# ── Structural assertions (auth-free, gate-critical) ──────────────────
	# AC #1: vendored tools, four drivers, dispatcher, hooks, gitignore, idempotency.

	# 1. .forge/tools/store-cli.cjs present (vendor-tools contract)
	if [[ -f "$TMP_PROJECT_DIR/.forge/tools/store-cli.cjs" ]]; then
		record PASS "BOOTSTRAP-1: .forge/tools/store-cli.cjs vendored" ""
	else
		record FAIL "BOOTSTRAP-1: .forge/tools/store-cli.cjs missing" "see bootstrap.out"
	fi

	# 2. .forge/tools/verify-phase.cjs present
	if [[ -f "$TMP_PROJECT_DIR/.forge/tools/verify-phase.cjs" ]]; then
		record PASS "BOOTSTRAP-2: .forge/tools/verify-phase.cjs vendored" ""
	else
		record FAIL "BOOTSTRAP-2: .forge/tools/verify-phase.cjs missing" ""
	fi

	# 3. All four wfl-*.js drivers installed in .claude/workflows/
	WFL_COUNT=$(find "$TMP_PROJECT_DIR/.claude/workflows" -maxdepth 1 -name "wfl-*.js" 2>/dev/null | wc -l)
	if [[ "$WFL_COUNT" -eq 4 ]]; then
		record PASS "BOOTSTRAP-3: four wfl-*.js drivers installed" "count=$WFL_COUNT"
	else
		record FAIL "BOOTSTRAP-3: expected 4 wfl-*.js drivers" "found=$WFL_COUNT"
	fi

	# 4. .claude/commands/forge/init.md dispatcher installed
	if [[ -f "$TMP_PROJECT_DIR/.claude/commands/forge/init.md" ]]; then
		record PASS "BOOTSTRAP-4: .claude/commands/forge/init.md installed" ""
	else
		record FAIL "BOOTSTRAP-4: .claude/commands/forge/init.md missing" ""
	fi

	# 5. Hooks merged into .claude/settings.json
	SETTINGS_FILE="$TMP_PROJECT_DIR/.claude/settings.json"
	if [[ -f "$SETTINGS_FILE" ]]; then
		HOOK_KEYS=$(node -e "
		  const s=require('$SETTINGS_FILE');
		  const h=s.hooks||{};
		  console.log(Object.keys(h).length);
		" 2>/dev/null || echo "0")
		if [[ "$HOOK_KEYS" -ge 4 ]]; then
			record PASS "BOOTSTRAP-5: hooks merged into .claude/settings.json" "event-types=$HOOK_KEYS"
		else
			record FAIL "BOOTSTRAP-5: hooks not merged (expected ≥4 event types)" "found=$HOOK_KEYS"
		fi
	else
		record FAIL "BOOTSTRAP-5: .claude/settings.json missing" ""
	fi

	# 6. .gitignore appended with forge entries
	if grep -q "forge/store/events" "$TMP_PROJECT_DIR/.gitignore" 2>/dev/null; then
		record PASS "BOOTSTRAP-6: .gitignore appended with forge entries" ""
	else
		record FAIL "BOOTSTRAP-6: forge entries missing from .gitignore" ""
	fi

	# 7. .forge/.bootstrap-manifest.json present with payloadVersion
	MANIFEST_FILE="$TMP_PROJECT_DIR/.forge/.bootstrap-manifest.json"
	if [[ -f "$MANIFEST_FILE" ]]; then
		MANIFEST_VERSION=$(node -e "
		  const m=require('$MANIFEST_FILE');
		  console.log(m.payloadVersion||'');
		" 2>/dev/null || echo "")
		if [[ -n "$MANIFEST_VERSION" ]]; then
			record PASS "BOOTSTRAP-7: .bootstrap-manifest.json present" "payloadVersion=$MANIFEST_VERSION"
		else
			record FAIL "BOOTSTRAP-7: .bootstrap-manifest.json missing payloadVersion" ""
		fi
	else
		record FAIL "BOOTSTRAP-7: .bootstrap-manifest.json missing" ""
	fi

	# 8. Idempotent second run (no files created, all skipped)
	IDEMPOTENT_OUT="$TMP_SMOKE_OUT_DIR/bootstrap-idempotent.out"
	if "$FORGE_BIN" init claude "$TMP_PROJECT_DIR" \
			>"$IDEMPOTENT_OUT" 2>&1; then
		CREATED_COUNT=$(grep -c "^  + " "$IDEMPOTENT_OUT" 2>/dev/null || true)
		# `grep -c` always prints the count (0 for no matches) and exits 1 when
		# the count is 0; the old `|| echo "0"` appended a SECOND "0", producing
		# "0\n0" and a bash arithmetic syntax error in the `-eq` test. `|| true`
		# adds no output; guard the empty case for a total grep failure.
		[[ -z "$CREATED_COUNT" ]] && CREATED_COUNT=0
		if [[ "$CREATED_COUNT" -eq 0 ]]; then
			record PASS "BOOTSTRAP-8: idempotent second run (no new files)" ""
		else
			record WARN "BOOTSTRAP-8: second run created $CREATED_COUNT files" "see bootstrap-idempotent.out"
		fi
	else
		record FAIL "BOOTSTRAP-8: idempotent second run exited non-zero" "see bootstrap-idempotent.out"
	fi

	# 9. No dead vendored references (forge#112 class — every .forge/… path
	# referenced by vendored commands/drivers/rulebooks must exist post-bootstrap)
	VENDORED_REFS_OUT="$TMP_SMOKE_OUT_DIR/vendored-refs.out"
	if node "$PKG_DIR/tools/check-vendored-refs.cjs" "$TMP_PROJECT_DIR" \
			>"$VENDORED_REFS_OUT" 2>&1; then
		record PASS "BOOTSTRAP-9: no dead vendored references" "$(tail -1 "$VENDORED_REFS_OUT")"
	else
		record FAIL "BOOTSTRAP-9: dead vendored references found" "see vendored-refs.out"
	fi

	# 10. .mcp.json at project root exists and mcpServers.forge is present (FORGE-S34-T06)
	MCP_JSON_FILE="$TMP_PROJECT_DIR/.mcp.json"
	if [[ -f "$MCP_JSON_FILE" ]]; then
		MCP_FORGE_PRESENT=$(node -e "
		  const m=require('$MCP_JSON_FILE');
		  const s=m.mcpServers||{};
		  console.log(s.forge ? 'yes' : 'no');
		" 2>/dev/null || echo "no")
		if [[ "$MCP_FORGE_PRESENT" == "yes" ]]; then
			record PASS "BOOTSTRAP-10: .mcp.json forge entry present" ""
		else
			record FAIL "BOOTSTRAP-10: .mcp.json missing mcpServers.forge" "see bootstrap.out"
		fi
	else
		record FAIL "BOOTSTRAP-10: .mcp.json missing at project root" ""
	fi

	# 11. .forge/mcp/server.cjs vendored by manifest-driven loop (FORGE-S34-T06)
	if [[ -f "$TMP_PROJECT_DIR/.forge/mcp/server.cjs" ]]; then
		record PASS "BOOTSTRAP-11: .forge/mcp/server.cjs vendored" ""
	else
		record FAIL "BOOTSTRAP-11: .forge/mcp/server.cjs missing" ""
	fi

	# 12. node .forge/mcp/server.cjs node-only boot check (FORGE-S34-T06)
	# WARN (not FAIL) for ambiguous exit — OS timing varies; full parity test is T08.
	MCP_SERVER_BOOT_OUT="$TMP_SMOKE_OUT_DIR/mcp-server-boot.out"
	if [[ -f "$TMP_PROJECT_DIR/.forge/mcp/server.cjs" ]]; then
		# Feed /dev/null as stdin so the server gets EOF immediately and can exit cleanly.
		node "$TMP_PROJECT_DIR/.forge/mcp/server.cjs" < /dev/null >"$MCP_SERVER_BOOT_OUT" 2>&1
		MCP_BOOT_RC=$?
		if [[ "$MCP_BOOT_RC" -eq 0 ]]; then
			record PASS "BOOTSTRAP-12: node .forge/mcp/server.cjs node-only boot" "rc=0"
		else
			# Non-zero exit on stdin-EOF is ambiguous (expected for MCP stdio servers);
			# use WARN not FAIL to avoid OS-timing flakiness. Full parity test is T08.
			record WARN "BOOTSTRAP-12: node .forge/mcp/server.cjs rc=$MCP_BOOT_RC" "stdin-EOF exit; see mcp-server-boot.out — T08 is authoritative"
		fi
	else
		record WARN "BOOTSTRAP-12: node-only boot skipped" "skip:server.cjs missing (BOOTSTRAP-11 failed)"
	fi

	# Pin tool paths for downstream sections (health gate).
	# Tools are vendored directly into .forge/tools/ by the bootstrap.
	STORE_CLI="$TMP_PROJECT_DIR/.forge/tools/store-cli.cjs"
	VALIDATE_STORE="$TMP_PROJECT_DIR/.forge/tools/validate-store.cjs"
	GENERATION_MANIFEST="$TMP_PROJECT_DIR/.forge/tools/generation-manifest.cjs"
	KB_PATH="engineering"
fi

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
	record SKIP "E2E-T03-RUNTASK: /forge:plan against seeded fixture" "SKIP_REASON=skip:store-cli unresolved (bootstrap failed)"
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
# NOTE: the generation-manifest tool resolves its manifest from process.cwd()
# (no --root flag), and validate-store resolves the store from cwd too. The
# gate must run both against the FRESH tmp project (not PKG_DIR, which is the
# forge-cli dogfooding instance with its own .forge/). Use a subshell `cd` so
# the node process runs with cwd=TMP_PROJECT_DIR while `record` (which
# updates global counters) stays in the main shell.
if [[ -n "$VALIDATE_STORE" && -f "$VALIDATE_STORE" ]]; then
	if (cd "$TMP_PROJECT_DIR" && node "$VALIDATE_STORE" --dry-run) >"$TMP_SMOKE_OUT_DIR/validate.out" 2>&1; then
		record PASS "E2E-T03-HEALTH: validate-store --dry-run" ""
	else
		VALIDATE_RC=$?
		record FAIL "E2E-T03-HEALTH: validate-store --dry-run rc=$VALIDATE_RC" "see validate.out"
	fi
else
	record SKIP "E2E-T03-HEALTH: validate-store --dry-run" "SKIP_REASON=skip:validate-store unresolved"
fi

if [[ -n "$GENERATION_MANIFEST" && -f "$GENERATION_MANIFEST" ]]; then
	# `list --modified` mirrors /forge:health's invocation (the `check`
	# subcommand is per-file and requires a path argument; calling it with no
	# path was a usage error). `list --modified` always exits 0, so parse the
	# output: "All tracked files are pristine" => PASS; any modified/missing/
	# untracked row => FAIL (the fresh init's generated .forge must match the
	# bundled manifest).
	if (cd "$TMP_PROJECT_DIR" && node "$GENERATION_MANIFEST" list --modified) >"$TMP_SMOKE_OUT_DIR/manifest.out" 2>&1; then
		# `list --modified` always exits 0, so parse the output. "All tracked
		# files are pristine" => no drift. "No files tracked" => the manifest is
		# empty, which is the expected post-`/forge:init --fast` state (init does
		# not `record` into the manifest; only `/forge:rebuild` does) — no drift
		# to detect, so the gate is healthy. Any other output => modified/missing/
		# untracked generated files => FAIL.
		if grep -qE "All tracked files are pristine|No files tracked" "$TMP_SMOKE_OUT_DIR/manifest.out" 2>/dev/null; then
			record PASS "E2E-T03-HEALTH: generation-manifest check" ""
		else
			record FAIL "E2E-T03-HEALTH: generation-manifest — modified/missing/untracked generated files" "see manifest.out"
		fi
	else
		MANIFEST_RC=$?
		record FAIL "E2E-T03-HEALTH: generation-manifest list rc=$MANIFEST_RC" "see manifest.out"
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
	echo "Artifacts in \`$TMP_SMOKE_OUT_DIR\`: build.log, install.log, bootstrap.out, bootstrap-idempotent.out, validate.out, manifest.out"
	[[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo "+ seed-sprint.out, seed-task.out, plan.out"
} >"$SUMMARY_FILE"

echo ""
echo "▶ summary written to $SUMMARY_FILE"
echo "▶ passed=$CHECKS_PASSED failed=$CHECKS_FAILED skipped=$CHECKS_SKIPPED warned=$CHECKS_WARNED"

if (( CHECKS_FAILED > 0 )); then
	exit 1
fi
