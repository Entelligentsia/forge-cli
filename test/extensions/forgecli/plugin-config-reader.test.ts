// Tests for the plugin-config-reader (Slice 4a — Plan 16).
//
// Read-only loader for .forge/config.json. Surfaces a curated view for the
// Slice 4 TUI's plugin-config section. Never mutates anything.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPluginConfig,
  type PluginConfigSummary,
} from "../../../src/extensions/forgecli/config-tui/plugin-config-reader.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-config-reader-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeForgeConfig(content: unknown): void {
  const dir = path.join(tmp, ".forge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(content, null, 2));
}

describe("readPluginConfig", () => {
  it("returns null when .forge/config.json is absent", () => {
    expect(readPluginConfig(tmp)).toBeNull();
  });

  it("returns null when .forge/ exists but config.json is absent", () => {
    fs.mkdirSync(path.join(tmp, ".forge"));
    expect(readPluginConfig(tmp)).toBeNull();
  });

  it("returns the summary fields from a populated config", () => {
    writeForgeConfig({
      version: "1.0",
      project: { name: "TestProj", prefix: "TP" },
      paths: {
        engineering: "engineering",
        store: ".forge/store",
        workflows: ".forge/workflows",
        forgeRoot: "/home/x/.claude/plugins/cache/skillforge/forge/0.43.19",
        forgeRef: "0.43.19",
      },
      installedSkills: ["foo", "bar"],
    });

    const summary = readPluginConfig(tmp);
    expect(summary).not.toBeNull();
    expect(summary!.version).toBe("1.0");
    expect(summary!.projectName).toBe("TestProj");
    expect(summary!.projectPrefix).toBe("TP");
    expect(summary!.installedSkills).toEqual(["foo", "bar"]);
    expect(summary!.forgeRef).toBe("0.43.19");
    expect(summary!.paths.engineering).toBe("engineering");
    expect(summary!.paths.store).toBe(".forge/store");
    expect(summary!.mode).toBeNull();
    expect(summary!.modeLegacy).toBe(false);
  });

  it("marks legacy 'mode' field with modeLegacy=true", () => {
    writeForgeConfig({
      version: "1.0",
      project: { name: "P", prefix: "P" },
      mode: "fast",
      paths: { engineering: "e", store: "s" },
      installedSkills: [],
    });

    const summary = readPluginConfig(tmp);
    expect(summary!.mode).toBe("fast");
    expect(summary!.modeLegacy).toBe(true);
  });

  it("returns null when config.json is malformed JSON", () => {
    const dir = path.join(tmp, ".forge");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{not valid json");
    expect(readPluginConfig(tmp)).toBeNull();
  });

  it("tolerates missing optional fields without throwing", () => {
    writeForgeConfig({ version: "1.0" });
    const summary = readPluginConfig(tmp);
    expect(summary).not.toBeNull();
    expect(summary!.version).toBe("1.0");
    expect(summary!.projectName).toBeNull();
    expect(summary!.installedSkills).toEqual([]);
  });

  it("does not write to the config file (read-only)", () => {
    writeForgeConfig({ version: "1.0", project: { name: "X", prefix: "X" } });
    const cfgPath = path.join(tmp, ".forge", "config.json");
    const beforeMtime = fs.statSync(cfgPath).mtimeMs;
    readPluginConfig(tmp);
    readPluginConfig(tmp);
    const afterMtime = fs.statSync(cfgPath).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });
});

describe("PluginConfigSummary shape", () => {
  it("has the expected shape (compile-time sanity)", () => {
    const s: PluginConfigSummary = {
      version: "1.0",
      projectName: "P",
      projectPrefix: "P",
      paths: { engineering: "e", store: "s" },
      installedSkills: [],
      forgeRef: null,
      mode: null,
      modeLegacy: false,
    };
    expect(s.version).toBe("1.0");
  });
});
