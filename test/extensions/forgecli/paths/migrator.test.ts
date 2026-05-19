// Unit tests for forge-cli legacy-data migrator — FORGE-S20-T11.
//
// Scenarios:
//   1. legacy-only present → moves files, writes marker.
//   2. mixed (config legacy + cache new-only): moves only legacy.
//   3. neither present: writes marker, marks not-ran.
//   4. partial-success (one file fails to move): marker NOT written,
//      retry on next call moves the remaining file.
//   5. idempotent re-run: marker present → no-op.
//   6. existing new-path files are never overwritten by legacy.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateLegacyData } from "../../../../src/extensions/forgecli/paths/migrator.js";

const PRIOR_ENV = { ...process.env };

function freshDirs() {
	const id = crypto.randomBytes(6).toString("hex");
	const home = path.join(os.tmpdir(), `forge-cli-mig-home-${id}`);
	const xdg = path.join(os.tmpdir(), `forge-cli-mig-xdg-${id}`);
	const userRoot = path.join(os.tmpdir(), `forge-cli-mig-userroot-${id}`);
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(xdg, { recursive: true });
	return { home, xdg, userRoot };
}

function setEnv({ home, xdg, userRoot }: { home: string; xdg: string; userRoot: string }) {
	// Override $HOME for legacy resolution and FORGE_CLI_HOME for new root.
	// vitest pools may cache os.homedir() so we stub it directly to guarantee
	// the per-test home is honored.
	process.env.HOME = home;
	process.env.XDG_CACHE_HOME = xdg;
	process.env.FORGE_CLI_HOME = userRoot;
}

function legacyConfigDir(home: string) {
	return path.join(home, ".pi", "agent", "forge-cli");
}

function legacyCacheDir(xdg: string) {
	return path.join(xdg, "forgecli");
}

beforeEach(() => {
	// Reset env to a clean baseline. Each test sets its own HOME/XDG/FORGE_CLI_HOME.
	delete process.env.FORGE_CLI_HOME;
	delete process.env.XDG_CACHE_HOME;
});

afterEach(() => {
	// Restore specific keys we touched. Replacing process.env wholesale
	// confuses some Node internals around os.homedir() resolution.
	if (PRIOR_ENV.HOME !== undefined) process.env.HOME = PRIOR_ENV.HOME;
	else delete process.env.HOME;
	if (PRIOR_ENV.XDG_CACHE_HOME !== undefined) process.env.XDG_CACHE_HOME = PRIOR_ENV.XDG_CACHE_HOME;
	else delete process.env.XDG_CACHE_HOME;
	if (PRIOR_ENV.FORGE_CLI_HOME !== undefined) process.env.FORGE_CLI_HOME = PRIOR_ENV.FORGE_CLI_HOME;
	else delete process.env.FORGE_CLI_HOME;
	vi.restoreAllMocks();
});

describe("migrator — neither legacy present", () => {
	it("is a no-op but writes the marker so subsequent runs skip", () => {
		const dirs = freshDirs();
		setEnv(dirs);

		const result = migrateLegacyData({ log: () => {} });

		expect(result.ran).toBe(false);
		expect(result.moved).toEqual([]);
		expect(result.failures).toEqual([]);
		expect(result.markerWritten).toBe(true);
		expect(fs.existsSync(path.join(dirs.userRoot, ".migrated-from-legacy"))).toBe(true);
	});
});

describe("migrator — legacy-only present", () => {
	it("moves config + all cache files and writes marker", () => {
		const dirs = freshDirs();
		setEnv(dirs);

		// Seed legacy data.
		const legCfg = legacyConfigDir(dirs.home);
		const legCache = legacyCacheDir(dirs.xdg);
		fs.mkdirSync(legCfg, { recursive: true });
		fs.mkdirSync(legCache, { recursive: true });
		fs.writeFileSync(path.join(legCfg, "config.json"), '{"persona-models":{}}');
		fs.writeFileSync(path.join(legCache, "update-banner.json"), "{}");
		fs.writeFileSync(path.join(legCache, "whats-new-seen.json"), "{}");
		fs.writeFileSync(path.join(legCache, "seen.json"), "{}");
		fs.writeFileSync(path.join(legCache, "drift-seen.json"), "{}");

		const logs: string[] = [];
		const result = migrateLegacyData({ log: (l) => logs.push(l) });

		expect(result.ran).toBe(true);
		expect(result.failures).toEqual([]);
		expect(result.markerWritten).toBe(true);
		expect(result.moved).toHaveLength(5);

		// New layout
		expect(fs.existsSync(path.join(dirs.userRoot, "config.json"))).toBe(true);
		expect(fs.existsSync(path.join(dirs.userRoot, "cache", "update-banner.json"))).toBe(true);
		expect(fs.existsSync(path.join(dirs.userRoot, "cache", "whats-new-seen.json"))).toBe(true);
		expect(fs.existsSync(path.join(dirs.userRoot, "cache", "seen.json"))).toBe(true);
		expect(fs.existsSync(path.join(dirs.userRoot, "cache", "drift-seen.json"))).toBe(true);

		// Legacy files moved (not copied)
		expect(fs.existsSync(path.join(legCfg, "config.json"))).toBe(false);
		expect(fs.existsSync(path.join(legCache, "update-banner.json"))).toBe(false);

		// One log line per file moved
		expect(logs.length).toBeGreaterThanOrEqual(5);
		expect(logs.every((l) => l.includes("forge-cli migrate"))).toBe(true);
	});
});

describe("migrator — mixed (new config already exists)", () => {
	it("preserves the new-path config and still migrates legacy cache files", () => {
		const dirs = freshDirs();
		setEnv(dirs);

		// Seed legacy AND a pre-existing new-path config.
		const legCfg = legacyConfigDir(dirs.home);
		const legCache = legacyCacheDir(dirs.xdg);
		fs.mkdirSync(legCfg, { recursive: true });
		fs.mkdirSync(legCache, { recursive: true });
		fs.mkdirSync(dirs.userRoot, { recursive: true });
		fs.writeFileSync(path.join(legCfg, "config.json"), '{"legacy":true}');
		fs.writeFileSync(path.join(dirs.userRoot, "config.json"), '{"existing":true}');
		fs.writeFileSync(path.join(legCache, "update-banner.json"), "{}");

		const result = migrateLegacyData({ log: () => {} });

		// New config NOT overwritten
		expect(JSON.parse(fs.readFileSync(path.join(dirs.userRoot, "config.json"), "utf8"))).toEqual({
			existing: true,
		});
		// Legacy config left in place because no overwrite was allowed
		expect(fs.existsSync(path.join(legCfg, "config.json"))).toBe(true);
		// Cache file migrated
		expect(fs.existsSync(path.join(dirs.userRoot, "cache", "update-banner.json"))).toBe(true);
		expect(result.markerWritten).toBe(true);
	});
});

describe("migrator — partial-success retry", () => {
	it("does not write marker when a move fails; retries succeed on rerun", () => {
		const dirs = freshDirs();
		setEnv(dirs);

		const legCache = legacyCacheDir(dirs.xdg);
		fs.mkdirSync(legCache, { recursive: true });
		fs.writeFileSync(path.join(legCache, "update-banner.json"), "{}");
		fs.writeFileSync(path.join(legCache, "whats-new-seen.json"), "{}");

		// Simulate a destination-parent obstruction: create a regular file
		// at the path where mkdirSync wants to create the cache directory.
		// mkdirSync inside moveFile will throw EEXIST/ENOTDIR.
		fs.mkdirSync(dirs.userRoot, { recursive: true });
		fs.writeFileSync(path.join(dirs.userRoot, "cache"), "obstruction");

		const result1 = migrateLegacyData({ log: () => {} });
		// Both files fail because the cache *directory* could not be created.
		expect(result1.moved).toEqual([]);
		expect(result1.failures.length).toBe(2);
		expect(result1.markerWritten).toBe(false);
		expect(fs.existsSync(path.join(dirs.userRoot, ".migrated-from-legacy"))).toBe(false);

		// Repair the obstruction and rerun → both files move and the
		// marker is written.
		fs.rmSync(path.join(dirs.userRoot, "cache"));
		const result2 = migrateLegacyData({ log: () => {} });
		expect(result2.failures).toEqual([]);
		expect(result2.markerWritten).toBe(true);
		expect(fs.existsSync(path.join(dirs.userRoot, "cache", "update-banner.json"))).toBe(true);
		expect(fs.existsSync(path.join(dirs.userRoot, "cache", "whats-new-seen.json"))).toBe(true);
	});
});

describe("migrator — idempotent re-run", () => {
	it("short-circuits when the marker is present", () => {
		const dirs = freshDirs();
		setEnv(dirs);

		fs.mkdirSync(dirs.userRoot, { recursive: true });
		fs.writeFileSync(path.join(dirs.userRoot, ".migrated-from-legacy"), "marker\n");

		// Seed legacy data that *would* migrate if the marker were absent.
		const legCfg = legacyConfigDir(dirs.home);
		fs.mkdirSync(legCfg, { recursive: true });
		fs.writeFileSync(path.join(legCfg, "config.json"), '{"legacy":true}');

		const result = migrateLegacyData({ log: () => {} });

		expect(result.ran).toBe(false);
		expect(result.moved).toEqual([]);
		// Legacy data untouched
		expect(fs.existsSync(path.join(legCfg, "config.json"))).toBe(true);
		// New location unchanged
		expect(fs.existsSync(path.join(dirs.userRoot, "config.json"))).toBe(false);
	});
});
