// Unit tests for forge-cli path resolver — FORGE-S20-T11.

import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	__resetMigrationGuardForTests,
	ensureForgeCliPathsReady,
	getForgeCliUserRoot,
	getGlobalConfigPath,
	getLegacyPaths,
	getMigrationMarkerPath,
	getPiAgentAgentsDir,
	getPiAgentThemesDir,
	getProjectConfigPath,
	getProjectForgeCliDir,
	getUserCacheDir,
	getUserStateDir,
	shortenPath,
} from "../../../../src/extensions/forgecli/paths/paths.js";

const PRIOR_ENV = { ...process.env };

beforeEach(() => {
	__resetMigrationGuardForTests();
	delete process.env.FORGE_CLI_HOME;
	delete process.env.XDG_CACHE_HOME;
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";
});

afterEach(() => {
	process.env = { ...PRIOR_ENV };
});

describe("paths — default resolution", () => {
	it("getForgeCliUserRoot defaults to ~/.pi/forge-cli", () => {
		expect(getForgeCliUserRoot()).toBe(path.join(os.homedir(), ".pi", "forge-cli"));
	});

	it("getGlobalConfigPath nests under the user root", () => {
		expect(getGlobalConfigPath()).toBe(path.join(os.homedir(), ".pi", "forge-cli", "config.json"));
	});

	it("getUserCacheDir nests under the user root", () => {
		expect(getUserCacheDir()).toBe(path.join(os.homedir(), ".pi", "forge-cli", "cache"));
	});

	it("getUserStateDir nests under the user root", () => {
		expect(getUserStateDir()).toBe(path.join(os.homedir(), ".pi", "forge-cli", "state"));
	});

	it("getMigrationMarkerPath sits at the user root", () => {
		expect(getMigrationMarkerPath()).toBe(path.join(os.homedir(), ".pi", "forge-cli", ".migrated-from-legacy"));
	});
});

describe("paths — FORGE_CLI_HOME override", () => {
	it("redirects every user-level accessor", () => {
		const tmp = path.join(os.tmpdir(), `forge-cli-paths-${crypto.randomBytes(6).toString("hex")}`);
		process.env.FORGE_CLI_HOME = tmp;

		expect(getForgeCliUserRoot()).toBe(tmp);
		expect(getGlobalConfigPath()).toBe(path.join(tmp, "config.json"));
		expect(getUserCacheDir()).toBe(path.join(tmp, "cache"));
		expect(getUserStateDir()).toBe(path.join(tmp, "state"));
		expect(getMigrationMarkerPath()).toBe(path.join(tmp, ".migrated-from-legacy"));
	});

	it("empty FORGE_CLI_HOME falls back to default", () => {
		process.env.FORGE_CLI_HOME = "";
		expect(getForgeCliUserRoot()).toBe(path.join(os.homedir(), ".pi", "forge-cli"));
	});
});

describe("paths — legacy resolution invariant (Advisory #2)", () => {
	it("legacy paths derive from os.homedir() regardless of FORGE_CLI_HOME", () => {
		process.env.FORGE_CLI_HOME = "/tmp/some-override-root";
		const legacy = getLegacyPaths();
		expect(legacy.globalConfig.startsWith(os.homedir())).toBe(true);
		expect(legacy.globalConfig).toBe(path.join(os.homedir(), ".pi", "agent", "forge-cli", "config.json"));
		// cacheDir uses XDG_CACHE_HOME, which is the real env var (also unset here).
		expect(legacy.cacheDir).toBe(path.join(os.homedir(), ".cache", "forgecli"));
	});

	it("XDG_CACHE_HOME honored by legacy cache dir", () => {
		process.env.XDG_CACHE_HOME = "/var/tmp/xdg";
		const legacy = getLegacyPaths();
		expect(legacy.cacheDir).toBe("/var/tmp/xdg/forgecli");
	});

	it("FORGE_CLI_HOME does NOT leak into XDG-resolved legacy cache", () => {
		process.env.FORGE_CLI_HOME = "/tmp/override";
		process.env.XDG_CACHE_HOME = "/var/tmp/xdg";
		expect(getLegacyPaths().cacheDir).toBe("/var/tmp/xdg/forgecli");
	});
});

describe("paths — project-level accessors (unchanged)", () => {
	it("getProjectForgeCliDir joins cwd + .pi/forge-cli", () => {
		expect(getProjectForgeCliDir("/work/proj")).toBe("/work/proj/.pi/forge-cli");
	});

	it("getProjectConfigPath nests config.json under the project dir", () => {
		expect(getProjectConfigPath("/work/proj")).toBe("/work/proj/.pi/forge-cli/config.json");
	});
});

describe("paths — pi-namespace accessors (themes, agents)", () => {
	it("themes dir lives under pi's agent dir, not forge-cli's user root", () => {
		process.env.FORGE_CLI_HOME = "/tmp/should-be-ignored";
		const themes = getPiAgentThemesDir();
		expect(themes.includes("/forge-cli/")).toBe(false);
		expect(themes.endsWith("/themes")).toBe(true);
	});

	it("agents dir lives under pi's agent dir, not forge-cli's user root", () => {
		process.env.FORGE_CLI_HOME = "/tmp/should-be-ignored";
		const agents = getPiAgentAgentsDir();
		expect(agents.includes("/forge-cli/")).toBe(false);
		expect(agents.endsWith("/agents")).toBe(true);
	});
});

describe("paths — shortenPath helper", () => {
	it("replaces a leading home prefix with ~", () => {
		const home = os.homedir();
		expect(shortenPath(path.join(home, "a", "b"))).toBe(path.join("~", "a", "b"));
	});

	it("leaves non-home paths untouched", () => {
		expect(shortenPath("/var/tmp/x")).toBe("/var/tmp/x");
	});

	it("ignores FORGE_CLI_HOME (display always uses real $HOME)", () => {
		process.env.FORGE_CLI_HOME = "/tmp/override";
		const home = os.homedir();
		expect(shortenPath(path.join(home, "foo"))).toBe(path.join("~", "foo"));
	});
});

describe("paths — ensureForgeCliPathsReady", () => {
	it("respects FORGE_CLI_SKIP_MIGRATION=1 (no throw, no side effects)", () => {
		process.env.FORGE_CLI_SKIP_MIGRATION = "1";
		expect(() => ensureForgeCliPathsReady()).not.toThrow();
	});

	it("runs at most once per process", () => {
		// Run twice — the second call must short-circuit. We can only
		// observe this by ensuring no exception and no observable
		// state change; deeper observation belongs in migrator tests.
		ensureForgeCliPathsReady();
		ensureForgeCliPathsReady();
	});
});
