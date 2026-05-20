// Unit tests for hooks/check-update module — FORGE-S23-T05.
//
// Coverage:
//   1. buildForgeAwarenessMsg — with config, missing config
//   2. syncForgeRootAndRef — matching root, root drift same dist, distribution switch
//   3. buildPendingMigrationMsg — updateStatus complete, pending with migrations, no cache
//   4. detectDistribution — skillforge path, forge path
//   5. buildMultiPluginMsg — single install (null), two installs (message)
//   6. readProjectCache — reads valid cache, returns null on missing

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildForgeAwarenessMsg,
	buildMultiPluginMsg,
	buildPendingMigrationMsg,
	detectDistribution,
	readProjectCache,
	scanPluginInstallations,
	syncForgeRootAndRef,
	type ProjectCache,
} from "../../../../src/extensions/forgecli/hooks/check-update.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
	return path.join(os.tmpdir(), `forgecli-check-update-test-${crypto.randomBytes(6).toString("hex")}`);
}

async function mkForgeDir(base: string, configExtra?: Record<string, unknown>): Promise<string> {
	const forgeDir = path.join(base, ".forge");
	await fs.mkdir(forgeDir, { recursive: true });
	const config = {
		paths: {
			forgeRoot: path.join(base, "forge", "forge"),
			forgeRef: "0.44.0",
			...((configExtra?.paths as Record<string, unknown>) ?? {}),
		},
		...configExtra,
	};
	await fs.writeFile(path.join(forgeDir, "config.json"), JSON.stringify(config, null, 2));
	return forgeDir;
}

async function writeProjectCache(forgeDir: string, cache: ProjectCache): Promise<void> {
	await fs.writeFile(path.join(forgeDir, "update-check-cache.json"), JSON.stringify(cache, null, 2));
}

async function writePluginJson(pluginRoot: string, version: string): Promise<void> {
	const pluginDir = path.join(pluginRoot, ".claude-plugin");
	await fs.mkdir(pluginDir, { recursive: true });
	await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ version }));
}

// Cleanup list for afterEach
const toClean: string[] = [];

beforeEach(() => {
	toClean.length = 0;
});

afterEach(async () => {
	for (const dir of toClean) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

// ── detectDistribution ────────────────────────────────────────────────────────

describe("detectDistribution", () => {
	it("returns 'forge@skillforge' for cache/skillforge path", () => {
		const root = "/home/user/.claude/plugins/cache/skillforge/forge/forge";
		expect(detectDistribution(root)).toBe("forge@skillforge");
	});

	it("returns 'forge@skillforge' for marketplaces/skillforge path", () => {
		const root = "/home/user/.claude/plugins/marketplaces/skillforge/forge/forge";
		expect(detectDistribution(root)).toBe("forge@skillforge");
	});

	it("returns 'forge@forge' for direct forge install", () => {
		const root = "/home/user/.claude/plugins/cache/forge/forge";
		expect(detectDistribution(root)).toBe("forge@forge");
	});

	it("returns 'forge@forge' for arbitrary path", () => {
		expect(detectDistribution("/some/random/path/forge/forge")).toBe("forge@forge");
	});
});

// ── readProjectCache ──────────────────────────────────────────────────────────

describe("readProjectCache", () => {
	it("returns null when cache file does not exist", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		await fs.mkdir(dir, { recursive: true });
		expect(readProjectCache(dir)).toBeNull();
	});

	it("reads and parses a valid cache file", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		const cache: ProjectCache = {
			localVersion: "0.44.0",
			distribution: "forge@forge",
			forgeRoot: "/some/path",
			forgeRef: "0.44.0",
			updateStatus: "complete",
			pendingMigrations: [],
		};
		await writeProjectCache(forgeDir, cache);
		const result = readProjectCache(forgeDir);
		expect(result).not.toBeNull();
		expect(result?.localVersion).toBe("0.44.0");
		expect(result?.updateStatus).toBe("complete");
	});

	it("returns null for malformed JSON", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		await fs.writeFile(path.join(forgeDir, "update-check-cache.json"), "not-json");
		expect(readProjectCache(forgeDir)).toBeNull();
	});
});

// ── buildForgeAwarenessMsg ────────────────────────────────────────────────────

describe("buildForgeAwarenessMsg", () => {
	it("returns a Forge-awareness string when config exists", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		const configPath = path.join(forgeDir, "config.json");
		const result = buildForgeAwarenessMsg(configPath);
		expect(result).not.toBeNull();
		expect(result).toContain("Forge");
		expect(result).toContain("engineering/");
		expect(result).toContain(".forge/workflows/");
	});

	it("returns null when configPath does not exist", () => {
		const result = buildForgeAwarenessMsg("/nonexistent/.forge/config.json");
		expect(result).toBeNull();
	});
});

// ── buildPendingMigrationMsg ──────────────────────────────────────────────────

describe("buildPendingMigrationMsg", () => {
	it("returns null when no project cache exists", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		const configPath = path.join(forgeDir, "config.json");
		expect(buildPendingMigrationMsg(configPath)).toBeNull();
	});

	it("returns null when updateStatus is 'complete'", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		await writeProjectCache(forgeDir, {
			updateStatus: "complete",
			pendingMigrations: [],
		});
		const configPath = path.join(forgeDir, "config.json");
		expect(buildPendingMigrationMsg(configPath)).toBeNull();
	});

	it("returns warning message when updateStatus is 'pending'", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		await writeProjectCache(forgeDir, {
			updateStatus: "pending",
			pendingMigrations: ["workflows:plan_task", "schemas:task"],
		});
		const configPath = path.join(forgeDir, "config.json");
		const result = buildPendingMigrationMsg(configPath);
		expect(result).not.toBeNull();
		expect(result).toContain("pending migration");
		expect(result).toContain("workflows:plan_task");
		expect(result).toContain("schemas:task");
		expect(result).toContain("/forge:update");
	});

	it("handles pending state with no pendingMigrations array", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		await writeProjectCache(forgeDir, {
			updateStatus: "pending",
		});
		const configPath = path.join(forgeDir, "config.json");
		const result = buildPendingMigrationMsg(configPath);
		expect(result).not.toBeNull();
		expect(result).toContain("(unknown)");
	});
});

// ── syncForgeRootAndRef ───────────────────────────────────────────────────────

describe("syncForgeRootAndRef", () => {
	it("returns null when forgeRoot matches stored root (no drift)", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		const forgeRoot = path.join(dir, "forge", "forge");
		await writePluginJson(forgeRoot, "0.44.0");
		await writeProjectCache(forgeDir, {
			forgeRoot,
			distribution: detectDistribution(forgeRoot),
			forgeRef: "0.44.0",
		});
		const configPath = path.join(forgeDir, "config.json");
		const result = syncForgeRootAndRef({ forgeRoot, configPath });
		expect(result).toBeNull();
	});

	it("updates config.json when forgeRoot drifts (same distribution, no message)", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		const oldRoot = "/old/path/forge/forge";
		const newRoot = path.join(dir, "forge", "forge");
		await writePluginJson(newRoot, "0.44.1");
		// Cache shows old root
		await writeProjectCache(forgeDir, {
			forgeRoot: oldRoot,
			distribution: "forge@forge", // same distribution
			forgeRef: "0.44.0",
		});
		const configPath = path.join(forgeDir, "config.json");
		const result = syncForgeRootAndRef({ forgeRoot: newRoot, configPath });
		// Same distribution — no switch message
		expect(result).toBeNull();
		// Config should be updated
		const updatedCfg = JSON.parse(await fs.readFile(configPath, "utf8")) as {
			paths: { forgeRoot: string; forgeRef: string };
		};
		expect(updatedCfg.paths.forgeRoot).toBe(newRoot);
		expect(updatedCfg.paths.forgeRef).toBe("0.44.1");
	});

	it("returns switch message when distribution changes", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		// Old: skillforge distribution
		const oldRoot = "/home/user/.claude/plugins/cache/skillforge/forge/forge";
		// New: direct forge distribution
		const newRoot = path.join(dir, "forge", "forge");
		await writePluginJson(newRoot, "0.44.2");
		await writeProjectCache(forgeDir, {
			forgeRoot: oldRoot,
			distribution: "forge@skillforge",
			localVersion: "0.44.0",
			forgeRef: "0.44.0",
		});
		const configPath = path.join(forgeDir, "config.json");
		const result = syncForgeRootAndRef({ forgeRoot: newRoot, configPath });
		expect(result).not.toBeNull();
		expect(result).toContain("forge@skillforge");
		expect(result).toContain("forge@forge");
		expect(result).toContain("paths.forgeRoot updated");
	});

	it("returns null when no project cache exists", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const forgeDir = await mkForgeDir(dir);
		const forgeRoot = path.join(dir, "forge", "forge");
		await writePluginJson(forgeRoot, "0.44.0");
		const configPath = path.join(forgeDir, "config.json");
		// No cache file written
		const result = syncForgeRootAndRef({ forgeRoot, configPath });
		expect(result).toBeNull();
	});
});

// ── buildMultiPluginMsg ───────────────────────────────────────────────────────

describe("buildMultiPluginMsg", () => {
	it("returns null when only one or zero installations found", () => {
		// No real plugin dirs in tmp — scan returns empty array
		const dir = tmpDir();
		toClean.push(dir);
		const forgeRoot = path.join(dir, "forge", "forge");
		const configPath = path.join(dir, ".forge", "config.json");
		// Use an isolated homeDir/cwd so no real installs are found
		const result = buildMultiPluginMsg({
			forgeRoot,
			configPath,
			homeDir: path.join(dir, "fake-home"),
			cwd: path.join(dir, "fake-cwd"),
		});
		expect(result).toBeNull();
	});

	it("returns informational message when two installations found", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		// Fake homeDir with two plugin installs
		const homeDir = path.join(dir, "home");
		const pluginsBase = path.join(homeDir, ".claude", "plugins");

		// Install 1: forge/forge at cache/forge/forge
		const install1 = path.join(pluginsBase, "cache", "forge", "forge");
		await fs.mkdir(path.join(install1, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(install1, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.44.0" }));

		// Install 2: skillforge at cache/skillforge/forge/forge
		const install2 = path.join(pluginsBase, "cache", "skillforge", "forge", "forge");
		await fs.mkdir(path.join(install2, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(install2, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.43.0" }));

		const forgeRoot = install1;
		const configPath = path.join(dir, ".forge", "config.json");

		const result = buildMultiPluginMsg({
			forgeRoot,
			configPath,
			homeDir,
			cwd: path.join(dir, "fake-cwd"),
		});

		expect(result).not.toBeNull();
		expect(result).toContain("also installed");
		// Should mention the non-active install
		expect(result).toContain("0.43.0");
	});
});

// ── scanPluginInstallations ───────────────────────────────────────────────────

describe("scanPluginInstallations", () => {
	it("returns empty array when no plugin dirs exist", () => {
		const result = scanPluginInstallations({
			homeDir: "/nonexistent/home",
			cwd: "/nonexistent/cwd",
		});
		expect(result).toEqual([]);
	});

	it("returns one record when a valid plugin.json is found", async () => {
		const dir = tmpDir();
		toClean.push(dir);
		const homeDir = dir;
		const pluginRoot = path.join(homeDir, ".claude", "plugins", "cache", "forge", "forge");
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.44.0" }));

		const result = scanPluginInstallations({ homeDir, cwd: "/nonexistent/cwd" });
		expect(result).toHaveLength(1);
		expect(result[0]?.version).toBe("0.44.0");
		expect(result[0]?.distribution).toBe("forge@forge");
		expect(result[0]?.scope).toBe("user");
	});
});
