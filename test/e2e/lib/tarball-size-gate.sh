#!/usr/bin/env bash
# Shared compressed-tarball size budget for forge-cli release health.
#
# Sourced by:
#   - test/e2e/smoke.sh         — enforces budget on every smoke run
#   - test/e2e/size-budget.test.sh — unit tests the helper itself
#
# Single source of truth: edit the constants here to retune the budget.
# Override at runtime via env vars (used by the test harness).

# Budgets in bytes. Defaults:
#   warn = 35 MiB  (≈10% over 0.1.0 baseline; surfaces creep)
#   hard = 50 MiB  (≈40% over 0.1.0 baseline; prevents doubling)
TARBALL_BUDGET_WARN_BYTES=${TARBALL_BUDGET_WARN_BYTES:-$((35 * 1024 * 1024))}
TARBALL_BUDGET_HARD_BYTES=${TARBALL_BUDGET_HARD_BYTES:-$((50 * 1024 * 1024))}

# check_tarball_size <bytes>
#
# stdout:  line 1 = verdict (pass|warn|fail)
#          line 2 = human-readable detail
# return:  0 = pass   (bytes <= warn threshold)
#          1 = warn   (warn < bytes <= hard threshold)
#          2 = fail   (bytes > hard threshold, or invalid input)
check_tarball_size() {
	local bytes=${1:-}
	if [[ -z "$bytes" || ! "$bytes" =~ ^[0-9]+$ ]]; then
		echo "fail"
		echo "invalid byte count: '${bytes}'"
		return 2
	fi

	local mb warn_mb hard_mb
	mb=$(awk -v b="$bytes" 'BEGIN { printf "%.2f", b/1024/1024 }')
	warn_mb=$((TARBALL_BUDGET_WARN_BYTES / 1024 / 1024))
	hard_mb=$((TARBALL_BUDGET_HARD_BYTES / 1024 / 1024))

	if (( bytes > TARBALL_BUDGET_HARD_BYTES )); then
		echo "fail"
		echo "tarball ${mb} MB exceeds hard budget ${hard_mb} MB"
		return 2
	elif (( bytes > TARBALL_BUDGET_WARN_BYTES )); then
		echo "warn"
		echo "tarball ${mb} MB exceeds warn threshold ${warn_mb} MB (hard ${hard_mb} MB)"
		return 1
	else
		echo "pass"
		echo "tarball ${mb} MB within budget (warn ${warn_mb} MB, hard ${hard_mb} MB)"
		return 0
	fi
}

# tarball_size_bytes <path>
#
# Echoes the byte size of the given file. Returns 0 on success, 1 on failure.
# Linux uses `stat -c%s`; macOS BSD uses `stat -f%z`. We try both.
tarball_size_bytes() {
	local path=${1:-}
	if [[ -z "$path" || ! -f "$path" ]]; then
		return 1
	fi
	local sz
	if sz=$(stat -c%s "$path" 2>/dev/null); then
		echo "$sz"
		return 0
	elif sz=$(stat -f%z "$path" 2>/dev/null); then
		echo "$sz"
		return 0
	fi
	return 1
}
