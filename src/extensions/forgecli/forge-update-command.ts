// Guided /forge:update command + bundled-forge drift prompt — FORGE-S16-T15.
// Migration apply integration — FORGE-S23-T01.
//
// Single update path: detect npm install method, refuse non-global, show
// changelog from GitHub releases (Entelligentsia/forge-cli), confirm via
// ctx.ui.confirm, then spawn `npm i -g @entelligentsia/forgecli@latest` via
// execFile (argv array — no shell). After upgrade, prompt to run migrations
// from the old bundled-forge version to the new one.
//
// Version detection uses the npm registry (authoritative); GitHub releases are
// used only for the changelog body via a tag-specific URL.

import { execFile } from "node:child_process";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getUserCacheDir } from "./paths/paths.js";
import { getBundledPayloadRoot } from "./forge-init.js";
import { runMigrations } from "./migration-engine.js";

const execFileAsync = promisify(execFile);

const PKG_NAME = "@entelligentsia/forgecli";
const NPM_DIST_TAGS_URL = "https://registry.npmjs.org/@entelligentsia/forgecli";
function changelogTagUrl(version: string): string {
	return `https://api.github.com/repos/Entelligentsia/forge-cli/releases/tags/v${version}`;
}
const PROBE_TIMEOUT_MS = 5000;
const UPGRADE_TIMEOUT_MS = 120_000;
const NPM_ROOT_TIMEOUT_MS = 5000;
const BODY_EXCERPT_MAX = 1200;

export type InstallMethod = "global" | "npx" | "local-dev" | "unknown";

export interface DetectInstallOptions {
	pkgRoot: string;
	globalRoot?: string | null;
}

/**
 * Classify how the running forgecli was installed by inspecting its package
 * root path. Pure function — easy to unit-test.
 */
export function detectInstallMethod(opts: DetectInstallOptions): InstallMethod {
	const norm = path.resolve(opts.pkgRoot);
	if (/[/\\]_npx[/\\]/.test(norm)) return "npx";
	if (opts.globalRoot && norm.startsWith(path.resolve(opts.globalRoot))) return "global";
	return "local-dev";
}

type ExecFileAsync = (
	cmd: string,
	args: readonly string[],
	options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export async function getNpmGlobalRoot(runner?: ExecFileAsync): Promise<string | null> {
	const run = runner ?? (execFileAsync as ExecFileAsync);
	try {
		const { stdout } = await run("npm", ["root", "-g"], { timeout: NPM_ROOT_TIMEOUT_MS });
		const trimmed = stdout.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

export interface ChangelogResult {
	tag: string;
	version: string;
	body: string;
}

export async function fetchChangelog(fetchImpl: typeof fetch): Promise<ChangelogResult | null> {
	// Step 1: get latest version from npm (authoritative — GitHub releases may lag).
	const npmCtl = new AbortController();
	const npmTimer = setTimeout(() => npmCtl.abort(), PROBE_TIMEOUT_MS);
	let npmVersion: string | null = null;
	try {
		const res = await fetchImpl(NPM_DIST_TAGS_URL, {
			signal: npmCtl.signal,
			headers: { Accept: "application/json" },
		});
		if (res.ok) {
			const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
			const tag = body["dist-tags"]?.latest;
			npmVersion = typeof tag === "string" ? tag : null;
		}
	} catch {
		// fall through to null return
	} finally {
		clearTimeout(npmTimer);
	}
	if (!npmVersion) return null;
	const version = npmVersion.startsWith("v") ? npmVersion.slice(1) : npmVersion;

	// Step 2: fetch changelog body from the tag-specific GitHub release (optional).
	const ghCtl = new AbortController();
	const ghTimer = setTimeout(() => ghCtl.abort(), PROBE_TIMEOUT_MS);
	let releaseBody = "";
	try {
		const res = await fetchImpl(changelogTagUrl(version), {
			signal: ghCtl.signal,
			headers: { Accept: "application/vnd.github+json" },
		});
		if (res.ok) {
			const json = (await res.json()) as { body?: unknown };
			if (typeof json.body === "string") releaseBody = json.body;
		}
	} catch {
		// changelog body is optional — proceed with empty
	} finally {
		clearTimeout(ghTimer);
	}

	return { tag: `v${version}`, version, body: releaseBody };
}

function parseTriple(v: string): [number, number, number] | null {
	const cleaned = v.startsWith("v") ? v.slice(1) : v;
	const parts = cleaned.split(".");
	if (parts.length !== 3) return null;
	const nums: number[] = [];
	for (const p of parts) {
		if (!/^\d+$/.test(p)) return null;
		nums.push(Number.parseInt(p, 10));
	}
	return [nums[0]!, nums[1]!, nums[2]!];
}

export function isUpgrade(current: string, latest: string): boolean {
	const a = parseTriple(latest);
	const b = parseTriple(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i]! > b[i]!) return true;
		if (a[i]! < b[i]!) return false;
	}
	return false;
}

export function composeChangelogSummary(current: string, latest: string, body: string): string {
	const trimmed = body.trim();
	const excerpt = trimmed.length > BODY_EXCERPT_MAX ? `${trimmed.slice(0, BODY_EXCERPT_MAX)}…` : trimmed;
	return [
		`Current: ${current}`,
		`Latest:  ${latest}`,
		"",
		"Release notes:",
		excerpt.length > 0 ? excerpt : "(release body empty)",
		"",
		`This will run: npm i -g ${PKG_NAME}@${latest}`,
	].join("\n");
}

export interface UpgradeResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export async function runUpgrade(spec: string, runner?: ExecFileAsync): Promise<UpgradeResult> {
	const run = runner ?? (execFileAsync as ExecFileAsync);
	try {
		const { stdout, stderr } = await run("npm", ["i", "-g", spec], { timeout: UPGRADE_TIMEOUT_MS });
		return { ok: true, stdout, stderr };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "unknown error" };
	}
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── Bundled-forge drift detection (Q7) ─────────────────────────────────────
//
// On every session_start we compare the bundled-forge version recorded in the
// drift cache against the current package.json forge.bundledVersion. If the
// version changed and we have not already prompted for it, emit a one-shot
// migration prompt. The cache is per-version idempotent: re-prompting only
// happens after another change.

const DRIFT_CACHE_FILE = "drift-seen.json";

interface DriftCache {
	lastSeenBundledForgeVersion: string | null;
	promptedForVersions: string[];
}

function defaultCacheDir(): string {
	return getUserCacheDir();
}

function driftCachePath(dir: string): string {
	return path.join(dir, DRIFT_CACHE_FILE);
}

async function readDriftCache(dir: string): Promise<DriftCache> {
	try {
		const raw = await fs.readFile(driftCachePath(dir), "utf8");
		const parsed = JSON.parse(raw) as Partial<DriftCache>;
		return {
			lastSeenBundledForgeVersion:
				typeof parsed.lastSeenBundledForgeVersion === "string" ? parsed.lastSeenBundledForgeVersion : null,
			promptedForVersions: Array.isArray(parsed.promptedForVersions)
				? parsed.promptedForVersions.filter((v): v is string => typeof v === "string")
				: [],
		};
	} catch {
		return { lastSeenBundledForgeVersion: null, promptedForVersions: [] };
	}
}

async function writeDriftCache(dir: string, cache: DriftCache): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const final = driftCachePath(dir);
	const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
	await fs.rename(tmp, final);
}

export interface DriftCheckOptions {
	currentBundledForgeVersion: string;
	notify(message: string, level: "info" | "warning" | "error"): void;
	cacheDir?: string;
}

export async function checkBundledForgeDrift(opts: DriftCheckOptions): Promise<void> {
	const current = opts.currentBundledForgeVersion;
	if (!current) return;
	const cacheDir = opts.cacheDir ?? defaultCacheDir();
	const cache = await readDriftCache(cacheDir);
	const last = cache.lastSeenBundledForgeVersion;
	if (last && last !== current && !cache.promptedForVersions.includes(current)) {
		opts.notify(
			`forge: bundled forge plugin changed (${last} → ${current}). ` +
				`Run /forge:update to apply project migrations from v${last} to v${current}.`,
			"info",
		);
		cache.promptedForVersions = [...cache.promptedForVersions, current];
	}
	cache.lastSeenBundledForgeVersion = current;
	try {
		await writeDriftCache(cacheDir, cache);
	} catch {
		// fail-silent — banner already shown if applicable
	}
}

// ── Command registration ───────────────────────────────────────────────────

export interface RegisterUpdateCommandOptions {
	pkgRoot: string;
	currentCliVersion: string;
	fetchImpl?: typeof fetch;
	globalRootResolver?: () => Promise<string | null>;
	upgradeRunner?: (spec: string) => Promise<UpgradeResult>;
	/** Migration runner — defaults to the production runMigrations engine (injected for testing) */
	migrationRunner?: typeof runMigrations;
	/** Resolved bundled-forge version for migrations — defaults to reading plugin.json from bundle */
	currentBundledForgeVersion?: string;
	/** Override CWD for migration projectRoot — defaults to process.cwd() */
	migrationProjectRoot?: string;
	/** Override drift cache path for migration lastSeenBundledForgeVersion — read from cache at migration time */
	driftCacheDir?: string;
}

export function registerForgeUpdateCommand(pi: ExtensionAPI, opts: RegisterUpdateCommandOptions): void {
	pi.registerCommand("forge:update", {
		description: "Guided upgrade for forgecli (npm i -g) + bundled forge migration prompts",
		async handler(_args, ctx) {
			const fetchImpl = opts.fetchImpl ?? fetch;
			const resolveGlobal = opts.globalRootResolver ?? (() => getNpmGlobalRoot());
			const upgrade = opts.upgradeRunner ?? ((spec: string) => runUpgrade(spec));

			// 1. Install method detection (AC#1)
			const globalRoot = await resolveGlobal();
			const method = detectInstallMethod({ pkgRoot: opts.pkgRoot, globalRoot });
			if (method !== "global") {
				ctx.ui.notify(
					`forge:update — install method '${method}' is not eligible for guided upgrade. ` +
						`Only globally-installed forgecli is supported. ` +
						`To upgrade manually: npm i -g ${PKG_NAME}@latest`,
					"warning",
				);
				return;
			}

			// 2. Fetch latest changelog (AC#2)
			ctx.ui.setStatus("forge:update", "Fetching latest release notes…");
			const release = await fetchChangelog(fetchImpl);
			ctx.ui.setStatus("forge:update", undefined);
			if (!release) {
				ctx.ui.notify(
					"forge:update — could not reach the npm registry to check for updates. " +
						`Check your network and retry, or upgrade manually: npm i -g ${PKG_NAME}@latest`,
					"error",
				);
				return;
			}

			// CLI npm-package upgrade and project↔bundle migration are orthogonal:
			// the bundle can drift even when the CLI is already at npm's latest
			// (locally-built CLI ahead of npm, fresh machine, cleared drift cache).
			// Run each gate independently — both fall through to the migration
			// block, only confirm-decline / npm-failure short-circuit. (#32 follow-up)
			const current = opts.currentCliVersion;
			if (!isUpgrade(current, release.version)) {
				ctx.ui.notify(
					`forge:update — already at the latest version (${current}; latest published: ${release.version}).`,
					"info",
				);
			} else {
				// 3. Show changelog + confirm (AC#3)
				const summary = composeChangelogSummary(current, release.version, release.body);
				const proceed = await ctx.ui.confirm(`Upgrade forgecli ${current} → ${release.version}?`, summary);
				if (!proceed) {
					ctx.ui.notify("forge:update — cancelled.", "info");
					return;
				}

				// 4. Spawn npm i -g (AC#4 — execFile, no shell)
				ctx.ui.setStatus("forge:update", `Upgrading to ${release.version}…`);
				const result = await upgrade(`${PKG_NAME}@${release.version}`);
				ctx.ui.setStatus("forge:update", undefined);
				if (!result.ok) {
					ctx.ui.notify(
						`forge:update — npm i -g failed: ${truncate(result.stderr, 400)}. ` +
							"Check the error above; you may need elevated permissions to install globally.",
						"error",
					);
					return;
				}

				ctx.ui.notify(
					`forge:update — installed ${PKG_NAME}@${release.version}. ` +
						"Restart your forge session for the new version to take effect.",
					"info",
				);
			}

			// 5. Migration prompt — offer to apply project migrations (§2A, §2D)
			// Only runs when the caller has opted into migration support by providing
			// migrationRunner or currentBundledForgeVersion. Without those the command
			// was invoked in a context where migrations are not wired (e.g. tests for
			// the base upgrade flow, or environments without a bundled payload).
			if (opts.migrationRunner === undefined && opts.currentBundledForgeVersion === undefined) {
				return;
			}

			// fromVersion comes from the drift cache (what the bundle was before upgrade).
			// toVersion comes from the newly installed bundle's plugin.json.
			const cacheDir = opts.driftCacheDir ?? defaultCacheDir();
			const driftCache = await readDriftCache(cacheDir);
			const fromVersion = driftCache.lastSeenBundledForgeVersion;

			// Read toVersion from the newly installed bundle's plugin.json
			let toVersion: string | null = opts.currentBundledForgeVersion ?? null;
			if (!toVersion) {
				try {
					const bundleRoot = getBundledPayloadRoot();
					const pluginJsonPath = path.join(bundleRoot, ".claude-plugin", "plugin.json");
					if (existsSync(pluginJsonPath)) {
						const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
							version?: string;
						};
						toVersion = pluginJson.version ?? null;
					}
				} catch {
					// Unable to read plugin.json — skip migration prompt
				}
			}

			if (fromVersion && toVersion && fromVersion !== toVersion) {
				// Determine whether to auto-apply (FORGE_NON_INTERACTIVE=1) or prompt
				const nonInteractive = process.env["FORGE_NON_INTERACTIVE"] === "1";
				let applyMigrations = nonInteractive;

				if (!nonInteractive) {
					applyMigrations = await ctx.ui.confirm(
						`Run migrations from v${fromVersion} to v${toVersion}?`,
						`The bundled forge plugin was updated from v${fromVersion} to v${toVersion}.\n` +
							`Applying migrations will regenerate any changed .forge/ files to match the new version.`,
					);
				}

				if (applyMigrations) {
					ctx.ui.setStatus("forge:update", `Applying migrations v${fromVersion} → v${toVersion}…`);
					try {
						const migRunner = opts.migrationRunner ?? runMigrations;
						const bundleRoot = getBundledPayloadRoot();
						const projectRoot = opts.migrationProjectRoot ?? process.cwd();
						const migResult = await migRunner({
							bundleRoot,
							projectRoot,
							fromVersion,
							toVersion,
						});
						ctx.ui.setStatus("forge:update", undefined);

						// Emit SYS-migration event for each applied version (mandatory per §2D)
						// These are informational store events that survive post-session analysis.
						for (const applied of migResult.applied) {
							try {
								const payload = JSON.stringify({
									fromVersion: applied.fromVersion,
									toVersion: applied.toVersion,
									appliedCategories: applied.categories,
									timestamp: new Date().toISOString(),
								});
								await execFileAsync("node", [
									path.join(bundleRoot, "tools", "store-cli.cjs"),
									"emit",
									"SYS-migration",
									payload,
								], { cwd: projectRoot }).catch(() => {
									// store-cli not available or project not initialized — non-fatal
								});
							} catch {
								// Non-fatal: event emission failure doesn't block migration result
							}
						}

						// Report results
						if (migResult.applied.length > 0) {
							ctx.ui.notify(
								`forge:update — applied ${migResult.applied.length} migration(s) from v${fromVersion} to v${toVersion}. ` +
									`${migResult.schemasRefreshed.length} schema file(s) refreshed.`,
								"info",
							);
						} else {
							ctx.ui.notify(
								`forge:update — no migrations needed from v${fromVersion} to v${toVersion}.`,
								"info",
							);
						}

						if (migResult.skippedBreaking.length > 0) {
							ctx.ui.notify(
								`forge:update — ${migResult.skippedBreaking.length} breaking migration(s) skipped. Manual review required.`,
								"warning",
							);
						}

						if (migResult.manualSteps.length > 0) {
							const steps = migResult.manualSteps.flatMap((m) => m.steps);
							ctx.ui.notify(
								`forge:update — manual steps required:\n${steps.map((s) => `  • ${s}`).join("\n")}`,
								"warning",
							);
						}
					} catch (err: unknown) {
						ctx.ui.setStatus("forge:update", undefined);
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(
							`forge:update — migration failed: ${msg}. Check .forge/ state manually.`,
							"error",
						);
					}
				} else if (!nonInteractive) {
					ctx.ui.notify(
						`forge:update — migrations skipped. Run /forge:update again to apply migrations from v${fromVersion} to v${toVersion}.`,
						"info",
					);
				}
			}
		},
	});
}

// ── Test helpers ────────────────────────────────────────────────────────────

export const __test__ = {
	parseTriple,
	driftCachePath,
	readDriftCache,
	writeDriftCache,
	defaultCacheDir,
	PKG_NAME,
	NPM_DIST_TAGS_URL,
	changelogTagUrl,
	UPGRADE_TIMEOUT_MS,
	NPM_ROOT_TIMEOUT_MS,
	PROBE_TIMEOUT_MS,
};
