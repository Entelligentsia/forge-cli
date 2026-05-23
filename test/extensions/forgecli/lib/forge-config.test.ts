// forge-config.test.ts — FORGE-S25-T18 (C-3, S-13)
//
// Unit tests for lib/forge-config.ts: discoverForgeConfigCached() and clearForgeConfigCache().

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearForgeConfigCache,
	discoverForgeConfigCached,
} from "../../../../src/extensions/forgecli/lib/forge-config.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-forge-config-"));
	clearForgeConfigCache();
});

afterEach(() => {
	clearForgeConfigCache();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function setupForgeProject(dir: string): void {
	const forgeDir = path.join(dir, ".forge");
	fs.mkdirSync(forgeDir, { recursive: true });
	const pluginDir = path.join(dir, "plugin");
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.writeFileSync(
		path.join(forgeDir, "config.json"),
		JSON.stringify({ paths: { forgeRoot: "./plugin" } }, null, 2),
	);
}

describe("discoverForgeConfigCached", () => {
	it("returns null for a directory with no .forge/config.json", () => {
		const emptyDir = path.join(tmpRoot, "empty");
		fs.mkdirSync(emptyDir);
		const result = discoverForgeConfigCached(emptyDir);
		expect(result).toBeNull();
	});

	it("returns a ForgeConfig for a valid project", () => {
		setupForgeProject(tmpRoot);
		const result = discoverForgeConfigCached(tmpRoot);
		expect(result).not.toBeNull();
		expect(result!.configPath).toContain(".forge");
		expect(result!.forgeRoot).toContain("plugin");
	});

	it("returns the same reference on second call (cache hit)", () => {
		setupForgeProject(tmpRoot);
		const first = discoverForgeConfigCached(tmpRoot);
		const second = discoverForgeConfigCached(tmpRoot);
		expect(first).toBe(second);
	});

	it("returns independent results for different cwd keys", () => {
		setupForgeProject(tmpRoot);
		// Use a sibling tmpdir (not a subdirectory of tmpRoot) so the walk-up
		// does not find tmpRoot's .forge/config.json.
		const separateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-forge-config-sep-"));
		try {
			const result1 = discoverForgeConfigCached(tmpRoot);
			const result2 = discoverForgeConfigCached(separateDir);
			expect(result1).not.toBeNull();
			expect(result2).toBeNull();
		} finally {
			fs.rmSync(separateDir, { recursive: true, force: true });
		}
	});

	it("matches the result of the uncached discoverForgeConfig", async () => {
		setupForgeProject(tmpRoot);
		const { discoverForgeConfig } = await import(
			"../../../../src/extensions/forgecli/forge-root.js"
		);
		const cached = discoverForgeConfigCached(tmpRoot);
		const uncached = discoverForgeConfig(tmpRoot);
		expect(cached).toEqual(uncached);
	});
});

describe("clearForgeConfigCache", () => {
	it("invalidates all cached entries", () => {
		setupForgeProject(tmpRoot);
		const first = discoverForgeConfigCached(tmpRoot);
		clearForgeConfigCache();

		// After clearing, the cache is empty — new call re-discovers
		const second = discoverForgeConfigCached(tmpRoot);
		// Both are non-null and structurally equal, but they are new references
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(first).toEqual(second);
		// After clear the second call must have re-run discovery (they are distinct objects)
		expect(first).not.toBe(second);
	});
});
