// Guided /forge:update command + bundled-forge drift prompt — FORGE-S16-T15.
//
// Single update path: detect npm install method, refuse non-global, show
// changelog from GitHub releases (Entelligentsia/forge-cli), confirm via
// ctx.ui.confirm, then spawn `npm i -g @entelligentsia/forgecli@latest` via
// execFile (argv array — no shell). On the next session_start after upgrade,
// detect bundled-forge version drift and emit a one-shot project-migrations
// prompt (Q7 detect+prompt; never auto-applies).

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@entelligentsia/pi-coding-agent";

const execFileAsync = promisify(execFile);

const PKG_NAME = "@entelligentsia/forgecli";
const CHANGELOG_URL = "https://api.github.com/repos/Entelligentsia/forge-cli/releases/latest";
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
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(CHANGELOG_URL, {
			signal: ctl.signal,
			headers: { Accept: "application/vnd.github+json" },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { tag_name?: unknown; body?: unknown };
		if (typeof body.tag_name !== "string") return null;
		const tag = body.tag_name;
		const version = tag.startsWith("v") ? tag.slice(1) : tag;
		const text = typeof body.body === "string" ? body.body : "";
		return { tag, version, body: text };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
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
	const root = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
	return path.join(root, "forgecli");
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
				"Run /forge:health to check for project migrations affecting this project.",
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
					"forge:update — could not reach github.com/Entelligentsia/forge-cli releases. " +
						`Check your network and retry, or upgrade manually: npm i -g ${PKG_NAME}@latest`,
					"error",
				);
				return;
			}

			const current = opts.currentCliVersion;
			if (!isUpgrade(current, release.version)) {
				ctx.ui.notify(
					`forge:update — already at the latest version (${current}; latest published: ${release.version}).`,
					"info",
				);
				return;
			}

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
					"Restart your forge session for the new version to take effect. " +
					"Project migrations (if any) will be prompted on the next session_start.",
				"info",
			);
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
	CHANGELOG_URL,
	UPGRADE_TIMEOUT_MS,
	NPM_ROOT_TIMEOUT_MS,
	PROBE_TIMEOUT_MS,
};
