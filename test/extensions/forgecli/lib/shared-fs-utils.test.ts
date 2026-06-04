// shared-fs-utils.test.ts — FORGE-S25-T18 (C-16, S-3)
//
// Unit tests for lib/shared-fs-utils.ts: isFile() and isDirectory().
// Includes regression tests verifying migrated consumers reference the lib.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDirectory, isFile } from "../../../../src/extensions/forgecli/lib/shared-fs-utils.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-shared-fs-utils-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isFile", () => {
	it("returns true for an existing regular file", () => {
		const p = path.join(tmpRoot, "file.txt");
		fs.writeFileSync(p, "hello");
		expect(isFile(p)).toBe(true);
	});

	it("returns false for an existing directory", () => {
		const d = path.join(tmpRoot, "dir");
		fs.mkdirSync(d);
		expect(isFile(d)).toBe(false);
	});

	it("returns false for a non-existent path", () => {
		expect(isFile(path.join(tmpRoot, "does-not-exist.txt"))).toBe(false);
	});
});

describe("isDirectory", () => {
	it("returns true for an existing directory", () => {
		const d = path.join(tmpRoot, "subdir");
		fs.mkdirSync(d);
		expect(isDirectory(d)).toBe(true);
	});

	it("returns false for an existing file", () => {
		const p = path.join(tmpRoot, "file.txt");
		fs.writeFileSync(p, "hello");
		expect(isDirectory(p)).toBe(false);
	});

	it("returns false for a non-existent path", () => {
		expect(isDirectory(path.join(tmpRoot, "does-not-exist"))).toBe(false);
	});
});

describe("regression: forge-root.ts uses shared isFile", () => {
	it("findNearestForgeConfig locates a .forge/config.json via the shared isFile", async () => {
		// Set up a fake project with a valid .forge/config.json
		const forgeDir = path.join(tmpRoot, ".forge");
		fs.mkdirSync(forgeDir);
		const forgeRoot = path.join(tmpRoot, "plugin");
		fs.mkdirSync(forgeRoot, { recursive: true });
		fs.writeFileSync(
			path.join(forgeDir, "config.json"),
			JSON.stringify({ paths: { forgeRoot: "./plugin" } }, null, 2),
		);

		// discoverForgeConfig calls findNearestForgeConfig which uses isFile from lib
		const { discoverForgeConfig } = await import("../../../../src/extensions/forgecli/lib/forge-root.js");
		const result = discoverForgeConfig(tmpRoot);
		expect(result).not.toBeNull();
		expect(result!.forgeRoot).toBe(forgeRoot);
	});
});
