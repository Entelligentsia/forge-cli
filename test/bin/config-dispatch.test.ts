// Tests for `forge config dispatch` — per-phase dispatch trace (no LLM call).
//
// Coverage:
//  1. parseConfigArgs(['dispatch']) → { subcommand: 'dispatch', json: false }
//  2. parseConfigArgs(['dispatch', '--json']) → json flag set
//  3. parseConfigArgs(['dispatch', '--pipeline=custom']) → pipeline override
//  4. parseConfigArgs(['dispatch', '--unknown']) → error
//  5. runConfigDispatch: empty config → every phase shows "(inherit pi current)"
//  6. runConfigDispatch: persona-models set → requested column shows resolved provider:model
//  7. runConfigDispatch: phase override (L4-name) → commit phase resolves through name
//  8. runConfigDispatch --json: returns DispatchOutput with taskPhases + bugPhases arrays of length 8 + 7
//  9. runConfigDispatch: bug-fix phases honor "fix-bug" pipeline (separate from task pipeline)

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseConfigArgs,
  runConfigDispatch,
  type DispatchOutput,
} from "../../src/bin/config.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-config-dispatch-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), "{}");
  return dir;
}

function writePiConfig(cwd: string, config: object): void {
  const dir = join(cwd, ".pi", "forge-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function captureLines(): { write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    write: (line: string) => {
      lines.push(line);
    },
    lines,
  };
}

// ── parser ────────────────────────────────────────────────────────────────────

describe("parseConfigArgs — dispatch subcommand", () => {
  it("parses `dispatch` with no flags", () => {
    const result = parseConfigArgs(["dispatch"]);
    expect(result).toEqual({
      subcommand: "dispatch",
      resolved: false,
      json: false,
      pipeline: undefined,
    });
  });

  it("parses `dispatch --json`", () => {
    const result = parseConfigArgs(["dispatch", "--json"]);
    expect(result).toEqual({
      subcommand: "dispatch",
      resolved: false,
      json: true,
      pipeline: undefined,
    });
  });

  it("parses `dispatch --pipeline=custom`", () => {
    const result = parseConfigArgs(["dispatch", "--pipeline=custom"]);
    expect(result).toMatchObject({
      subcommand: "dispatch",
      pipeline: "custom",
    });
  });

  it("rejects unknown flag", () => {
    const result = parseConfigArgs(["dispatch", "--what"]);
    expect(result).toHaveProperty("error");
  });
});

// ── runConfigDispatch ─────────────────────────────────────────────────────────

describe("runConfigDispatch", () => {
  let tmpAgent: string;
  let tmpCwd: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    tmpAgent = makeTmpAgentDir();
    tmpCwd = mkdtempSync(join(tmpdir(), "forge-config-cwd-"));
    envBackup = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpAgent;
  });

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = envBackup;
    }
    rmSync(tmpAgent, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("empty config — every task phase shows '(inherit pi current)'", () => {
    const cap = captureLines();
    const code = runConfigDispatch(
      { subcommand: "dispatch", resolved: false, json: false },
      tmpCwd,
      cap.write,
    );
    expect(code).toBe(0);
    const out = cap.lines.join("\n");
    expect(out).toContain("inherit pi current");
    // No requested model lines should claim a provider/model.
    expect(out).not.toMatch(/anthropic:|openai:/);
  });

  it("persona-models set — requested column reflects resolution", () => {
    writePiConfig(tmpCwd, {
      "persona-models": {
        engineer: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        architect: { provider: "anthropic", model: "claude-3-opus-20240229" },
      },
    });
    const cap = captureLines();
    runConfigDispatch(
      { subcommand: "dispatch", resolved: false, json: false },
      tmpCwd,
      cap.write,
    );
    const out = cap.lines.join("\n");
    expect(out).toContain("anthropic:claude-3-5-sonnet-20241022");
    expect(out).toContain("anthropic:claude-3-opus-20240229");
  });

  it("phase override (L4-name) — commit phase resolves through named persona", () => {
    writePiConfig(tmpCwd, {
      "persona-models": {
        engineer: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        collator: { provider: "anthropic", model: "claude-3-5-haiku-20241022" },
      },
      pipelines: {
        default: {
          phases: {
            commit: { "model-override": "collator" },
          },
        },
      },
    });
    const cap = captureLines();
    runConfigDispatch(
      { subcommand: "dispatch", resolved: false, json: false },
      tmpCwd,
      cap.write,
    );
    const out = cap.lines.join("\n");
    // commit row should show haiku (collator's model), not sonnet (engineer's).
    const commitLine = cap.lines.find((l) => l.startsWith("commit "));
    expect(commitLine).toBeDefined();
    expect(commitLine).toContain("claude-3-5-haiku-20241022");
    // Source map should mark commit as L4-name.
    expect(out).toMatch(/task\[commit\s*\]\s+L4-name/);
  });

  it("--json — emits DispatchOutput with taskPhases (8) + bugPhases (7)", () => {
    writePiConfig(tmpCwd, {
      "persona-models": {
        engineer: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      },
    });
    const cap = captureLines();
    runConfigDispatch(
      { subcommand: "dispatch", resolved: false, json: true },
      tmpCwd,
      cap.write,
    );
    expect(cap.lines.length).toBe(1);
    const parsed = JSON.parse(cap.lines[0]!) as DispatchOutput;
    expect(parsed.cwd).toBe(tmpCwd);
    expect(parsed.taskPipeline).toBe("default");
    expect(parsed.taskPhases).toHaveLength(8);
    expect(parsed.bugPhases).toHaveLength(7);
    // engineer phases should carry the sonnet model.
    const planRow = parsed.taskPhases.find((r) => r.phaseRole === "plan");
    expect(planRow?.requested).toEqual({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
  });

  it("bug-fix phases use 'fix-bug' pipeline independently of task pipeline", () => {
    writePiConfig(tmpCwd, {
      "persona-models": {
        "bug-fixer": { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        supervisor: { provider: "anthropic", model: "claude-3-opus-20240229" },
      },
      pipelines: {
        "fix-bug": {
          phases: {
            triage: { "model-override": "supervisor" },
          },
        },
      },
    });
    const cap = captureLines();
    runConfigDispatch(
      { subcommand: "dispatch", resolved: false, json: true },
      tmpCwd,
      cap.write,
    );
    const parsed = JSON.parse(cap.lines[0]!) as DispatchOutput;
    const triage = parsed.bugPhases.find((r) => r.phaseRole === "triage");
    expect(triage?.requested?.model).toBe("claude-3-opus-20240229");
    expect(triage?.source).toBe("L4-name");
  });
});
