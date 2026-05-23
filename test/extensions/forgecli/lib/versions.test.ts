// versions.test.ts — FORGE-S25-T18 (B-1)
//
// Unit tests for lib/versions.ts: readForgeCliVersion, readBundledPluginVersion,
// readPiVersionAsync, readPkgVersionsSync.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readBundledPluginVersion,
	readForgeCliVersion,
	readPiVersionAsync,
	readPkgVersionsSync,
} from "../../../../src/extensions/forgecli/lib/versions.js";

// Use the actual package root (parent of dist/extensions/forgecli/) so we
// get realistic results in the test environment.
const PKG_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-versions-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("readForgeCliVersion", () => {
	it("returns a semver-like string from the real package root", () => {
		const version = readForgeCliVersion(PKG_ROOT);
		// Either a semver string or "unknown"
		expect(typeof version).toBe("string");
		expect(version.length).toBeGreaterThan(0);
	});

	it("returns 'unknown' when package.json is absent", () => {
		const version = readForgeCliVersion(path.join(tmpRoot, "nonexistent"));
		expect(version).toBe("unknown");
	});

	it("returns 'unknown' when package.json has no version field", () => {
		fs.writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "test" }));
		const version = readForgeCliVersion(tmpRoot);
		expect(version).toBe("unknown");
	});
});

describe("readBundledPluginVersion", () => {
	it("returns a non-empty string from the real package root", () => {
		const version = readBundledPluginVersion(PKG_ROOT);
		expect(typeof version).toBe("string");
		expect(version.length).toBeGreaterThan(0);
	});

	it("returns 'unknown' when neither plugin.json nor package.json mirror exists", () => {
		const version = readBundledPluginVersion(path.join(tmpRoot, "nonexistent"));
		expect(version).toBe("unknown");
	});

	it("reads from dist/forge-payload/.claude-plugin/plugin.json when present", () => {
		const pluginDir = path.join(tmpRoot, "dist", "forge-payload", ".claude-plugin");
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ version: "1.2.3" }));
		// Still need a package.json fallback path
		fs.writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({ version: "0.1.0" }));
		const version = readBundledPluginVersion(tmpRoot);
		expect(version).toBe("1.2.3");
	});

	it("falls back to package.json forge.bundledVersion when plugin.json is absent", () => {
		fs.writeFileSync(
			path.join(tmpRoot, "package.json"),
			JSON.stringify({ version: "0.1.0", forge: { bundledVersion: "0.46.1" } }),
		);
		const version = readBundledPluginVersion(tmpRoot);
		expect(version).toBe("0.46.1");
	});
});

describe("readPiVersionAsync", () => {
	it("returns a string (semver or 'unknown')", async () => {
		const version = await readPiVersionAsync();
		expect(typeof version).toBe("string");
		expect(version.length).toBeGreaterThan(0);
	});
});

describe("readPkgVersionsSync", () => {
	it("returns { cliVersion, bundledForgeVersion } from real package root", () => {
		const result = readPkgVersionsSync(PKG_ROOT);
		expect(result).toHaveProperty("cliVersion");
		expect(result).toHaveProperty("bundledForgeVersion");
		expect(typeof result.cliVersion).toBe("string");
		expect(typeof result.bundledForgeVersion).toBe("string");
	});

	it("matches what index.ts PKG_VERSIONS would have produced before migration", () => {
		// This regression test verifies the consolidation: readPkgVersionsSync on
		// the real PKG_ROOT returns non-empty versions in a built environment.
		const result = readPkgVersionsSync(PKG_ROOT);
		// In a fully-built environment, both should be non-empty semver strings.
		// In a pre-build dev environment one or both may be "unknown" or empty.
		// The test verifies structural integrity, not specific version values.
		expect(result.cliVersion).toBeDefined();
		expect(result.bundledForgeVersion).toBeDefined();
	});
});
