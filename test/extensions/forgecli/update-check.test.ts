// Unit tests for update-check module — FORGE-S16-T14.
//
// Coverage:
//   1. opt-out env (FORGE_NO_UPDATE_CHECK)
//   2. TTL gate (fresh cache short-circuits HTTP)
//   3. TTL miss triggers both probes
//   4. Dual-probe success → banner with both lines
//   5. Dual-probe partial failure → banner with one line, cache preserves
//      prior latestForgeVersion
//   6. Per-version dismissal suppresses banner
//   7. Network failure → no banner, cache lastProbeAt updated
//   8. No update available → no banner
//   9. semverGt unit table

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test__, triggerUpdateCheck, type UpdateBannerCache } from "../../../src/extensions/forgecli/update-check.js";

function tmpCacheDir(): string {
	return path.join(os.tmpdir(), `forgecli-update-test-${crypto.randomBytes(6).toString("hex")}`);
}

function jsonRes<T>(body: T): Response {
	return {
		ok: true,
		status: 200,
		async json() {
			return body;
		},
	} as unknown as Response;
}

function notOk(): Response {
	return {
		ok: false,
		status: 500,
		async json() {
			return {};
		},
	} as unknown as Response;
}

async function writeCacheFile(dir: string, cache: UpdateBannerCache): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(__test__.cachePath(dir), JSON.stringify(cache), "utf8");
}

const PRIOR_ENV = { ...process.env };

beforeEach(() => {
	delete process.env.FORGE_NO_UPDATE_CHECK;
	delete process.env.FORGE_DEBUG_UPDATE_CHECK;
});

afterEach(async () => {
	process.env = { ...PRIOR_ENV };
	vi.restoreAllMocks();
});

describe("triggerUpdateCheck — opt-out", () => {
	it("returns immediately when FORGE_NO_UPDATE_CHECK=1", async () => {
		process.env.FORGE_NO_UPDATE_CHECK = "1";
		const notify = vi.fn();
		const fetchImpl = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: tmpCacheDir(),
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("triggerUpdateCheck — TTL gate", () => {
	it("uses cached versions when within TTL", async () => {
		const dir = tmpCacheDir();
		const fixedNow = 1_700_000_000_000;
		await writeCacheFile(dir, {
			lastProbeAt: fixedNow - 60 * 60 * 1000, // 1h ago
			latestNpmVersion: "0.2.0",
			latestForgeVersion: "0.41.0",
			dismissedNpmVersions: [],
			dismissedForgeVersions: [],
		});

		const notify = vi.fn();
		const fetchImpl = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			now: () => fixedNow,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		const msg = notify.mock.calls[0]![0] as string;
		expect(msg).toContain("0.1.0 → 0.2.0");
		expect(msg).toContain("0.40.3 → 0.41.0");
	});

	it("probes both endpoints when cache stale", async () => {
		const dir = tmpCacheDir();
		const fixedNow = 1_700_000_000_000;
		await writeCacheFile(dir, {
			lastProbeAt: fixedNow - 25 * 60 * 60 * 1000,
			latestNpmVersion: "0.1.0",
			latestForgeVersion: "0.40.3",
			dismissedNpmVersions: [],
			dismissedForgeVersions: [],
		});

		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("registry.npmjs.org")) return jsonRes({ "dist-tags": { latest: "0.2.0" } });
			return jsonRes({ tag_name: "v0.41.0" });
		});
		const notify = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			now: () => fixedNow,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledOnce();
	});
});

describe("triggerUpdateCheck — dual probe", () => {
	it("composes banner with both lines when both newer", async () => {
		const dir = tmpCacheDir();
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("registry.npmjs.org")) return jsonRes({ "dist-tags": { latest: "0.2.0" } });
			return jsonRes({ tag_name: "v0.41.0" });
		});
		const notify = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		const msg = notify.mock.calls[0]![0] as string;
		expect(msg).toMatch(/forge-cli: update available — 0\.1\.0 → 0\.2\.0/);
		expect(msg).toMatch(/forge plugin: update available — 0\.40\.3 → 0\.41\.0/);

		const cache = await __test__.readCache(dir);
		expect(cache?.latestNpmVersion).toBe("0.2.0");
		expect(cache?.latestForgeVersion).toBe("0.41.0");
	});

	it("partial failure preserves prior latestForgeVersion", async () => {
		const dir = tmpCacheDir();
		await writeCacheFile(dir, {
			lastProbeAt: 0,
			latestNpmVersion: null,
			latestForgeVersion: "0.40.3",
			dismissedNpmVersions: [],
			dismissedForgeVersions: [],
		});

		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("registry.npmjs.org")) return jsonRes({ "dist-tags": { latest: "0.2.0" } });
			throw new Error("github down");
		});
		const notify = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});

		const msg = notify.mock.calls[0]![0] as string;
		expect(msg).toMatch(/forge-cli: update available/);
		expect(msg).not.toMatch(/forge plugin: update available/);

		const cache = await __test__.readCache(dir);
		expect(cache?.latestNpmVersion).toBe("0.2.0");
		expect(cache?.latestForgeVersion).toBe("0.40.3"); // preserved
	});
});

describe("triggerUpdateCheck — dismissal", () => {
	it("suppresses banner for dismissed npm version", async () => {
		const dir = tmpCacheDir();
		await writeCacheFile(dir, {
			lastProbeAt: Date.now() - 1000,
			latestNpmVersion: "0.2.0",
			latestForgeVersion: "0.40.3",
			dismissedNpmVersions: ["0.2.0"],
			dismissedForgeVersions: [],
		});

		const notify = vi.fn();
		const fetchImpl = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		expect(notify).not.toHaveBeenCalled();
	});

	it("emits banner when latest differs from dismissed version", async () => {
		const dir = tmpCacheDir();
		await writeCacheFile(dir, {
			lastProbeAt: Date.now() - 1000,
			latestNpmVersion: "0.3.0",
			latestForgeVersion: "0.40.3",
			dismissedNpmVersions: ["0.2.0"],
			dismissedForgeVersions: [],
		});

		const notify = vi.fn();
		const fetchImpl = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		expect(notify).toHaveBeenCalledOnce();
	});
});

describe("triggerUpdateCheck — failure modes", () => {
	it("network failure → no banner, cache lastProbeAt still updated", async () => {
		const dir = tmpCacheDir();
		const fetchImpl = vi.fn(async () => {
			throw new Error("offline");
		});
		const notify = vi.fn();
		const fixedNow = 1_700_000_000_000;
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			now: () => fixedNow,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		expect(notify).not.toHaveBeenCalled();
		const cache = await __test__.readCache(dir);
		expect(cache?.lastProbeAt).toBe(fixedNow);
		expect(cache?.latestNpmVersion).toBeNull();
	});

	it("non-ok HTTP responses are treated as failure", async () => {
		const dir = tmpCacheDir();
		const fetchImpl = vi.fn(async () => notOk());
		const notify = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		expect(notify).not.toHaveBeenCalled();
	});

	it("no update available → no banner", async () => {
		const dir = tmpCacheDir();
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("registry.npmjs.org")) return jsonRes({ "dist-tags": { latest: "0.1.0" } });
			return jsonRes({ tag_name: "0.40.3" });
		});
		const notify = vi.fn();
		await triggerUpdateCheck({
			notify,
			currentCliVersion: "0.1.0",
			currentBundledForgeVersion: "0.40.3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			cacheDir: dir,
		});
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("semverGt", () => {
	it("returns expected results for the unit table", () => {
		expect(__test__.semverGt("1.2.4", "1.2.3")).toBe(true);
		expect(__test__.semverGt("1.0.0", "0.9.9")).toBe(true);
		expect(__test__.semverGt("2.0.0", "1.99.99")).toBe(true);
		expect(__test__.semverGt("1.2.3", "1.2.3")).toBe(false);
		expect(__test__.semverGt("1.2.3", "1.2.4")).toBe(false);
		expect(__test__.semverGt("v1.2.4", "1.2.3")).toBe(true);
		expect(__test__.semverGt("0.40.3-alpha", "0.40.3")).toBe(false);
		expect(__test__.semverGt("notaversion", "1.0.0")).toBe(false);
	});
});

describe("composeBanner", () => {
	it("returns null when both args null", () => {
		expect(__test__.composeBanner(null, null)).toBeNull();
	});

	it("returns single line when only npm available", () => {
		const out = __test__.composeBanner({ current: "0.1.0", latest: "0.2.0" }, null);
		expect(out).toMatch(/forge-cli/);
		expect(out).not.toMatch(/forge plugin/);
	});
});
