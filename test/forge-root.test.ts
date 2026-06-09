// Unit tests for `discoverForgeConfig` (FORGE-S25-T05 — retargeted from the
// deleted `discoverForgeRoot` wrapper to the live implementation).
//
// Branches covered (1:1 mapping from the prior `discoverForgeRoot` suite —
// the shape changes from `string | null` to `{ forgeRoot, configPath } | null`,
// semantics are preserved):
//   1. cwd contains `.forge/config.json` directly                → result.forgeRoot is absolute
//   2. ancestor contains `.forge/config.json`, relative forgeRoot → resolved
//      against the config dir (NOT cwd); configPath ends with `.forge/config.json`
//   3. no config anywhere up to filesystem root                  → null
//   4. malformed JSON in config                                  → null
//   5. config missing paths.forgeRoot                            → null
//   6. config with an absolute forgeRoot                         → preserved as-is

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBundledPayloadRoot } from "../src/extensions/forgecli/lib/catalog-loader.js";
import { discoverForgeConfig } from "../src/extensions/forgecli/lib/forge-root.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-root-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfig(dir: string, body: string): void {
	const forgeDir = path.join(dir, ".forge");
	fs.mkdirSync(forgeDir, { recursive: true });
	fs.writeFileSync(path.join(forgeDir, "config.json"), body, "utf8");
}

describe("discoverForgeConfig", () => {
	it("returns absolute forgeRoot when cwd has .forge/config.json", () => {
		const project = path.join(tmpRoot, "proj");
		fs.mkdirSync(project, { recursive: true });
		const forgePluginDir = path.join(project, "forge", "forge");
		fs.mkdirSync(forgePluginDir, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }));

		const result = discoverForgeConfig(project);
		expect(result).not.toBeNull();
		expect(result?.forgeRoot).toBe(path.resolve(project, "forge", "forge"));
	});

	it("walks up from a deep cwd and resolves relative forgeRoot against config dir", () => {
		const project = path.join(tmpRoot, "proj2");
		const deep = path.join(project, "a", "b", "c");
		fs.mkdirSync(deep, { recursive: true });
		fs.mkdirSync(path.join(project, "forge", "forge"), { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }));

		const result = discoverForgeConfig(deep);
		expect(result).not.toBeNull();
		expect(result?.forgeRoot).toBe(path.resolve(project, "forge", "forge"));
		expect(result?.configPath.endsWith(path.join(".forge", "config.json"))).toBe(true);
	});

	it("returns null when no .forge/config.json exists up to filesystem root", () => {
		const orphan = path.join(tmpRoot, "no-forge-here");
		fs.mkdirSync(orphan, { recursive: true });
		// tmpRoot has no .forge config; walk-up will hit FS root harmlessly.
		const result = discoverForgeConfig(orphan);
		expect(result).toBeNull();
	});

	it("returns null when config.json is malformed JSON", () => {
		const project = path.join(tmpRoot, "proj3");
		fs.mkdirSync(project, { recursive: true });
		writeConfig(project, "{ this is not valid json");

		const result = discoverForgeConfig(project);
		expect(result).toBeNull();
	});

	it("returns null when config.json lacks paths.forgeRoot", () => {
		const project = path.join(tmpRoot, "proj4");
		fs.mkdirSync(project, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: {} }));

		const result = discoverForgeConfig(project);
		expect(result).toBeNull();
	});

	it("preserves an absolute forgeRoot value as-is when it is inside the project tree", () => {
		const project = path.join(tmpRoot, "proj5");
		fs.mkdirSync(project, { recursive: true });
		// Absolute path that still resolves inside the project — trusted.
		const absForgeRoot = path.join(project, "vendor", "forge");
		fs.mkdirSync(absForgeRoot, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: absForgeRoot } }));

		const result = discoverForgeConfig(project);
		expect(result).not.toBeNull();
		expect(result?.forgeRoot).toBe(absForgeRoot);
		expect(result?.rejectedFrom).toBeUndefined();
	});
});

describe("discoverForgeConfig — forgeRoot containment (clone-and-run RCE guard, issue #43)", () => {
	afterEach(() => {
		delete process.env.FORGE_ALLOW_EXTERNAL_ROOT;
		delete process.env.CLAUDE_PLUGIN_ROOT;
	});

	it("honours a forgeRoot inside the Claude plugin cache (installed-user / dogfood case)", () => {
		// `forge init` stamps a forgeRoot under the Claude plugin cache, which is
		// outside both the project and the bundled payload but is a trusted
		// install location. Exercised via CLAUDE_PLUGIN_ROOT (a real trusted root)
		// so the test does not depend on the host's home directory.
		const project = path.join(tmpRoot, "installed");
		fs.mkdirSync(project, { recursive: true });
		const cache = path.join(tmpRoot, "plugin-cache", "forge", "forge", "1.4.6");
		fs.mkdirSync(cache, { recursive: true });
		process.env.CLAUDE_PLUGIN_ROOT = path.join(tmpRoot, "plugin-cache");
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: cache } }));

		const result = discoverForgeConfig(project);
		expect(result?.forgeRoot).toBe(cache);
		expect(result?.rejectedFrom).toBeUndefined();
	});

	it("rejects an existing absolute forgeRoot outside the project and heals to the bundled payload", () => {
		const project = path.join(tmpRoot, "evil-abs");
		fs.mkdirSync(project, { recursive: true });
		// Attacker-controlled directory outside the project, but it exists
		// (so the dangling-path heal does NOT catch it).
		const evil = path.join(tmpRoot, "attacker", "tools-host");
		fs.mkdirSync(evil, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: evil } }));

		const result = discoverForgeConfig(project);
		expect(result).not.toBeNull();
		expect(result?.forgeRoot).toBe(resolveBundledPayloadRoot());
		expect(result?.rejectedFrom).toBe(evil);
	});

	it("rejects a `..`-escape that resolves outside the project tree", () => {
		const project = path.join(tmpRoot, "escape", "proj");
		fs.mkdirSync(project, { recursive: true });
		// Sibling of the project, reached via traversal; exists on disk.
		const sibling = path.join(tmpRoot, "escape", "outside");
		fs.mkdirSync(sibling, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "../outside" } }));

		const result = discoverForgeConfig(project);
		expect(result).not.toBeNull();
		expect(result?.forgeRoot).toBe(resolveBundledPayloadRoot());
		expect(result?.rejectedFrom).toBe(sibling);
	});

	it("honours an in-project forgeRoot (dogfood layout) without rejection", () => {
		const project = path.join(tmpRoot, "dogfood");
		const real = path.join(project, "forge", "forge");
		fs.mkdirSync(real, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }));

		const result = discoverForgeConfig(project);
		expect(result?.forgeRoot).toBe(real);
		expect(result?.rejectedFrom).toBeUndefined();
	});

	it("FORGE_ALLOW_EXTERNAL_ROOT=1 opts out and preserves an out-of-tree forgeRoot", () => {
		process.env.FORGE_ALLOW_EXTERNAL_ROOT = "1";
		const project = path.join(tmpRoot, "optout");
		fs.mkdirSync(project, { recursive: true });
		const external = path.join(tmpRoot, "external", "checkout");
		fs.mkdirSync(external, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: external } }));

		const result = discoverForgeConfig(project);
		expect(result?.forgeRoot).toBe(external);
		expect(result?.rejectedFrom).toBeUndefined();
	});
});

describe("discoverForgeConfig — forgeRoot self-heal (testbench clone-portability)", () => {
	// A tracked .forge/config.json may carry a forgeRoot stamped on another
	// machine (global npm prefix, Claude plugin cache). On a fresh clone that
	// path does not exist — without healing, forge_store spawns tools from a
	// dangling directory and every Forge command breaks. When the configured
	// path is missing, resolution falls back to THIS forgecli's bundled
	// payload (which always exists in an installed/built package).
	it("falls back to the bundled payload when an absolute forgeRoot does not exist", () => {
		const project = path.join(tmpRoot, "heal1");
		fs.mkdirSync(project, { recursive: true });
		writeConfig(
			project,
			JSON.stringify({ paths: { forgeRoot: "/home/some-other-user/.nvm/lib/node_modules/@entelligentsia/forgecli/dist/forge-payload" } }),
		);

		const result = discoverForgeConfig(project);
		expect(result).not.toBeNull();
		expect(result?.forgeRoot).toBe(resolveBundledPayloadRoot());
		expect(result?.healedFrom).toBe(
			"/home/some-other-user/.nvm/lib/node_modules/@entelligentsia/forgecli/dist/forge-payload",
		);
	});

	it("falls back to the bundled payload when a relative forgeRoot does not exist", () => {
		const project = path.join(tmpRoot, "heal2");
		fs.mkdirSync(project, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "./does/not/exist" } }));

		const result = discoverForgeConfig(project);
		expect(result).not.toBeNull();
		expect(result?.forgeRoot).toBe(resolveBundledPayloadRoot());
		expect(result?.healedFrom).toBe(path.resolve(project, "does", "not", "exist"));
	});

	it("does NOT heal when the configured forgeRoot exists", () => {
		const project = path.join(tmpRoot, "heal3");
		const real = path.join(project, "forge", "forge");
		fs.mkdirSync(real, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }));

		const result = discoverForgeConfig(project);
		expect(result?.forgeRoot).toBe(real);
		expect(result?.healedFrom).toBeUndefined();
	});
});
