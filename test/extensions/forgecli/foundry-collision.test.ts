// Unit tests for foundry-collision module (FORGE-S16-T02, Phase 3).
//
// Branches covered:
//   1. detectFoundryCollision returns { collides, colliderPath } shape
//   2. wasCollisionSeen("nonexistent") returns false (no seen.json)
//   3. markCollisionSeen + wasCollisionSeen round-trip in tmp dir
//   4. wasCollisionSeen returns false after markCollisionSeen for different path
//   5. Multiple paths can be independently tracked

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	detectFoundryCollision,
	markCollisionSeen,
	wasCollisionSeen,
} from "../../../src/extensions/forgecli/foundry-collision.js";

let tmpDir: string;
let userRoot: string;
let origForgeCliHome: string | undefined;
let origSkipMig: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-collision-"));
	// Post-FORGE-S20-T11 (v0.10.0): seen.json now lives under the
	// forge-cli user root at $FORGE_CLI_HOME/cache/seen.json (resolved
	// via the central path resolver). Scope via FORGE_CLI_HOME.
	userRoot = path.join(tmpDir, "forge-cli-user");
	fs.mkdirSync(userRoot, { recursive: true });
	origForgeCliHome = process.env.FORGE_CLI_HOME;
	origSkipMig = process.env.FORGE_CLI_SKIP_MIGRATION;
	process.env.FORGE_CLI_HOME = userRoot;
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";
});

afterEach(() => {
	if (origForgeCliHome !== undefined) process.env.FORGE_CLI_HOME = origForgeCliHome;
	else delete process.env.FORGE_CLI_HOME;
	if (origSkipMig !== undefined) process.env.FORGE_CLI_SKIP_MIGRATION = origSkipMig;
	else delete process.env.FORGE_CLI_SKIP_MIGRATION;
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("detectFoundryCollision", () => {
	it("returns a result with the correct shape", () => {
		const result = detectFoundryCollision();
		expect(result).toHaveProperty("collides");
		expect(result).toHaveProperty("colliderPath");
		expect(typeof result.collides).toBe("boolean");
		// colliderPath is either null or a string
		expect(result.colliderPath === null || typeof result.colliderPath === "string").toBe(true);
	});

	it("returns colliderPath as null when collides is false", () => {
		const result = detectFoundryCollision();
		if (!result.collides) {
			expect(result.colliderPath).toBeNull();
		}
	});
});

describe("wasCollisionSeen", () => {
	it("returns false for an unseen path when no seen.json exists", () => {
		const result = wasCollisionSeen("/usr/local/bin/forge");
		expect(result).toBe(false);
	});

	it("returns false for a path not in seen.json", () => {
		// Write a seen.json with a different path
		const cacheDir = path.join(userRoot, "cache");
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(
			path.join(cacheDir, "seen.json"),
			JSON.stringify({ collisions: { "/other/path/forge": true } }),
			"utf8",
		);
		const result = wasCollisionSeen("/usr/local/bin/forge");
		expect(result).toBe(false);
	});

	it("returns false on malformed seen.json", () => {
		const cacheDir = path.join(userRoot, "cache");
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, "seen.json"), "{ not valid json", "utf8");
		const result = wasCollisionSeen("/usr/local/bin/forge");
		expect(result).toBe(false);
	});
});

describe("markCollisionSeen + wasCollisionSeen", () => {
	it("round-trips: mark then check returns true", () => {
		const colliderPath = "/usr/local/bin/forge";
		expect(wasCollisionSeen(colliderPath)).toBe(false);
		markCollisionSeen(colliderPath);
		expect(wasCollisionSeen(colliderPath)).toBe(true);
	});

	it("does not affect other paths", () => {
		const path1 = "/usr/local/bin/forge";
		const path2 = "/opt/homebrew/bin/forge";
		markCollisionSeen(path1);
		expect(wasCollisionSeen(path1)).toBe(true);
		expect(wasCollisionSeen(path2)).toBe(false);
	});

	it("multiple paths can be independently tracked", () => {
		const paths = ["/usr/bin/forge", "/usr/local/bin/forge", "/opt/forge"];
		for (const p of paths) {
			markCollisionSeen(p);
		}
		for (const p of paths) {
			expect(wasCollisionSeen(p)).toBe(true);
		}
	});

	it("seen.json is written to ~/.pi/forge-cli/cache/seen.json (v0.10.0 layout)", () => {
		const colliderPath = "/usr/local/bin/forge";
		markCollisionSeen(colliderPath);
		const seenPath = path.join(userRoot, "cache", "seen.json");
		expect(fs.existsSync(seenPath)).toBe(true);
		const content = JSON.parse(fs.readFileSync(seenPath, "utf8")) as { collisions: Record<string, boolean> };
		expect(content.collisions[colliderPath]).toBe(true);
	});
});
