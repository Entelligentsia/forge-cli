// Unit tests for verify-publish.cjs (FORGE-S19-T05).
//
// Coverage:
//   (a) Success: mock npm returns matching version and dist-tags — exits 0
//   (b) Version mismatch: mock returns wrong version — exits 1, error in stderr
//   (c) Network failure / npm non-zero exit — exits 1, [warn] in stderr
//   (d) --allow-non-latest: dist-tags.latest mismatch warns but exits 0
//
// Mock strategy: create a temp directory with a fake `npm` script on PATH.
// The mock script is a minimal shell script that emits controlled stdout/stderr
// and exits with a controlled code based on the args passed to it.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "scripts",
  "verify-publish.cjs"
);

/**
 * Create a temp directory with a fake npm script on PATH.
 *
 * @param opts.viewVersionOutput - stdout for `npm view <pkg>@<ver> version`
 * @param opts.viewVersionExit   - exit code for the version view call
 * @param opts.distTagsOutput    - stdout for `npm view <pkg> dist-tags --json`
 * @param opts.distTagsExit      - exit code for the dist-tags call
 */
function makeMockNpmDir(opts: {
  viewVersionOutput?: string;
  viewVersionExit?: number;
  distTagsOutput?: string;
  distTagsExit?: number;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-test-"));

  const {
    viewVersionOutput = "0.4.0",
    viewVersionExit   = 0,
    distTagsOutput    = JSON.stringify({ latest: "0.4.0" }),
    distTagsExit      = 0,
  } = opts;

  // Write a fake npm shell script that inspects its arguments and returns
  // the appropriate mock output.
  const npmScript = `#!/bin/sh
# Fake npm for verify-publish tests
ARGS="$*"
case "$ARGS" in
  *dist-tags*)
    printf '%s\\n' '${distTagsOutput.replace(/'/g, "'\\''")}'
    exit ${distTagsExit}
    ;;
  *)
    printf '%s\\n' '${viewVersionOutput}'
    exit ${viewVersionExit}
    ;;
esac
`;

  const npmPath = path.join(dir, "npm");
  fs.writeFileSync(npmPath, npmScript, { mode: 0o755 });

  return dir;
}

/**
 * Create a temp root directory with a minimal package.json.
 */
function makeRootDir(version: string = "0.4.0", name: string = "@entelligentsia/forgecli"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-root-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version }),
    "utf8"
  );
  return dir;
}

/**
 * Run the script with mocked npm on PATH and return {exitCode, stdout, stderr}.
 */
function run(
  mockNpmDir: string,
  rootDir: string,
  extraArgs: string[] = []
): { exitCode: number; stdout: string; stderr: string } {
  // Prepend mockNpmDir to PATH so our fake npm is found first.
  const env = {
    ...process.env,
    PATH: `${mockNpmDir}:${process.env.PATH ?? ""}`,
  };

  const result = childProcess.spawnSync(
    "node",
    [SCRIPT, "--root", rootDir, ...extraArgs],
    { encoding: "utf8", timeout: 15_000, env }
  );

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Temp dirs to clean up after each test.
let dirsToCleanup: string[] = [];

beforeEach(() => {
  dirsToCleanup = [];
});

afterEach(() => {
  for (const d of dirsToCleanup) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── (a) Success ────────────────────────────────────────────────────────────

describe("(a) success — version and dist-tags match", () => {
  it("exits 0 with no FAIL or WARN on stderr", () => {
    const npmDir  = makeMockNpmDir({
      viewVersionOutput: "0.4.0",
      viewVersionExit:   0,
      distTagsOutput:    JSON.stringify({ latest: "0.4.0" }),
      distTagsExit:      0,
    });
    const rootDir = makeRootDir("0.4.0");
    dirsToCleanup.push(npmDir, rootDir);

    const { exitCode, stderr } = run(npmDir, rootDir, ["--version", "0.4.0"]);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("FAIL");
    expect(stderr).not.toContain("WARN");
  });
});

// ── (b) Version mismatch ───────────────────────────────────────────────────

describe("(b) version mismatch — registry returns wrong version", () => {
  it("exits 1 and names the mismatch on stderr", () => {
    const npmDir  = makeMockNpmDir({
      viewVersionOutput: "0.3.0",   // registry has 0.3.0, not expected 0.4.0
      viewVersionExit:   0,
      distTagsOutput:    JSON.stringify({ latest: "0.3.0" }),
      distTagsExit:      0,
    });
    const rootDir = makeRootDir("0.4.0");
    dirsToCleanup.push(npmDir, rootDir);

    const { exitCode, stderr } = run(npmDir, rootDir, ["--version", "0.4.0"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAIL");
    expect(stderr).toContain("0.4.0");
    expect(stderr).toContain("0.3.0");
  });
});

// ── (c) Network failure / npm non-zero exit ────────────────────────────────

describe("(c) network failure — npm view exits non-zero", () => {
  it("exits 1 and includes [warn] registry check failed on stderr", () => {
    const npmDir  = makeMockNpmDir({
      viewVersionOutput: "",
      viewVersionExit:   1,    // simulate npm failure (E404, ENOTFOUND, etc.)
      distTagsOutput:    "",
      distTagsExit:      1,
    });
    const rootDir = makeRootDir("0.4.0");
    dirsToCleanup.push(npmDir, rootDir);

    const { exitCode, stderr } = run(npmDir, rootDir, ["--version", "0.4.0"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("[warn] registry check failed");
  });
});

// ── (d) --allow-non-latest: dist-tags mismatch warns but exits 0 ──────────

describe("(d) --allow-non-latest — dist-tags.latest mismatch is warn not fail", () => {
  it("exits 0 and emits WARN to stderr (not FAIL)", () => {
    const npmDir  = makeMockNpmDir({
      viewVersionOutput: "0.4.0",   // version check passes
      viewVersionExit:   0,
      distTagsOutput:    JSON.stringify({ latest: "0.3.0" }),  // latest still old
      distTagsExit:      0,
    });
    const rootDir = makeRootDir("0.4.0");
    dirsToCleanup.push(npmDir, rootDir);

    const { exitCode, stderr } = run(npmDir, rootDir, [
      "--version", "0.4.0",
      "--allow-non-latest",
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("WARN");
    expect(stderr).not.toContain("FAIL");
  });
});
