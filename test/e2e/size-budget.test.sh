#!/usr/bin/env bash
# Unit test for test/e2e/lib/tarball-size-gate.sh.
#
# Tests the helper in isolation — no real tarball synthesis needed
# (FORGE-S17-T05 AC#6 explicitly permits this).
#
# Run: ./test/e2e/size-budget.test.sh

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/tarball-size-gate.sh
source "$SCRIPT_DIR/lib/tarball-size-gate.sh"

PASS=0
FAIL=0
FAILURES=()

assert_rc() {
	# assert_rc <label> <expected_rc> <bytes_arg>
	local label=$1 expected=$2 input=$3
	local got
	check_tarball_size "$input" >/dev/null
	got=$?
	if [[ "$got" -eq "$expected" ]]; then
		echo "  ✓ $label (rc=$got)"
		PASS=$((PASS + 1))
	else
		echo "  ✗ $label (expected rc=$expected, got rc=$got)"
		FAIL=$((FAIL + 1))
		FAILURES+=("$label")
	fi
}

assert_verdict() {
	# assert_verdict <label> <expected_verdict_word> <bytes_arg>
	local label=$1 expected=$2 input=$3
	local out verdict
	out=$(check_tarball_size "$input" || true)
	verdict=$(echo "$out" | head -n 1)
	if [[ "$verdict" == "$expected" ]]; then
		echo "  ✓ $label (verdict=$verdict)"
		PASS=$((PASS + 1))
	else
		echo "  ✗ $label (expected verdict=$expected, got=$verdict)"
		FAIL=$((FAIL + 1))
		FAILURES+=("$label")
	fi
}

echo "▶ check_tarball_size — return-code matrix"

# Pass band: ≤ 35 MB
assert_rc "0 bytes → pass"                      0 0
assert_rc "20 MB → pass"                        0 $((20 * 1024 * 1024))
assert_rc "35 MB exactly → pass (warn-bound inclusive)"  0 $((35 * 1024 * 1024))

# Warn band: 35 MB < x ≤ 50 MB
assert_rc "35 MB + 1 byte → warn"               1 $((35 * 1024 * 1024 + 1))
assert_rc "40 MB → warn"                        1 $((40 * 1024 * 1024))
assert_rc "50 MB exactly → warn (hard-bound inclusive)"  1 $((50 * 1024 * 1024))

# Fail band: > 50 MB
assert_rc "50 MB + 1 byte → fail"               2 $((50 * 1024 * 1024 + 1))
assert_rc "60 MB → fail (T05 AC#6 synthetic threshold)" 2 $((60 * 1024 * 1024))
assert_rc "1 GB → fail"                         2 $((1024 * 1024 * 1024))

# Invalid input
assert_rc "non-numeric → fail"                  2 "abc"
assert_rc "empty → fail"                        2 ""
assert_rc "negative → fail (regex blocks '-')"  2 "-100"

echo ""
echo "▶ check_tarball_size — verdict word"

assert_verdict "20 MB → 'pass'"  pass $((20 * 1024 * 1024))
assert_verdict "40 MB → 'warn'"  warn $((40 * 1024 * 1024))
assert_verdict "60 MB → 'fail'"  fail $((60 * 1024 * 1024))

echo ""
echo "▶ env-override budgets"

# Override budgets, re-source to pick up new defaults
(
	export TARBALL_BUDGET_WARN_BYTES=$((10 * 1024 * 1024))
	export TARBALL_BUDGET_HARD_BYTES=$((20 * 1024 * 1024))
	# shellcheck source=lib/tarball-size-gate.sh
	source "$SCRIPT_DIR/lib/tarball-size-gate.sh"
	check_tarball_size $((15 * 1024 * 1024)) >/dev/null
	rc=$?
	if [[ "$rc" -eq 1 ]]; then
		echo "  ✓ env override: 15 MB → warn (custom warn=10/hard=20) (rc=$rc)"
		exit 0
	else
		echo "  ✗ env override: 15 MB expected warn (rc=1), got rc=$rc"
		exit 1
	fi
)
if [[ $? -eq 0 ]]; then
	PASS=$((PASS + 1))
else
	FAIL=$((FAIL + 1))
	FAILURES+=("env override")
fi

echo ""
echo "▶ tarball_size_bytes — file measurement"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
# Write 1 KiB
dd if=/dev/zero of="$TMP" bs=1024 count=1 2>/dev/null
sz=$(tarball_size_bytes "$TMP")
if [[ "$sz" == "1024" ]]; then
	echo "  ✓ tarball_size_bytes returns 1024 for 1 KiB file"
	PASS=$((PASS + 1))
else
	echo "  ✗ tarball_size_bytes returned '$sz', expected 1024"
	FAIL=$((FAIL + 1))
	FAILURES+=("tarball_size_bytes 1 KiB")
fi

if tarball_size_bytes /nonexistent/path/$$.tarball >/dev/null 2>&1; then
	echo "  ✗ tarball_size_bytes returned 0 for nonexistent file (expected non-zero)"
	FAIL=$((FAIL + 1))
	FAILURES+=("tarball_size_bytes nonexistent")
else
	echo "  ✓ tarball_size_bytes returns non-zero for nonexistent file"
	PASS=$((PASS + 1))
fi

echo ""
echo "passed=$PASS failed=$FAIL"

if (( FAIL > 0 )); then
	echo ""
	echo "Failures:"
	for f in "${FAILURES[@]}"; do
		echo "  - $f"
	done
	exit 1
fi
exit 0
