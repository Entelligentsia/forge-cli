// Update-check probe + banner — FORGE-S16-T14 (issue #18, part 1).
//
// Dual-probe (npm registry + Entelligentsia/forge GitHub releases) with a
// 24h TTL, per-version dismissal cache, and `FORGE_NO_UPDATE_CHECK=1`
// opt-out. This is the only outbound HTTP traffic forgecli performs (Q21).
// All failures are fail-silent on the user surface; debug output requires
// FORGE_DEBUG_UPDATE_CHECK=1.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const NPM_URL = "https://registry.npmjs.org/@entelligentsia/forgecli";
const GH_RELEASES_URL = "https://api.github.com/repos/Entelligentsia/forge/releases/latest";

export interface UpdateCheckOptions {
	notify(message: string, level: "info" | "warning" | "error"): void;
	currentCliVersion: string;
	currentBundledForgeVersion: string;
	now?: () => number;
	fetchImpl?: typeof fetch;
	cacheDir?: string;
}

export interface UpdateBannerCache {
	lastProbeAt: number;
	latestNpmVersion: string | null;
	latestForgeVersion: string | null;
	dismissedNpmVersions: string[];
	dismissedForgeVersions: string[];
}

function defaultCacheDir(): string {
	const root = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
	return path.join(root, "forgecli");
}

function cachePath(cacheDir: string): string {
	return path.join(cacheDir, "update-banner.json");
}

async function readCache(cacheDir: string): Promise<UpdateBannerCache | null> {
	try {
		const raw = await fs.readFile(cachePath(cacheDir), "utf8");
		const parsed = JSON.parse(raw) as Partial<UpdateBannerCache>;
		return {
			lastProbeAt: typeof parsed.lastProbeAt === "number" ? parsed.lastProbeAt : 0,
			latestNpmVersion: typeof parsed.latestNpmVersion === "string" ? parsed.latestNpmVersion : null,
			latestForgeVersion: typeof parsed.latestForgeVersion === "string" ? parsed.latestForgeVersion : null,
			dismissedNpmVersions: Array.isArray(parsed.dismissedNpmVersions)
				? parsed.dismissedNpmVersions.filter((v) => typeof v === "string")
				: [],
			dismissedForgeVersions: Array.isArray(parsed.dismissedForgeVersions)
				? parsed.dismissedForgeVersions.filter((v) => typeof v === "string")
				: [],
		};
	} catch {
		return null;
	}
}

async function writeCache(cacheDir: string, cache: UpdateBannerCache): Promise<void> {
	await fs.mkdir(cacheDir, { recursive: true });
	const final = cachePath(cacheDir);
	const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
	await fs.rename(tmp, final);
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

function semverGt(a: string, b: string): boolean {
	const pa = parseTriple(a);
	const pb = parseTriple(b);
	if (!pa || !pb) return false;
	for (let i = 0; i < 3; i++) {
		if (pa[i]! > pb[i]!) return true;
		if (pa[i]! < pb[i]!) return false;
	}
	return false;
}

function debug(...args: unknown[]): void {
	if (process.env.FORGE_DEBUG_UPDATE_CHECK === "1") {
		console.error("[forge-cli update-check]", ...args);
	}
}

async function probeNpm(fetchImpl: typeof fetch): Promise<string | null> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(NPM_URL, { signal: ctl.signal, headers: { Accept: "application/json" } });
		if (!res.ok) return null;
		const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
		const tag = body["dist-tags"]?.latest;
		return typeof tag === "string" ? tag : null;
	} catch (err) {
		debug("npm probe failed:", err);
		return null;
	} finally {
		clearTimeout(t);
	}
}

async function probeForge(fetchImpl: typeof fetch): Promise<string | null> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(GH_RELEASES_URL, {
			signal: ctl.signal,
			headers: { Accept: "application/vnd.github+json" },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { tag_name?: unknown };
		if (typeof body.tag_name !== "string") return null;
		return body.tag_name.startsWith("v") ? body.tag_name.slice(1) : body.tag_name;
	} catch (err) {
		debug("github releases probe failed:", err);
		return null;
	} finally {
		clearTimeout(t);
	}
}

function composeBanner(
	npm: { current: string; latest: string } | null,
	forge: { current: string; latest: string } | null,
): string | null {
	const lines: string[] = [];
	if (npm) {
		lines.push(
			`forge-cli: update available — ${npm.current} → ${npm.latest} (npm i -g @entelligentsia/forgecli@${npm.latest})`,
		);
	}
	if (forge) {
		lines.push(
			`forge plugin: update available — ${forge.current} → ${forge.latest} (run /forge:update for migration guide)`,
		);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

export async function triggerUpdateCheck(opts: UpdateCheckOptions): Promise<void> {
	if (process.env.FORGE_NO_UPDATE_CHECK === "1") return;

	const now = opts.now ?? (() => Date.now());
	const fetchImpl = opts.fetchImpl ?? fetch;
	const cacheDir = opts.cacheDir ?? defaultCacheDir();

	let cache = (await readCache(cacheDir)) ?? {
		lastProbeAt: 0,
		latestNpmVersion: null,
		latestForgeVersion: null,
		dismissedNpmVersions: [],
		dismissedForgeVersions: [],
	};

	const ts = now();
	const ttlFresh = ts - cache.lastProbeAt < CACHE_TTL_MS;

	if (!ttlFresh) {
		const [npmRes, forgeRes] = await Promise.allSettled([probeNpm(fetchImpl), probeForge(fetchImpl)]);
		const nextNpm = npmRes.status === "fulfilled" && npmRes.value !== null ? npmRes.value : cache.latestNpmVersion;
		const nextForge =
			forgeRes.status === "fulfilled" && forgeRes.value !== null ? forgeRes.value : cache.latestForgeVersion;
		cache = {
			...cache,
			lastProbeAt: ts,
			latestNpmVersion: nextNpm,
			latestForgeVersion: nextForge,
		};
		try {
			await writeCache(cacheDir, cache);
		} catch (err) {
			debug("cache write failed:", err);
		}
	}

	const npmAvail =
		cache.latestNpmVersion &&
		semverGt(cache.latestNpmVersion, opts.currentCliVersion) &&
		!cache.dismissedNpmVersions.includes(cache.latestNpmVersion)
			? { current: opts.currentCliVersion, latest: cache.latestNpmVersion }
			: null;

	const forgeAvail =
		cache.latestForgeVersion &&
		semverGt(cache.latestForgeVersion, opts.currentBundledForgeVersion) &&
		!cache.dismissedForgeVersions.includes(cache.latestForgeVersion)
			? { current: opts.currentBundledForgeVersion, latest: cache.latestForgeVersion }
			: null;

	const banner = composeBanner(npmAvail, forgeAvail);
	if (banner) opts.notify(banner, "info");
}

export const __test__ = {
	CACHE_TTL_MS,
	cachePath,
	readCache,
	writeCache,
	semverGt,
	composeBanner,
};
