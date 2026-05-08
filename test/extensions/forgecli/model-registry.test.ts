// Tests for the curated provider/model registry — FORGE-S16-T16.

import * as crypto from "node:crypto";
import { promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__test__,
	type CuratedRegistry,
	detectMissingCredentials,
	loadRegistry,
	seedEnabledModels,
} from "../../../src/extensions/forgecli/model-registry.js";

function freshTmp(prefix: string): string {
	return path.join(os.tmpdir(), `forgecli-${prefix}-${crypto.randomBytes(6).toString("hex")}`);
}

const VALID_REGISTRY: CuratedRegistry = {
	version: 1,
	providers: [
		{
			id: "anthropic-pro-max",
			label: "Anthropic Pro/Max plan",
			enabled: false,
			deferredTo: "S17",
			modelGlobs: [],
			credentialEnvAny: [],
		},
		{
			id: "anthropic-api",
			label: "Anthropic API",
			enabled: true,
			modelGlobs: ["claude-*"],
			credentialEnvAny: ["ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID"],
		},
		{
			id: "openai",
			label: "OpenAI",
			enabled: true,
			modelGlobs: ["gpt-4o*", "o3*"],
			credentialEnvAny: ["OPENAI_API_KEY"],
		},
		{
			id: "ollama",
			label: "Ollama",
			enabled: true,
			modelGlobs: ["ollama/*"],
			credentialEnvAny: [],
		},
	],
};

async function writeJson(p: string, data: unknown): Promise<void> {
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

describe("loadRegistry", () => {
	it("loads the bundled registry by default", () => {
		const reg = loadRegistry({ env: {} });
		expect(reg.version).toBe(1);
		expect(reg.providers.length).toBe(6);
		const ids = reg.providers.map((p) => p.id).sort();
		expect(ids).toEqual(["anthropic-api", "anthropic-pro-max", "gemini", "ollama", "openai", "openrouter"]);
	});

	it("uses FORGE_MODEL_REGISTRY env override", async () => {
		const dir = freshTmp("registry-env");
		const file = path.join(dir, "custom.json");
		await writeJson(file, VALID_REGISTRY);
		try {
			const reg = loadRegistry({ env: { FORGE_MODEL_REGISTRY: file } });
			expect(reg.providers.map((p) => p.id)).toContain("ollama");
			expect(reg.providers.length).toBe(4);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("explicit registryPath beats FORGE_MODEL_REGISTRY env", async () => {
		const dir = freshTmp("registry-explicit");
		const winning = path.join(dir, "winning.json");
		const losing = path.join(dir, "losing.json");
		await writeJson(winning, VALID_REGISTRY);
		await writeJson(losing, { version: 1, providers: [{ ...VALID_REGISTRY.providers[1]!, id: "should-not-load" }] });
		try {
			const reg = loadRegistry({ registryPath: winning, env: { FORGE_MODEL_REGISTRY: losing } });
			expect(reg.providers.map((p) => p.id)).toContain("anthropic-api");
			expect(reg.providers.map((p) => p.id)).not.toContain("should-not-load");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects malformed registry (missing providers)", async () => {
		const dir = freshTmp("registry-bad");
		const file = path.join(dir, "bad.json");
		await writeJson(file, { version: 1 });
		try {
			expect(() => loadRegistry({ registryPath: file, env: {} })).toThrow(/Invalid model registry/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects wrong type (version: 2)", async () => {
		const dir = freshTmp("registry-wrong-version");
		const file = path.join(dir, "bad.json");
		await writeJson(file, { version: 2, providers: VALID_REGISTRY.providers });
		try {
			expect(() => loadRegistry({ registryPath: file, env: {} })).toThrow(/Invalid model registry/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("seedEnabledModels", () => {
	let projectRoot: string;
	beforeEach(async () => {
		projectRoot = freshTmp("seed");
		await fs.mkdir(projectRoot, { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	it("first run seeds project-scope pi-settings.json", async () => {
		const out = await seedEnabledModels({ projectRoot, registry: VALID_REGISTRY, now: () => 12345 });
		expect(out.seeded).toBe(true);
		expect(out.path).toBe(path.join(projectRoot, ".forge", "pi-settings.json"));
		const written = JSON.parse(await fs.readFile(out.path, "utf8")) as Record<string, unknown>;
		expect(written.schemaVersion).toBe(1);
		expect(written.seededAt).toBe(12345);
		expect(written.enabledModels).toEqual(["claude-*", "gpt-4o*", "o3*", "ollama/*"]);
		expect(written.defaultModelGlob).toBe("claude-*");
	});

	it("second run is idempotent — file unchanged", async () => {
		const first = await seedEnabledModels({ projectRoot, registry: VALID_REGISTRY, now: () => 1 });
		expect(first.seeded).toBe(true);
		const before = await fs.readFile(first.path, "utf8");
		const second = await seedEnabledModels({ projectRoot, registry: VALID_REGISTRY, now: () => 999_999 });
		expect(second.seeded).toBe(false);
		const after = await fs.readFile(first.path, "utf8");
		expect(after).toBe(before);
	});

	it("never writes to ~/.pi/agent/settings.json", async () => {
		const homeFile = path.join(os.homedir(), ".pi", "agent", "settings.json");
		const before = (() => {
			try {
				return statSync(homeFile).mtimeMs;
			} catch {
				return -1;
			}
		})();
		await seedEnabledModels({ projectRoot, registry: VALID_REGISTRY });
		const after = (() => {
			try {
				return statSync(homeFile).mtimeMs;
			} catch {
				return -1;
			}
		})();
		expect(after).toBe(before);
	});

	it("disabled providers contribute no globs", async () => {
		const out = await seedEnabledModels({ projectRoot, registry: VALID_REGISTRY });
		const written = JSON.parse(await fs.readFile(out.path, "utf8")) as { enabledModels: string[] };
		expect(written.enabledModels).not.toContain("");
		expect(written.enabledModels.length).toBe(4);
	});
});

describe("detectMissingCredentials", () => {
	it("returns banner when no provider creds are set", () => {
		const banner = detectMissingCredentials(VALID_REGISTRY, {});
		expect(banner).not.toBeNull();
		expect(banner).toContain("ANTHROPIC_API_KEY");
		expect(banner).toContain("OPENAI_API_KEY");
		expect(banner).toContain("GEMINI_API_KEY");
		expect(banner).toContain("OPENROUTER_API_KEY");
	});

	it("returns null when at least one provider has creds", () => {
		const banner = detectMissingCredentials(VALID_REGISTRY, { ANTHROPIC_API_KEY: "sk-test" });
		expect(banner).toBeNull();
	});

	it("returns null when only Ollama-class providers are enabled (no creds required)", () => {
		const ollamaOnly: CuratedRegistry = {
			version: 1,
			providers: [
				{
					id: "ollama",
					label: "Ollama",
					enabled: true,
					modelGlobs: ["ollama/*"],
					credentialEnvAny: [],
				},
			],
		};
		const banner = detectMissingCredentials(ollamaOnly, {});
		expect(banner).toBeNull();
	});

	it("ignores empty-string env values", () => {
		const banner = detectMissingCredentials(VALID_REGISTRY, { ANTHROPIC_API_KEY: "" });
		expect(banner).not.toBeNull();
	});

	it("treats AWS_ACCESS_KEY_ID as a valid Anthropic creds source", () => {
		const banner = detectMissingCredentials(VALID_REGISTRY, { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE" });
		expect(banner).toBeNull();
	});
});

describe("__test__ helpers", () => {
	it("seededModelGlobs deduplicates", () => {
		const dup: CuratedRegistry = {
			version: 1,
			providers: [
				{ id: "a", label: "A", enabled: true, modelGlobs: ["x", "y"], credentialEnvAny: [] },
				{ id: "b", label: "B", enabled: true, modelGlobs: ["y", "z"], credentialEnvAny: [] },
			],
		};
		expect(__test__.seededModelGlobs(dup)).toEqual(["x", "y", "z"]);
	});

	it("defaultGlob falls back to claude-* when no enabled provider has globs", () => {
		const empty: CuratedRegistry = {
			version: 1,
			providers: [{ id: "a", label: "A", enabled: false, modelGlobs: ["x"], credentialEnvAny: [] }],
		};
		expect(__test__.defaultGlob(empty)).toBe("claude-*");
	});

	it("resolveRegistryPath prefers explicit > env > bundled", () => {
		const explicit = __test__.resolveRegistryPath({ registryPath: "/a", env: { FORGE_MODEL_REGISTRY: "/b" } });
		expect(explicit).toBe("/a");
		const envOnly = __test__.resolveRegistryPath({ env: { FORGE_MODEL_REGISTRY: "/b" } });
		expect(envOnly).toBe("/b");
		const bundled = __test__.resolveRegistryPath({ env: {} });
		expect(bundled).toBe(__test__.BUNDLED_PATH);
	});
});
