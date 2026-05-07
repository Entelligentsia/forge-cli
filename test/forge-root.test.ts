// Unit tests for `discoverForgeRoot` (FORGE-S15-T03).
//
// Branches covered:
//   1. cwd contains `.forge/config.json` directly                → absolute path
//   2. ancestor contains `.forge/config.json`, relative forgeRoot → resolved
//      against the config dir (NOT cwd)
//   3. no config anywhere up to filesystem root                  → null
//   4. malformed JSON in config                                  → null
//   5. config missing paths.forgeRoot                            → null

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverForgeRoot } from "../src/extensions/forgecli/forge-root.js";

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

describe("discoverForgeRoot", () => {
	it("returns absolute forgeRoot when cwd has .forge/config.json", () => {
		const project = path.join(tmpRoot, "proj");
		fs.mkdirSync(project, { recursive: true });
		const forgePluginDir = path.join(project, "forge", "forge");
		fs.mkdirSync(forgePluginDir, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }));

		const result = discoverForgeRoot(project);
		expect(result).toBe(path.resolve(project, "forge", "forge"));
	});

	it("walks up from a deep cwd and resolves relative forgeRoot against config dir", () => {
		const project = path.join(tmpRoot, "proj2");
		const deep = path.join(project, "a", "b", "c");
		fs.mkdirSync(deep, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }));

		const result = discoverForgeRoot(deep);
		expect(result).toBe(path.resolve(project, "forge", "forge"));
	});

	it("returns null when no .forge/config.json exists up to filesystem root", () => {
		const orphan = path.join(tmpRoot, "no-forge-here");
		fs.mkdirSync(orphan, { recursive: true });
		// tmpRoot has no .forge config; walk-up will hit FS root harmlessly.
		const result = discoverForgeRoot(orphan);
		expect(result).toBeNull();
	});

	it("returns null when config.json is malformed JSON", () => {
		const project = path.join(tmpRoot, "proj3");
		fs.mkdirSync(project, { recursive: true });
		writeConfig(project, "{ this is not valid json");

		const result = discoverForgeRoot(project);
		expect(result).toBeNull();
	});

	it("returns null when config.json lacks paths.forgeRoot", () => {
		const project = path.join(tmpRoot, "proj4");
		fs.mkdirSync(project, { recursive: true });
		writeConfig(project, JSON.stringify({ paths: {} }));

		const result = discoverForgeRoot(project);
		expect(result).toBeNull();
	});

	it("preserves an absolute forgeRoot value as-is", () => {
		const project = path.join(tmpRoot, "proj5");
		fs.mkdirSync(project, { recursive: true });
		const absForgeRoot = path.join(tmpRoot, "elsewhere", "forge");
		writeConfig(project, JSON.stringify({ paths: { forgeRoot: absForgeRoot } }));

		const result = discoverForgeRoot(project);
		expect(result).toBe(absForgeRoot);
	});
});
