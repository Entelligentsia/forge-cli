#!/usr/bin/env node
// verify-readme-changelog.cjs — FORGE-S19-T04
//
// Hard release gate: ensures every CHANGELOG version heading since [0.1.0]
// (exclusive — 0.1.0 is the baseline and is exempt) has at least one mention
// in README.md, and that the README roadmap "Shipped" reference matches
// package.json:version.
//
// Usage:
//   node scripts/verify-readme-changelog.cjs [--root <path>] [--allow-section-skip]
//
// Exit codes:
//   0 — all checks pass (WARN lines may appear on stderr, but no failures)
//   1 — at least one hard failure detected
//
// No npm dependencies — pure Node.js built-ins only.

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

// ── CLI arg parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

/** Resolve a named flag value: --root <path> → the value after --root */
function flagValue(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const root             = flagValue("--root") || process.cwd();
const allowSectionSkip = args.includes("--allow-section-skip");

// ── File loading ───────────────────────────────────────────────────────────

function loadFile(rel) {
  const abs = path.resolve(root, rel);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (err) {
    console.error(`[verify-readme-changelog] ERROR: cannot read ${abs}: ${err.message}`);
    process.exit(1);
  }
}

const pkgText       = loadFile("package.json");
const readmeText    = loadFile("README.md");
const changelogText = loadFile("CHANGELOG.md");

// ── Parse package.json:version ─────────────────────────────────────────────

let pkgVersion;
try {
  pkgVersion = JSON.parse(pkgText).version;
} catch (err) {
  console.error(`[verify-readme-changelog] ERROR: cannot parse package.json: ${err.message}`);
  process.exit(1);
}

if (!pkgVersion || typeof pkgVersion !== "string") {
  console.error(`[verify-readme-changelog] ERROR: package.json missing "version" field`);
  process.exit(1);
}

// ── Parse CHANGELOG.md version headings ───────────────────────────────────
//
// Matches lines like:
//   ## [1.2.3] — 2026-05-09
//   ## [1.2.3]
//
// [Unreleased] and any non-numeric bracketed headings are intentionally
// excluded by the \d+\.\d+\.\d+ pattern — this is by design.

const CHANGELOG_VERSION_RE = /^## \[(\d+\.\d+\.\d+)\]/gm;

const changelogVersions = [];
let m;
while ((m = CHANGELOG_VERSION_RE.exec(changelogText)) !== null) {
  changelogVersions.push(m[1]);
}

// Baseline [0.1.0] is the first release and is exempt from README mention
// requirement. Every version after 0.1.0 must appear in README.
const BASELINE = "0.1.0";

const versionsToCheck = changelogVersions.filter(v => v !== BASELINE);

// ── Check: every CHANGELOG version mentioned in README ─────────────────────

let failed = false;

for (const version of versionsToCheck) {
  // Accept plain mention (e.g. "0.2.0") or bracketed anchor (e.g. "[0.2.0]")
  // anywhere in the README — not just in headings.
  const mentionedPlain    = readmeText.includes(version);
  const mentionedAnchored = readmeText.includes(`[${version}]`);

  if (!mentionedPlain && !mentionedAnchored) {
    console.error(
      `[verify-readme-changelog] FAIL: CHANGELOG version [${version}] has no mention in README.md.\n` +
      `  Add a reference to ${version} in README.md (e.g. in the roadmap or a feature list).`
    );
    failed = true;
  }
}

// ── Roadmap check ─────────────────────────────────────────────────────────
//
// Looks for a ## Roadmap section in README.md and extracts the version in a
// "Shipped (X.Y.Z)" pattern. Compares to package.json:version.
//
// If --allow-section-skip is set: skip this check entirely (no WARN, no FAIL).
// If no roadmap section: emit WARN on stderr (not a failure).
// If roadmap section present but no "Shipped" pattern: emit WARN.
// If version mismatches: FAIL.

if (!allowSectionSkip) {
  // Extract ## Roadmap section: content between "## Roadmap" and the next "##" heading.
  // Note: we do NOT use the "m" flag here — "^" with "m" causes [\s\S]*? to match
  // zero characters when the lookahead \n## or $ is immediately satisfiable. Instead,
  // match "## Roadmap" as a literal string and use \n## to delimit the section end.
  const roadmapSectionMatch = readmeText.match(/## Roadmap\b([\s\S]*?)(?=\n## |$)/);

  if (!roadmapSectionMatch) {
    // No roadmap section — warn only.
    console.error(
      `[verify-readme-changelog] WARN: README.md has no "## Roadmap" section. ` +
      `Cannot verify shipped version matches package.json:version (${pkgVersion}). ` +
      `Use --allow-section-skip to suppress this warning.`
    );
    // Not a failure — continue.
  } else {
    const roadmapContent = roadmapSectionMatch[1];

    // Match "Shipped (X.Y.Z)" pattern within the roadmap section.
    const shippedMatch = roadmapContent.match(/Shipped\s*\((\d+\.\d+\.\d+)\)/);

    if (!shippedMatch) {
      // Roadmap section exists but has no "Shipped (X.Y.Z)" pattern — warn.
      console.error(
        `[verify-readme-changelog] WARN: README.md "## Roadmap" section has no ` +
        `"Shipped (X.Y.Z)" pattern. Cannot verify shipped version. ` +
        `Expected "Shipped (${pkgVersion})".`
      );
      // Not a failure.
    } else {
      const readmeShippedVersion = shippedMatch[1];

      if (readmeShippedVersion !== pkgVersion) {
        console.error(
          `[verify-readme-changelog] FAIL: README.md roadmap says "Shipped (${readmeShippedVersion})" ` +
          `but package.json:version is "${pkgVersion}".\n` +
          `  Update README.md roadmap to say "Shipped (${pkgVersion})".`
        );
        failed = true;
      }
    }
  }
}

// ── Final result ───────────────────────────────────────────────────────────

if (failed) {
  process.exit(1);
}

// All checks passed.
process.exit(0);
