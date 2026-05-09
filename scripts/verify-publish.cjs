#!/usr/bin/env node
// verify-publish.cjs — FORGE-S19-T05
//
// Post-publish verifier: reads back from the npm registry after `npm publish`
// to confirm the published version and dist-tags.latest match expectations.
//
// Usage:
//   node scripts/verify-publish.cjs --version <VERSION> [--package <PKG>] [--allow-non-latest] [--root <path>]
//
// Exit codes:
//   0 — all checks pass (WARN lines may appear on stderr, but no failures)
//   1 — at least one hard failure detected
//
// No npm dependencies — pure Node.js built-ins only.

"use strict";

const fs          = require("node:fs");
const path        = require("node:path");
const childProcess = require("node:child_process");

// ── CLI arg parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

/** Resolve a named flag value: --version 1.2.3 → "1.2.3" */
function flagValue(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const rawVersion    = flagValue("--version");
const rawPackage    = flagValue("--package");
const root          = flagValue("--root") || process.cwd();
const allowNonLatest = args.includes("--allow-non-latest");

// ── Guard: --version is required ──────────────────────────────────────────

if (!rawVersion) {
  console.error(
    "[verify-publish] ERROR: --version <VERSION> is required.\n" +
    "  Usage: node scripts/verify-publish.cjs --version <VERSION> [--package <PKG>] [--allow-non-latest]"
  );
  process.exit(1);
}

const version = rawVersion.trim();

// ── Resolve package name ───────────────────────────────────────────────────

let packageName = rawPackage ? rawPackage.trim() : null;

if (!packageName) {
  const pkgPath = path.resolve(root, "package.json");
  try {
    const pkgText = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(pkgText);
    packageName = pkg.name;
  } catch (err) {
    console.error(
      `[verify-publish] ERROR: cannot read/parse ${pkgPath}: ${err.message}\n` +
      "  Provide --package <PKG> explicitly."
    );
    process.exit(1);
  }
}

if (!packageName || typeof packageName !== "string") {
  console.error(
    "[verify-publish] ERROR: could not resolve package name. " +
    "Provide --package <PKG> explicitly."
  );
  process.exit(1);
}

// ── Helper: run npm via spawnSync (Iron Law 6: argv array, no shell) ──────

/**
 * @param {string[]} npmArgs
 * @returns {{ stdout: string, stderr: string, exitCode: number, error: Error|null }}
 */
function runNpm(npmArgs) {
  const result = childProcess.spawnSync("npm", npmArgs, {
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });

  if (result.error) {
    return { stdout: "", stderr: "", exitCode: 1, error: result.error };
  }

  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1,
    error: null,
  };
}

// ── Check 1: npm view <PKG>@<VERSION> version ─────────────────────────────
//
// Confirms the registry has the expected version registered.

let failed = false;
const versionSpec = `${packageName}@${version}`;

console.log(`[verify-publish] Checking version: npm view ${versionSpec} version`);

const versionResult = runNpm(["view", versionSpec, "version"]);

if (versionResult.error || versionResult.exitCode !== 0) {
  const reason = versionResult.error
    ? versionResult.error.message
    : `npm exited ${versionResult.exitCode}${versionResult.stderr ? ": " + versionResult.stderr : ""}`;
  console.error(
    `[verify-publish] [warn] registry check failed — verify manually: npm view ${versionSpec}\n` +
    `  Reason: ${reason}`
  );
  process.exit(1);
}

const registryVersion = versionResult.stdout;

if (registryVersion !== version) {
  console.error(
    `[verify-publish] FAIL: registry version mismatch.\n` +
    `  Expected: ${version}\n` +
    `  Got:      ${registryVersion}\n` +
    `  Run: npm view ${versionSpec} version`
  );
  failed = true;
} else {
  console.log(`[verify-publish] OK: registry version matches: ${registryVersion}`);
}

// ── Check 2: npm view <PKG> dist-tags --json ──────────────────────────────
//
// Confirms dist-tags.latest points at the expected version.

console.log(`[verify-publish] Checking dist-tags: npm view ${packageName} dist-tags --json`);

const distTagsResult = runNpm(["view", packageName, "dist-tags", "--json"]);

if (distTagsResult.error || distTagsResult.exitCode !== 0) {
  const reason = distTagsResult.error
    ? distTagsResult.error.message
    : `npm exited ${distTagsResult.exitCode}${distTagsResult.stderr ? ": " + distTagsResult.stderr : ""}`;
  console.error(
    `[verify-publish] [warn] registry check failed — verify manually: npm view ${versionSpec}\n` +
    `  Reason: ${reason}`
  );
  process.exit(1);
}

let distTags;
try {
  distTags = JSON.parse(distTagsResult.stdout);
} catch (parseErr) {
  console.error(
    `[verify-publish] [warn] registry check failed — verify manually: npm view ${versionSpec}\n` +
    `  Reason: could not parse dist-tags JSON: ${parseErr.message}`
  );
  process.exit(1);
}

const latestTag = distTags && distTags.latest;

if (latestTag !== version) {
  const msg =
    `[verify-publish] dist-tags.latest is "${latestTag}", expected "${version}".\n` +
    `  Run: npm dist-tag add ${versionSpec} latest`;
  if (allowNonLatest) {
    console.error(`[verify-publish] WARN: ${msg}\n  --allow-non-latest set — continuing.`);
    // Not a failure.
  } else {
    console.error(`[verify-publish] FAIL: ${msg}`);
    failed = true;
  }
} else {
  console.log(`[verify-publish] OK: dist-tags.latest matches: ${latestTag}`);
}

// ── Final result ───────────────────────────────────────────────────────────

if (failed) {
  process.exit(1);
}

console.log(`[verify-publish] All checks passed for ${versionSpec}.`);
process.exit(0);
