// Curated provider/model registry — FORGE-S16-T16 (issue #17).
//
// Loads forgecli's bundled registry/models.json (or a `FORGE_MODEL_REGISTRY`
// override), seeds project-scope `enabledModels` exactly once into
// `<projectRoot>/.forge/pi-settings.json`, and emits a missing-credentials
// banner naming the env vars the user can set. Global pi settings
// (`~/.pi/agent/settings.json`) are never read or written.

import { promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const ProviderSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	label: Type.String({ minLength: 1 }),
	enabled: Type.Boolean(),
	deferredTo: Type.Optional(Type.String()),
	modelGlobs: Type.Array(Type.String()),
	credentialEnvAny: Type.Array(Type.String()),
});

const RegistrySchema = Type.Object({
	version: Type.Literal(1),
	providers: Type.Array(ProviderSchema, { minItems: 1 }),
});

export type CuratedRegistry = Static<typeof RegistrySchema>;
export type CuratedProvider = Static<typeof ProviderSchema>;

export interface LoadOptions {
	registryPath?: string;
	env?: NodeJS.ProcessEnv;
}

export interface SeedOutcome {
	seeded: boolean;
	path: string;
}

export interface SeedOptions {
	projectRoot: string;
	registry: CuratedRegistry;
	now?: () => number;
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUNDLED_PATH = path.join(PKG_ROOT, "registry", "models.json");

function resolveRegistryPath(opts: LoadOptions): string {
	const env = opts.env ?? process.env;
	if (opts.registryPath && opts.registryPath.length > 0) return opts.registryPath;
	const envOverride = env.FORGE_MODEL_REGISTRY;
	if (typeof envOverride === "string" && envOverride.length > 0) return envOverride;
	return BUNDLED_PATH;
}

export function loadRegistry(opts: LoadOptions = {}): CuratedRegistry {
	const target = resolveRegistryPath(opts);
	const raw = readFileSync(target, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!Value.Check(RegistrySchema, parsed)) {
		const errors = [...Value.Errors(RegistrySchema, parsed)]
			.slice(0, 3)
			.map((e) => e.message)
			.join("; ");
		throw new Error(`Invalid model registry at ${target}: ${errors || "schema check failed"}`);
	}
	return parsed;
}

function seededModelGlobs(registry: CuratedRegistry): string[] {
	const out: string[] = [];
	for (const p of registry.providers) {
		if (!p.enabled) continue;
		for (const g of p.modelGlobs) {
			if (!out.includes(g)) out.push(g);
		}
	}
	return out;
}

function defaultGlob(registry: CuratedRegistry): string {
	for (const p of registry.providers) {
		if (p.enabled && p.modelGlobs.length > 0) return p.modelGlobs[0]!;
	}
	return "claude-*";
}

function seedFilePath(projectRoot: string): string {
	return path.join(projectRoot, ".forge", "pi-settings.json");
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

export async function seedEnabledModels(opts: SeedOptions): Promise<SeedOutcome> {
	const target = seedFilePath(opts.projectRoot);
	if (await pathExists(target)) {
		return { seeded: false, path: target };
	}
	const now = opts.now ?? (() => Date.now());
	const payload = {
		schemaVersion: 1,
		seededAt: now(),
		seedSource: "@entelligentsia/forgecli registry v1",
		enabledModels: seededModelGlobs(opts.registry),
		defaultModelGlob: defaultGlob(opts.registry),
	};
	await fs.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await fs.rename(tmp, target);
	return { seeded: true, path: target };
}

const PRIMARY_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"];

export function detectMissingCredentials(
	registry: CuratedRegistry,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const requiring = registry.providers.filter((p) => p.enabled && p.credentialEnvAny.length > 0);
	if (requiring.length === 0) return null;
	for (const p of requiring) {
		for (const key of p.credentialEnvAny) {
			const v = env[key];
			if (typeof v === "string" && v.length > 0) {
				return null;
			}
		}
	}
	const lines = [
		"forge — no provider credentials configured. Set one of:",
		`  ${PRIMARY_ENV_KEYS.join(", ")}`,
		"(or run pi /login for OAuth providers).",
	];
	return lines.join("\n");
}

export const __test__ = {
	BUNDLED_PATH,
	resolveRegistryPath,
	seedFilePath,
	seededModelGlobs,
	defaultGlob,
	RegistrySchema,
};
