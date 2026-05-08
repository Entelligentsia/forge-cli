// Unit tests for forge-update-command — FORGE-S16-T15.
//
// Coverage:
//   1. detectInstallMethod — global, npx, local-dev paths
//   2. handler refuses non-global installs (warning notify)
//   3. composeChangelogSummary contains current/latest/run line
//   4. isUpgrade semver triple comparisons
//   5. handler full happy path (probe → confirm → upgrade success)
//   6. handler aborts when fetchChangelog returns null
//   7. handler skips upgrade when already on latest
//   8. handler cancels gracefully when confirm returns false
//   9. handler reports npm i -g failure
//  10. checkBundledForgeDrift first-run primes cache, no banner
//  11. checkBundledForgeDrift detects drift and prompts
//  12. checkBundledForgeDrift idempotent — no re-prompt for same version
//  13. fetchChangelog returns null on non-ok response

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__test__,
	checkBundledForgeDrift,
	composeChangelogSummary,
	detectInstallMethod,
	fetchChangelog,
	isUpgrade,
	registerForgeUpdateCommand,
} from "../../../src/extensions/forgecli/forge-update-command.js";

function tmpCacheDir(): string {
	return path.join(os.tmpdir(), `forgecli-update-cmd-test-${crypto.randomBytes(6).toString("hex")}`);
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

interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
}

interface MockCtx {
	ui: MockUI;
	hasUI: boolean;
}

function makeCtx(confirmAnswer = true): MockCtx {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			confirm: vi.fn().mockResolvedValue(confirmAnswer),
		},
		hasUI: true,
	};
}

interface RegisteredCommand {
	name: string;
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

function makePi(): {
	pi: { registerCommand: (n: string, def: { description: string; handler: RegisteredCommand["handler"] }) => void };
	commands: Map<string, RegisteredCommand>;
} {
	const commands = new Map<string, RegisteredCommand>();
	const pi = {
		registerCommand(name: string, def: { description: string; handler: RegisteredCommand["handler"] }) {
			commands.set(name, { name, description: def.description, handler: def.handler });
		},
	};
	return { pi: pi as unknown as Parameters<typeof registerForgeUpdateCommand>[0], commands };
}

describe("detectInstallMethod", () => {
	it("classifies npm-global install when pkgRoot lives under globalRoot", () => {
		expect(
			detectInstallMethod({
				pkgRoot: "/usr/lib/node_modules/@entelligentsia/forgecli",
				globalRoot: "/usr/lib/node_modules",
			}),
		).toBe("global");
	});

	it("classifies npx invocations via _npx path segment", () => {
		expect(
			detectInstallMethod({
				pkgRoot: "/home/u/.npm/_npx/abc123/node_modules/@entelligentsia/forgecli",
				globalRoot: "/usr/lib/node_modules",
			}),
		).toBe("npx");
	});

	it("classifies anything outside globalRoot and not npx as local-dev", () => {
		expect(
			detectInstallMethod({
				pkgRoot: "/home/u/src/forge-cli",
				globalRoot: "/usr/lib/node_modules",
			}),
		).toBe("local-dev");
	});

	it("falls back to local-dev when globalRoot is null", () => {
		expect(detectInstallMethod({ pkgRoot: "/anywhere", globalRoot: null })).toBe("local-dev");
	});
});

describe("isUpgrade", () => {
	it.each([
		["0.1.0", "0.1.1", true],
		["0.1.0", "0.2.0", true],
		["0.9.9", "1.0.0", true],
		["1.0.0", "1.0.0", false],
		["1.0.0", "0.9.9", false],
		["v0.1.0", "0.1.1", true],
	])("isUpgrade(%s → %s) === %s", (cur, lat, want) => {
		expect(isUpgrade(cur, lat)).toBe(want);
	});

	it("returns false on unparseable inputs", () => {
		expect(isUpgrade("foo", "0.1.0")).toBe(false);
		expect(isUpgrade("0.1.0", "foo")).toBe(false);
	});
});

describe("composeChangelogSummary", () => {
	it("includes current, latest, and the npm install line", () => {
		const out = composeChangelogSummary("0.1.0", "0.2.0", "Major refactor.");
		expect(out).toContain("Current: 0.1.0");
		expect(out).toContain("Latest:  0.2.0");
		expect(out).toContain("npm i -g @entelligentsia/forgecli@0.2.0");
		expect(out).toContain("Major refactor.");
	});

	it("substitutes a placeholder when release body is empty", () => {
		const out = composeChangelogSummary("0.1.0", "0.2.0", "   ");
		expect(out).toContain("(release body empty)");
	});

	it("truncates very long bodies", () => {
		const huge = "x".repeat(2000);
		const out = composeChangelogSummary("0.1.0", "0.2.0", huge);
		expect(out).toContain("…");
		expect(out.length).toBeLessThan(huge.length);
	});
});

describe("fetchChangelog", () => {
	it("returns version, tag, and body on a successful release fetch", async () => {
		const f = vi.fn().mockResolvedValue(jsonRes({ tag_name: "v0.2.0", body: "notes" }));
		const out = await fetchChangelog(f as unknown as typeof fetch);
		expect(out).toEqual({ tag: "v0.2.0", version: "0.2.0", body: "notes" });
	});

	it("returns null when the API responds non-ok", async () => {
		const f = vi.fn().mockResolvedValue(notOk());
		const out = await fetchChangelog(f as unknown as typeof fetch);
		expect(out).toBeNull();
	});

	it("returns null when fetch rejects (network failure)", async () => {
		const f = vi.fn().mockRejectedValue(new Error("ENETUNREACH"));
		const out = await fetchChangelog(f as unknown as typeof fetch);
		expect(out).toBeNull();
	});
});

describe("registerForgeUpdateCommand handler", () => {
	function setup(
		overrides: {
			pkgRoot?: string;
			current?: string;
			globalRoot?: string | null;
			releaseTag?: string | null;
			releaseBody?: string;
			fetchOk?: boolean;
			confirmAnswer?: boolean;
			upgradeOk?: boolean;
			upgradeStderr?: string;
		} = {},
	) {
		const { pi, commands } = makePi();
		const fetchImpl = vi.fn().mockResolvedValue(
			overrides.fetchOk === false
				? notOk()
				: overrides.releaseTag === null
					? notOk()
					: jsonRes({
							tag_name: overrides.releaseTag ?? "v0.2.0",
							body: overrides.releaseBody ?? "release notes",
						}),
		);
		const upgradeRunner = vi.fn().mockResolvedValue({
			ok: overrides.upgradeOk !== false,
			stdout: "added 1 package",
			stderr: overrides.upgradeStderr ?? "",
		});
		const globalRootResolver = vi
			.fn()
			.mockResolvedValue(overrides.globalRoot === undefined ? "/usr/lib/node_modules" : overrides.globalRoot);
		registerForgeUpdateCommand(pi, {
			pkgRoot: overrides.pkgRoot ?? "/usr/lib/node_modules/@entelligentsia/forgecli",
			currentCliVersion: overrides.current ?? "0.1.0",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			globalRootResolver,
			upgradeRunner,
		});
		const cmd = commands.get("forge:update")!;
		expect(cmd).toBeDefined();
		const ctx = makeCtx(overrides.confirmAnswer ?? true);
		return { cmd, ctx, fetchImpl, upgradeRunner, globalRootResolver };
	}

	it("registers /forge:update with the expected name and description", () => {
		const { cmd } = setup();
		expect(cmd.name).toBe("forge:update");
		expect(cmd.description).toContain("Guided upgrade");
	});

	it("refuses non-global install with a warning notify and skips fetch", async () => {
		const { cmd, ctx, fetchImpl, upgradeRunner } = setup({
			pkgRoot: "/home/u/src/forge-cli",
			globalRoot: "/usr/lib/node_modules",
		});
		await cmd.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [msg, level] = ctx.ui.notify.mock.calls[0]!;
		expect(level).toBe("warning");
		expect(msg).toContain("local-dev");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(upgradeRunner).not.toHaveBeenCalled();
	});

	it("walks the full happy path: probe → confirm → upgrade → success notify", async () => {
		const { cmd, ctx, fetchImpl, upgradeRunner } = setup({ current: "0.1.0", releaseTag: "v0.2.0" });
		await cmd.handler("", ctx);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(upgradeRunner).toHaveBeenCalledWith("@entelligentsia/forgecli@0.2.0");
		const lastNotify = ctx.ui.notify.mock.calls.at(-1)!;
		expect(lastNotify[0]).toContain("installed @entelligentsia/forgecli@0.2.0");
		expect(lastNotify[1]).toBe("info");
	});

	it("surfaces an error notify when fetchChangelog returns null", async () => {
		const { cmd, ctx, upgradeRunner } = setup({ fetchOk: false });
		await cmd.handler("", ctx);
		const [, level] = ctx.ui.notify.mock.calls.at(-1)!;
		expect(level).toBe("error");
		expect(upgradeRunner).not.toHaveBeenCalled();
	});

	it("skips the upgrade when current version already equals or exceeds latest", async () => {
		const { cmd, ctx, upgradeRunner } = setup({ current: "0.2.0", releaseTag: "v0.2.0" });
		await cmd.handler("", ctx);
		expect(upgradeRunner).not.toHaveBeenCalled();
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("already at the latest");
	});

	it("aborts when the user declines the confirm dialog", async () => {
		const { cmd, ctx, upgradeRunner } = setup({ confirmAnswer: false });
		await cmd.handler("", ctx);
		expect(upgradeRunner).not.toHaveBeenCalled();
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("cancelled");
	});

	it("reports npm i -g failure with stderr in the error notify", async () => {
		const { cmd, ctx } = setup({ upgradeOk: false, upgradeStderr: "EACCES: permission denied" });
		await cmd.handler("", ctx);
		const [msg, level] = ctx.ui.notify.mock.calls.at(-1)!;
		expect(level).toBe("error");
		expect(msg).toContain("EACCES");
	});
});

describe("checkBundledForgeDrift", () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpCacheDir();
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("primes the cache on first run and emits no banner", async () => {
		const notify = vi.fn();
		await checkBundledForgeDrift({ currentBundledForgeVersion: "0.40.3", notify, cacheDir: dir });
		expect(notify).not.toHaveBeenCalled();
		const cache = await __test__.readDriftCache(dir);
		expect(cache.lastSeenBundledForgeVersion).toBe("0.40.3");
	});

	it("emits a migration prompt when the bundled version changes", async () => {
		await __test__.writeDriftCache(dir, {
			lastSeenBundledForgeVersion: "0.40.3",
			promptedForVersions: [],
		});
		const notify = vi.fn();
		await checkBundledForgeDrift({ currentBundledForgeVersion: "0.41.0", notify, cacheDir: dir });
		expect(notify).toHaveBeenCalledTimes(1);
		const [msg, level] = notify.mock.calls[0]!;
		expect(level).toBe("info");
		expect(msg).toContain("0.40.3 → 0.41.0");
		const cache = await __test__.readDriftCache(dir);
		expect(cache.lastSeenBundledForgeVersion).toBe("0.41.0");
		expect(cache.promptedForVersions).toContain("0.41.0");
	});

	it("does not re-prompt for the same version on subsequent runs", async () => {
		await __test__.writeDriftCache(dir, {
			lastSeenBundledForgeVersion: "0.40.3",
			promptedForVersions: [],
		});
		const notify = vi.fn();
		await checkBundledForgeDrift({ currentBundledForgeVersion: "0.41.0", notify, cacheDir: dir });
		await checkBundledForgeDrift({ currentBundledForgeVersion: "0.41.0", notify, cacheDir: dir });
		expect(notify).toHaveBeenCalledTimes(1);
	});
});
