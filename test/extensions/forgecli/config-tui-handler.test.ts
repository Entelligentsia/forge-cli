// Tests for runConfigTui — the shared handler used by both `forge config`
// (bin) and `/forge:config` (in-session pi command). Slice 4a — Plan 16.
//
// Slice 4a scope: arg parsing + show-route delegation + stub responses for
// the interactive routes (filled in 4b/4c). No real screens yet.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseConfigTuiArgs,
  readPipelineCatalogue,
  runConfigTui,
  type ConfigTuiRoute,
} from "../../../src/extensions/forgecli/config-tui/handler.js";

let tmp: string;
let agentDir: string;
let captured: string[];
let captureWrite: (s: string) => void;
let savedAgentDirEnv: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-tui-handler-"));
  agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  captured = [];
  captureWrite = (s: string) => captured.push(s);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
});

describe("parseConfigTuiArgs", () => {
  it("no args → top-menu route", () => {
    const r = parseConfigTuiArgs([]);
    expect((r as ConfigTuiRoute).kind).toBe("top-menu");
  });

  it("show → show route, resolved=false, json=false", () => {
    const r = parseConfigTuiArgs(["show"]) as ConfigTuiRoute;
    expect(r.kind).toBe("show");
    if (r.kind === "show") {
      expect(r.resolved).toBe(false);
      expect(r.json).toBe(false);
    }
  });

  it("show --resolved --json → show route with both flags", () => {
    const r = parseConfigTuiArgs(["show", "--resolved", "--json"]) as ConfigTuiRoute;
    expect(r.kind).toBe("show");
    if (r.kind === "show") {
      expect(r.resolved).toBe(true);
      expect(r.json).toBe(true);
    }
  });

  it("edit persona <name> → edit-persona route", () => {
    const r = parseConfigTuiArgs(["edit", "persona", "engineer"]) as ConfigTuiRoute;
    expect(r.kind).toBe("edit-persona");
    if (r.kind === "edit-persona") {
      expect(r.persona).toBe("engineer");
    }
  });

  it("edit override <pipeline> <phaseRole> → edit-override route", () => {
    const r = parseConfigTuiArgs(["edit", "override", "default", "implement"]) as ConfigTuiRoute;
    expect(r.kind).toBe("edit-override");
    if (r.kind === "edit-override") {
      expect(r.pipeline).toBe("default");
      expect(r.phaseRole).toBe("implement");
    }
  });

  it("edit override with missing phaseRole → error", () => {
    const r = parseConfigTuiArgs(["edit", "override", "default"]);
    expect("error" in r).toBe(true);
  });

  it("edit persona with no name → error", () => {
    const r = parseConfigTuiArgs(["edit", "persona"]);
    expect("error" in r).toBe(true);
  });

  it("unknown subcommand → error", () => {
    const r = parseConfigTuiArgs(["bogus"]);
    expect("error" in r).toBe(true);
  });

  it("show with unknown flag → error", () => {
    const r = parseConfigTuiArgs(["show", "--bogus"]);
    expect("error" in r).toBe(true);
  });
});

describe("runConfigTui — non-interactive (no ctx)", () => {
  it("show route delegates to runConfigShow (empty config → exit 0)", async () => {
    const code = await runConfigTui([], tmp, { write: captureWrite });
    // No interactive ctx → defaults to printing usage for top-menu route
    expect(code).toBe(0);
    expect(captured.join("\n")).toMatch(/usage/i);
  });

  it("show route prints something and returns 0", async () => {
    const code = await runConfigTui(["show"], tmp, { write: captureWrite });
    expect(code).toBe(0);
    expect(captured.length).toBeGreaterThan(0);
  });

  it("show --json on empty config returns valid JSON", async () => {
    const code = await runConfigTui(["show", "--json"], tmp, { write: captureWrite });
    expect(code).toBe(0);
    const parsed = JSON.parse(captured.join("\n"));
    expect(parsed).toHaveProperty("personaModels");
    expect(parsed).toHaveProperty("pipelines");
  });

  it("edit persona without ctx → prints fallback usage (interactive requires pi session)", async () => {
    const code = await runConfigTui(
      ["edit", "persona", "engineer"],
      tmp,
      { write: captureWrite },
    );
    expect(code).toBe(0);
    expect(captured.join("\n")).toMatch(/pi session|interactive/i);
  });

  it("edit override without ctx → exit 1 + message", async () => {
    let errMsg = "";
    const code = await runConfigTui(
      ["edit", "override", "default", "2"],
      tmp,
      { write: captureWrite, writeErr: (s) => { errMsg += s; } },
    );
    expect(code).toBe(1);
    expect(errMsg).toMatch(/slice 4c|override editor/i);
  });

  it("parse error → exit 1 + message on stderr", async () => {
    let errMsg = "";
    const code = await runConfigTui(
      ["bogus"],
      tmp,
      { write: captureWrite, writeErr: (s) => { errMsg += s; } },
    );
    expect(code).toBe(1);
    expect(errMsg.length).toBeGreaterThan(0);
  });
});

describe("runConfigTui — interactive (with ctx + mountConfigTui)", () => {
  it("top-menu route calls mountConfigTui with the assembled InitOptions", async () => {
    const calls: Array<{ cwd: string }> = [];
    const ctx = {
      notify: () => {},
      mountConfigTui: async (init: { cwd: string }) => {
        calls.push({ cwd: init.cwd });
        return 0;
      },
    };
    const code = await runConfigTui([], tmp, { write: captureWrite, ctx });
    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0].cwd).toBe(tmp);
  });

  it("edit-persona route also mounts the TUI", async () => {
    let mountCount = 0;
    const ctx = {
      notify: () => {},
      mountConfigTui: async () => {
        mountCount++;
        return 0;
      },
    };
    const code = await runConfigTui(
      ["edit", "persona", "engineer"],
      tmp,
      { write: captureWrite, ctx },
    );
    expect(code).toBe(0);
    expect(mountCount).toBe(1);
  });

  it("when ctx is present but mountConfigTui is not, falls back to printed usage", async () => {
    const notifications: Array<{ msg: string; level?: string }> = [];
    const ctx = {
      notify: (msg: string, level?: string) => notifications.push({ msg, level }),
    };
    const code = await runConfigTui([], tmp, { write: captureWrite, ctx });
    expect(code).toBe(0);
    expect(captured.join("\n")).toMatch(/pi session|interactive/i);
  });

  it("edit-override route stays a 4c stub", async () => {
    const notifications: Array<{ msg: string; level?: string }> = [];
    const ctx = {
      notify: (msg: string, level?: string) => notifications.push({ msg, level }),
      mountConfigTui: async () => 0,
    };
    const code = await runConfigTui(
      ["edit", "override", "default", "2"],
      tmp,
      { write: captureWrite, ctx },
    );
    expect(code).toBe(0);
    expect(notifications.some((n) => /4c/i.test(n.msg))).toBe(true);
  });
});

describe("readPipelineCatalogue (Forge plugin config probe)", () => {
  it("returns null when no .forge/ directory exists", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-catalogue-"));
    expect(readPipelineCatalogue(cwd)).toBeNull();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns ['default'] when .forge/config.json exists with no pipelines key (real Forge project)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-catalogue-"));
    fs.mkdirSync(path.join(cwd, ".forge"));
    fs.writeFileSync(
      path.join(cwd, ".forge", "config.json"),
      JSON.stringify({ version: "1", project: { name: "x", prefix: "X" } }),
    );
    expect(readPipelineCatalogue(cwd)).toEqual(["default"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns custom pipeline names when .forge/config.json declares pipelines", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-catalogue-"));
    fs.mkdirSync(path.join(cwd, ".forge"));
    fs.writeFileSync(
      path.join(cwd, ".forge", "config.json"),
      JSON.stringify({ pipelines: { default: {}, hotfix: {}, "bug-fix": {} } }),
    );
    expect(readPipelineCatalogue(cwd)).toEqual(["default", "hotfix", "bug-fix"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns ['default'] when .forge/config.json has an empty pipelines object", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-catalogue-"));
    fs.mkdirSync(path.join(cwd, ".forge"));
    fs.writeFileSync(
      path.join(cwd, ".forge", "config.json"),
      JSON.stringify({ pipelines: {} }),
    );
    expect(readPipelineCatalogue(cwd)).toEqual(["default"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns ['default'] on malformed JSON if .forge/config.json exists", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-catalogue-"));
    fs.mkdirSync(path.join(cwd, ".forge"));
    fs.writeFileSync(path.join(cwd, ".forge", "config.json"), "{ not json");
    expect(readPipelineCatalogue(cwd)).toEqual(["default"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
