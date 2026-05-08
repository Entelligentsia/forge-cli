// Unit tests for readProjectMeta (FORGE-S16-T02, Phase 3).
//
// Branches covered:
//   1. Valid config with name + prefix → { name, prefix }
//   2. Config missing project key → null
//   3. Config missing project.name → null
//   4. Config missing project.prefix → null
//   5. Non-existent file → null (no throw)
//   6. Malformed JSON → null (no throw)
//   7. Empty name → null
//   8. Empty prefix → null

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readProjectMeta } from "../../../src/extensions/forgecli/banner.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-banner-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(body: string): string {
	const configPath = path.join(tmpDir, "config.json");
	fs.writeFileSync(configPath, body, "utf8");
	return configPath;
}

describe("readProjectMeta", () => {
	it("valid config returns { name, prefix }", () => {
		const configPath = writeConfig(
			JSON.stringify({ project: { name: "Forge Engineering", prefix: "FORGE" } }),
		);
		const result = readProjectMeta(configPath);
		expect(result).toEqual({ name: "Forge Engineering", prefix: "FORGE" });
	});

	it("config missing project key → null", () => {
		const configPath = writeConfig(JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }));
		const result = readProjectMeta(configPath);
		expect(result).toBeNull();
	});

	it("config with project but missing name → null", () => {
		const configPath = writeConfig(JSON.stringify({ project: { prefix: "FORGE" } }));
		const result = readProjectMeta(configPath);
		expect(result).toBeNull();
	});

	it("config with project but missing prefix → null", () => {
		const configPath = writeConfig(JSON.stringify({ project: { name: "Forge Engineering" } }));
		const result = readProjectMeta(configPath);
		expect(result).toBeNull();
	});

	it("non-existent file → null (no throw)", () => {
		const result = readProjectMeta(path.join(tmpDir, "does-not-exist.json"));
		expect(result).toBeNull();
	});

	it("malformed JSON → null (no throw)", () => {
		const configPath = writeConfig("{ this is not json");
		const result = readProjectMeta(configPath);
		expect(result).toBeNull();
	});

	it("empty name string → null", () => {
		const configPath = writeConfig(JSON.stringify({ project: { name: "", prefix: "FORGE" } }));
		const result = readProjectMeta(configPath);
		expect(result).toBeNull();
	});

	it("empty prefix string → null", () => {
		const configPath = writeConfig(JSON.stringify({ project: { name: "Forge Engineering", prefix: "" } }));
		const result = readProjectMeta(configPath);
		expect(result).toBeNull();
	});

	it("non-string name → null", () => {
		const configPath = writeConfig(JSON.stringify({ project: { name: 42, prefix: "FORGE" } }));
		const result = readProjectMeta(configPath);
		expect(result).toBeNull();
	});
});
