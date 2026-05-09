// Unit tests for verify-readme-changelog.cjs (FORGE-S19-T04).
//
// Coverage:
//   (a) All CHANGELOG versions mentioned in README, roadmap matches → exit 0
//   (b) CHANGELOG entry missing from README → exit 1, error names offending version
//   (c) README roadmap version mismatch → exit 1, error names mismatch
//   (d) No roadmap section in README → exit 0, WARN on stderr (not a failure)
//   (e) --allow-section-skip suppresses roadmap check (no WARN, no FAIL)

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "scripts",
  "verify-readme-changelog.cjs"
);

/** Create a temp directory with synthetic package.json / README.md / CHANGELOG.md */
function makeFixture(opts: {
  version: string;
  changelog: string;
  readme: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrc-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: opts.version }), "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), opts.readme, "utf8");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), opts.changelog, "utf8");
  return dir;
}

/** Run the script in the given dir and return {exitCode, stdout, stderr} */
function run(dir: string, extraArgs: string[] = []): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = childProcess.spawnSync(
    "node",
    [SCRIPT, "--root", dir, ...extraArgs],
    { encoding: "utf8", timeout: 10_000 }
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let tmpDir: string | null = null;

beforeEach(() => {
  tmpDir = null;
});

afterEach(() => {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── (a) All versions matched — passes ──────────────────────────────────────

describe("(a) all CHANGELOG versions mentioned in README with matching roadmap", () => {
  it("exits 0 with no error output", () => {
    tmpDir = makeFixture({
      version: "0.2.0",
      changelog: [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [0.2.0] — 2026-01-01",
        "",
        "### Added",
        "- Feature X",
        "",
        "## [0.1.0] — 2025-12-01",
        "",
        "### Added",
        "- Initial release",
      ].join("\n"),
      readme: [
        "# My Package",
        "",
        "Version 0.2.0 is released.",
        "",
        "## Roadmap",
        "",
        "| Feature | Status |",
        "|---------|--------|",
        "| Core    | Shipped (0.2.0) |",
        "",
        "## Links",
        "",
        "See changelog.",
      ].join("\n"),
    });

    const { exitCode, stderr } = run(tmpDir);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("FAIL");
    expect(stderr).not.toContain("WARN");
  });
});

// ── (b) CHANGELOG entry missing from README — fails ────────────────────────

describe("(b) CHANGELOG entry missing from README", () => {
  it("exits 1 and names the offending version", () => {
    // CHANGELOG has both 0.2.0 and 0.3.0. README only mentions 0.3.0 (in roadmap
    // as the shipped version). 0.2.0 has NO mention anywhere in the README.
    tmpDir = makeFixture({
      version: "0.3.0",
      changelog: [
        "# Changelog",
        "",
        "## [0.3.0] — 2026-02-01",
        "",
        "### Added",
        "- Feature Z",
        "",
        "## [0.2.0] — 2026-01-01",
        "",
        "### Added",
        "- Feature Y",
        "",
        "## [0.1.0] — 2025-12-01",
        "",
        "### Added",
        "- Initial release",
      ].join("\n"),
      readme: [
        "# My Package",
        "",
        "See the changelog for release notes.",
        "",
        "## Roadmap",
        "",
        "| Feature | Status |",
        "|---------|--------|",
        "| Core    | Shipped (0.3.0) |",
        "",
        "## Links",
        "",
        "See changelog.",
      ].join("\n"),
    });

    const { exitCode, stderr } = run(tmpDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAIL");
    expect(stderr).toContain("0.2.0");
    expect(stderr).toContain("README.md");
  });
});

// ── (c) README roadmap version mismatch — fails ────────────────────────────

describe("(c) README roadmap shipped version mismatches package.json:version", () => {
  it("exits 1 and names the mismatch", () => {
    tmpDir = makeFixture({
      version: "0.3.0",
      changelog: [
        "# Changelog",
        "",
        "## [0.3.0] — 2026-02-01",
        "",
        "### Added",
        "- Feature Z",
        "",
        "## [0.1.0] — 2025-12-01",
        "",
        "### Added",
        "- Initial release",
      ].join("\n"),
      readme: [
        "# My Package",
        "",
        "Version 0.3.0 is released.",
        "",
        "## Roadmap",
        "",
        "| Feature | Status |",
        "|---------|--------|",
        "| Core    | Shipped (0.2.0) |",
        "",
        "## Links",
        "",
        "See changelog.",
      ].join("\n"),
    });

    const { exitCode, stderr } = run(tmpDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAIL");
    expect(stderr).toContain("0.2.0");
    expect(stderr).toContain("0.3.0");
  });
});

// ── (d) No roadmap section — warns but does not fail ──────────────────────

describe("(d) no roadmap section in README", () => {
  it("exits 0 and emits a WARN to stderr", () => {
    tmpDir = makeFixture({
      version: "0.2.0",
      changelog: [
        "# Changelog",
        "",
        "## [0.2.0] — 2026-01-01",
        "",
        "### Added",
        "- Feature X",
        "",
        "## [0.1.0] — 2025-12-01",
        "",
        "### Added",
        "- Initial release",
      ].join("\n"),
      readme: [
        "# My Package",
        "",
        "Version 0.2.0 is released.",
        "",
        "## Links",
        "",
        "See changelog.",
      ].join("\n"),
    });

    const { exitCode, stderr } = run(tmpDir);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("WARN");
    expect(stderr).not.toContain("FAIL");
  });
});

// ── (e) --allow-section-skip suppresses roadmap check ─────────────────────

describe("(e) --allow-section-skip suppresses roadmap mismatch failure", () => {
  it("exits 0 even when roadmap version mismatches", () => {
    tmpDir = makeFixture({
      version: "0.3.0",
      changelog: [
        "# Changelog",
        "",
        "## [0.3.0] — 2026-02-01",
        "",
        "### Added",
        "- Feature Z",
        "",
        "## [0.1.0] — 2025-12-01",
        "",
        "### Added",
        "- Initial release",
      ].join("\n"),
      readme: [
        "# My Package",
        "",
        "Version 0.3.0 is released.",
        "",
        "## Roadmap",
        "",
        "| Feature | Status |",
        "|---------|--------|",
        "| Core    | Shipped (0.2.0) |",
        "",
        "## Links",
        "",
        "See changelog.",
      ].join("\n"),
    });

    // With --allow-section-skip: roadmap mismatch is ignored → pass
    const { exitCode, stderr } = run(tmpDir, ["--allow-section-skip"]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("FAIL");
  });
});
