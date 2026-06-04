// /forge:update — CLI preflight + patched plugin-native flow (FORGE-BUG-039).
//
// Two-layer kickoff-shim architecture:
//   Layer 1 (TypeScript): CLI-specific preflight — install method detection,
//     npm changelog + upgrade. NOT handled by the plugin's update.md.
//   Layer 2 (agent follows update.md): Full 7-step plugin update workflow
//     with surgical text patches for forge-cli context differences.
//
// This replaces the previous monolithic TypeScript reimplementation that:
//   - Missed generation-manifest checks (data loss risk)
//   - Bypassed /forge:regenerate's modification guard + snapshot replay
//   - Skipped Steps 5 (pipeline audit) and 7 (KB link refresh)
//   - Always lagged behind the plugin's evolving workflow
//
// The patched update.md is read from the bundled payload at runtime,
// so plugin changes are automatically picked up. Patches are minimal
// and validated by tests.

import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBundledPayloadRoot } from "../forge-init/forge-init.js";
import { sendKickoff } from "../kickoff.js";
import { getUserCacheDir } from "../paths/paths.js";

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

// ── Install method detection ───────────────────────────────────────────────

export type InstallMethod = "global" | "npx" | "local-dev" | "unknown";

export interface DetectInstallOptions {
	pkgRoot: string;
	globalRoot?: string | null;
}

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

// ── Changelog + upgrade ─────────────────────────────────────────────────────

export interface ChangelogResult {
	tag: string;
	version: string;
	body: string;
}

export async function fetchChangelog(fetchImpl: typeof fetch): Promise<ChangelogResult | null> {
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

// ── Bundled-forge drift detection (session-start hook) ──────────────────────
//
// On every session_start we compare the bundled-forge version recorded in the
// drift cache against the current package.json forge.bundledVersion. If the
// version changed and we have not already prompted for it, emit a one-shot
// migration prompt. The cache is per-version idempotent.
//
// This hook is independent of the /forge:update command — it runs at session
// start, before the user invokes any command.

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

// ── Kickoff composition ─────────────────────────────────────────────────────

interface CliPreflightResult {
	method: InstallMethod;
	upgraded: boolean;
	cliOldVersion?: string;
	cliNewVersion?: string;
	npmVersion?: string;
	npmFetchFailed: boolean;
	bundledForgeVersion: string;
}

/**
 * Read the bundled update.md and apply forge-cli-specific patches.
 *
 * The plugin's update.md was written for Claude Code's plugin architecture.
 * forge-cli uses a bundled payload instead of the Claude Code plugin cache,
 * so we patch:
 *
 * 1. FORGE_ROOT: Replace CLAUDE_PLUGIN_ROOT with bundled payload path
 * 2. IS_CANARY: Always true (bundle is never in /.claude/plugins/)
 * 3. DISTRIBUTION: Always "forge@forge" (no marketplace detection)
 * 4. migrations.json: Bundle puts it in .schemas/, not top-level
 * 5. CLI preflight result: Instruct agent to skip Steps 1/2A/3
 * 6. CLAUDE_PLUGIN_DATA: Replace with bundled payload path
 *
 * All patches are pure string replacements — no AST parsing needed.
 * If a patch target isn't found, we log a warning but don't crash
 * (the agent may still be able to follow the unpatched instructions
 * partially).
 */
export function composeUpdateKickoff(updateMd: string, bundleRoot: string, preflight: CliPreflightResult): string {
	let patched = updateMd;

	// Patch 1: FORGE_ROOT — replace Claude Code directive with literal path
	// Original:  FORGE_ROOT: !`echo "${CLAUDE_PLUGIN_ROOT}"`
	// Patched:   FORGE_ROOT = <bundledPayloadRoot>
	const forgeRootDirective = '!`echo "${CLAUDE_PLUGIN_ROOT}"`';
	if (patched.includes(forgeRootDirective)) {
		patched = patched.replaceAll(forgeRootDirective, bundleRoot);
	}

	// Patch 1b: Second occurrence is in Step 3's "Re-derive FORGE_ROOT"
	// Same directive appears there. Already handled by replaceAll above.

	// Patch 2: CLAUDE_PLUGIN_DATA — used for legacy cache fallback
	// Replace with bundle root since forge-cli doesn't have plugin data dir
	if (patched.includes("${CLAUDE_PLUGIN_DATA}")) {
		patched = patched.replaceAll("${CLAUDE_PLUGIN_DATA}", bundleRoot);
	}

	// Patch 3: IS_CANARY — force to true. The plugin's canary detection
	// checks for "/.claude/plugins/" in FORGE_ROOT, which never matches
	// the bundled payload path. Setting IS_CANARY=true ensures:
	//   - Row 3 triggers (skip Step 2A — no plugin manager install)
	//   - Step 3 re-derivation is skipped (FORGE_ROOT doesn't change)
	// We insert this right after the IS_CANARY detection paragraph.
	const canaryAnchor = "**Canary / source install** (`IS_CANARY = true`)";
	if (patched.includes(canaryAnchor)) {
		patched = patched.replace(
			canaryAnchor,
			` forge-cli: IS_CANARY is ALWAYS true — the bundled payload is never in the Claude Code plugin directory. ` +
				"Row 3 of the decision table always applies: skip Step 2A, proceed to Step 2B. " +
				"`IS_CANARY` = true",
		);
	}

	// Patch 4: DISTRIBUTION — forge-cli always uses canary distribution
	// Insert after the distribution table
	const distAnchor = "| anything else | `forge@forge` / canary |";
	if (patched.includes(distAnchor)) {
		patched = patched.replace(
			distAnchor,
			distAnchor +
				"\n\n> **forge-cli note:** The bundled payload is never in the Claude Code plugin cache, " +
				'so DISTRIBUTION is always `forge@forge` / canary. Set `DISTRIBUTION = "forge@forge"` now.',
		);
	}

	// Patch 5: migrations.json path — bundle puts it in .schemas/, not top-level
	// Step 2B reads: Read `$FORGE_ROOT/migrations.json` (local).
	// Step 4 reads: Read `$FORGE_ROOT/migrations.json` (local — now updated after install).
	if (patched.includes("$FORGE_ROOT/migrations.json")) {
		patched = patched.replaceAll("$FORGE_ROOT/migrations.json", "$FORGE_ROOT/.schemas/migrations.json");
	}

	// Patch 6: CLI preflight result — inject before Step 1
	// This tells the agent what the CLI preflight already did so it can
	// skip the remote version check, Step 2A, and Step 3.
	const cliResult = [
		"",
		"---",
		"",
		"## forge-cli: CLI Preflight Result",
		"",
		`Install method: **${preflight.method}**`,
		preflight.upgraded
			? `CLI upgraded: **${preflight.cliOldVersion} → ${preflight.cliNewVersion}**`
			: "No CLI upgrade needed (or not eligible).",
		preflight.npmVersion
			? `Remote version (npm): **${preflight.npmVersion}**`
			: preflight.npmFetchFailed
				? "Could not reach npm registry — proceeding with local version only."
				: "",
		`LOCAL_VERSION (bundled forge): **${preflight.bundledForgeVersion}**`,
		"",
		"**Action for the agent:**",
		preflight.npmFetchFailed
			? "- Could not reach registry → use LOCAL_VERSION as both local and remote"
			: "- Use LOCAL_VERSION and the npm version above for the decision table",
		"- **Skip Step 2A** — CLI already handled npm upgrade (or not applicable)",
		"- **Skip Step 3** — FORGE_ROOT does not change in forge-cli (npm path is stable)",
		"- Resume detection (FR-002): check `.forge/update-check-cache.json` `updateStatus` as usual",
		"- All other steps (1, 2B, 4, 5, 6, 7) proceed normally",
		`- **FORGE_ROOT resolution**: When reading bundled commands or workflows (e.g. regenerate.md, update-tools.md), replace any Claude-Code plugin-root env-var reference with ${bundleRoot}. FORGE_ROOT = ${bundleRoot} in forge-cli.`,
		`- **Step 6 migratedFrom**: Write migratedFrom: LOCAL_VERSION (the CURRENT version after update, e.g. ${preflight.bundledForgeVersion}), NOT the old baseline. This ensures subsequent updates correctly detect the project is up to date.`,
		`- **substitute-placeholders base-pack path**: In forge-cli, the base-pack is at ${bundleRoot}/.base-pack/ (not init/base-pack). When invoking substitute-placeholders.cjs, pass --base-pack ${bundleRoot}/.base-pack to avoid "base-pack not found" errors.`,
		"",
		"---",
		"",
	].join("\n");

	// Insert before "## Step 1"
	const step1Anchor = "## Step 1 — Check for updates";
	if (patched.includes(step1Anchor)) {
		patched = patched.replace(step1Anchor, cliResult + step1Anchor);
	}

	return patched;
}

// ── Command registration ───────────────────────────────────────────────────

export interface RegisterUpdateCommandOptions {
	pkgRoot: string;
	currentCliVersion: string;
	fetchImpl?: typeof fetch;
	globalRootResolver?: () => Promise<string | null>;
	upgradeRunner?: (spec: string) => Promise<UpgradeResult>;
	/** Override bundled-forge version for drift cache */
	currentBundledForgeVersion?: string;
	/** Override drift cache path */
	driftCacheDir?: string;
}

export function registerForgeUpdateCommand(pi: ExtensionAPI, opts: RegisterUpdateCommandOptions): void {
	pi.registerCommand("forge:update", {
		description: "Guided upgrade for forgecli (npm i -g) + project migration via plugin-native update workflow",
		async handler(_args, ctx) {
			const fetchImpl = opts.fetchImpl ?? fetch;
			const resolveGlobal = opts.globalRootResolver ?? (() => getNpmGlobalRoot());
			const upgrade = opts.upgradeRunner ?? ((spec: string) => runUpgrade(spec));

			// ── Layer 1: CLI Preflight ───────────────────────────────────────

			const globalRoot = await resolveGlobal();
			const method = detectInstallMethod({ pkgRoot: opts.pkgRoot, globalRoot });

			let release: ChangelogResult | null = null;
			let upgraded = false;
			let cliOldVersion: string | undefined;
			let cliNewVersion: string | undefined;

			if (method !== "global") {
				ctx.ui.notify(
					`forge:update — install method '${method}' is not eligible for guided npm upgrade. ` +
						`To upgrade the CLI manually: npm i -g ${PKG_NAME}@latest. ` +
						"Proceeding to project update…",
					"warning",
				);
			} else {
				// Fetch latest changelog + confirm upgrade
				ctx.ui.setStatus("forge:update", "Fetching latest release notes…");
				release = await fetchChangelog(fetchImpl);
				ctx.ui.setStatus("forge:update", undefined);

				if (!release) {
					ctx.ui.notify(
						"forge:update — could not reach the npm registry to check for updates. " +
							`Check your network and retry, or upgrade manually: npm i -g ${PKG_NAME}@latest. ` +
							"Proceeding to project update…",
						"warning",
					);
				} else {
					const current = opts.currentCliVersion;
					if (!isUpgrade(current, release.version)) {
						ctx.ui.notify(
							`forge:update — already at the latest version (${current}; latest published: ${release.version}).`,
							"info",
						);
					} else {
						const summary = composeChangelogSummary(current, release.version, release.body);
						const proceed = await ctx.ui.confirm(`Upgrade forgecli ${current} → ${release.version}?`, summary);
						if (!proceed) {
							ctx.ui.notify("forge:update — npm upgrade cancelled. Proceeding to project update…", "info");
						} else {
							ctx.ui.setStatus("forge:update", `Upgrading to ${release.version}…`);
							const result = await upgrade(`${PKG_NAME}@${release.version}`);
							ctx.ui.setStatus("forge:update", undefined);
							if (!result.ok) {
								ctx.ui.notify(
									`forge:update — npm i -g failed: ${truncate(result.stderr, 400)}. ` +
										"Check the error above; you may need elevated permissions. " +
										"Proceeding to project update…",
									"error",
								);
							} else {
								upgraded = true;
								cliOldVersion = current;
								cliNewVersion = release.version;
								ctx.ui.notify(
									`forge:update — installed ${PKG_NAME}@${release.version}. ` +
										"Restart your forge session for the new version to take effect.",
									"info",
								);
							}
						}
					}
				}
			} // end global-only branch

			// ── Layer 2: Patched Plugin-Native Flow ──────────────────────────

			const bundleRoot = getBundledPayloadRoot();

			// Read bundled forge version for the preflight result
			let bundledForgeVersion = opts.currentBundledForgeVersion ?? "";
			if (!bundledForgeVersion) {
				try {
					const pluginJsonPath = path.join(bundleRoot, ".claude-plugin", "plugin.json");
					if (existsSync(pluginJsonPath)) {
						const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as { version?: string };
						bundledForgeVersion = pluginJson.version ?? "";
					}
				} catch {
					// unable to read
				}
			}

			if (!bundledForgeVersion) {
				ctx.ui.notify(
					"forge:update — could not determine bundled forge version. " +
						"Run /forge:init first, or check the forge-payload installation.",
					"error",
				);
				return;
			}

			// Read and patch update.md from bundled payload
			const updateMdPath = path.join(bundleRoot, "commands", "update.md");
			let updateMd: string;
			try {
				updateMd = readFileSync(updateMdPath, "utf8");
			} catch {
				ctx.ui.notify(
					`forge:update — bundled update.md not found at ${updateMdPath}. ` +
						"The bundled payload may be incomplete. Run /forge:init to repair.",
					"error",
				);
				return;
			}

			const preflight: CliPreflightResult = {
				method,
				upgraded,
				cliOldVersion,
				cliNewVersion,
				npmVersion: release?.version,
				npmFetchFailed: method === "global" && !release,
				bundledForgeVersion,
			};

			const kickoffText = composeUpdateKickoff(updateMd, bundleRoot, preflight);

			sendKickoff(pi, kickoffText);
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
	composeUpdateKickoff,
};
