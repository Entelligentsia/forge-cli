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
import { fileURLToPath } from "node:url";
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
	pi: {
		registerCommand: (n: string, def: { description: string; handler: RegisteredCommand["handler"] }) => void;
		sendUserMessage: (text: string, opts?: { deliverAs?: string }) => void;
	};
	commands: Map<string, RegisteredCommand>;
} {
	const commands = new Map<string, RegisteredCommand>();
	const sentMessages: string[] = [];
	const pi = {
		registerCommand(name: string, def: { description: string; handler: RegisteredCommand["handler"] }) {
			commands.set(name, { name, description: def.description, handler: def.handler });
		},
		sendUserMessage(text: string, _opts?: { deliverAs?: string }) {
			sentMessages.push(text);
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
	it("returns version (from npm) and body (from GitHub tag) on success", async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce(jsonRes({ "dist-tags": { latest: "0.2.0" } }))
			.mockResolvedValueOnce(jsonRes({ body: "notes" }));
		const out = await fetchChangelog(f as unknown as typeof fetch);
		expect(out).toEqual({ tag: "v0.2.0", version: "0.2.0", body: "notes" });
	});

	it("returns null when the npm API responds non-ok", async () => {
		const f = vi.fn().mockResolvedValue(notOk());
		const out = await fetchChangelog(f as unknown as typeof fetch);
		expect(out).toBeNull();
	});

	it("returns null when npm fetch rejects (network failure)", async () => {
		const f = vi.fn().mockRejectedValue(new Error("ENETUNREACH"));
		const out = await fetchChangelog(f as unknown as typeof fetch);
		expect(out).toBeNull();
	});

	it("succeeds with empty body when GitHub tag release is not found", async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce(jsonRes({ "dist-tags": { latest: "0.2.0" } }))
			.mockResolvedValueOnce(notOk());
		const out = await fetchChangelog(f as unknown as typeof fetch);
		expect(out).toEqual({ tag: "v0.2.0", version: "0.2.0", body: "" });
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
		// fetchChangelog makes two requests: npm (version) then GitHub (body).
		// Fail the npm call when fetchOk:false or releaseTag:null — that's enough to short-circuit.
		const npmFails = overrides.fetchOk === false || overrides.releaseTag === null;
		const version = (overrides.releaseTag ?? "v0.2.0").replace(/^v/, "");
		const fetchImpl = npmFails
			? vi.fn().mockResolvedValue(notOk())
			: vi
					.fn()
					.mockResolvedValueOnce(jsonRes({ "dist-tags": { latest: version } }))
					.mockResolvedValueOnce(jsonRes({ body: overrides.releaseBody ?? "release notes" }))
					.mockResolvedValue(notOk());
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

	it("warns about non-global install but does not block migrations", async () => {
		const { cmd, ctx, fetchImpl, upgradeRunner } = setup({
			pkgRoot: "/home/u/src/forge-cli",
			globalRoot: "/usr/lib/node_modules",
		});
		await cmd.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [msg, level] = ctx.ui.notify.mock.calls[0]!;
		expect(level).toBe("warning");
		expect(msg).toContain("local-dev");
		expect(msg).toContain("project update");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(upgradeRunner).not.toHaveBeenCalled();
	});

	it("walks the full happy path: probe → confirm → upgrade → success notify", async () => {
		const { cmd, ctx, fetchImpl, upgradeRunner } = setup({ current: "0.1.0", releaseTag: "v0.2.0" });
		await cmd.handler("", ctx);
		expect(fetchImpl).toHaveBeenCalledTimes(2); // npm (version) + GitHub (body)
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(upgradeRunner).toHaveBeenCalledWith("@entelligentsia/forgecli@0.2.0");
		const lastNotify = ctx.ui.notify.mock.calls.at(-1)!;
		expect(lastNotify[0]).toContain("installed @entelligentsia/forgecli@0.2.0");
		expect(lastNotify[1]).toBe("info");
	});

	it("surfaces a warning when fetchChangelog returns null, then falls through to project update", async () => {
		const { cmd, ctx, upgradeRunner } = setup({ fetchOk: false });
		await cmd.handler("", ctx);
		// fetchChangelog failure is now a warning (not error) — handler still proceeds to project update
		const notifyMessages = ctx.ui.notify.mock.calls.map((c) => c[0] as string);
		expect(notifyMessages.some((m) => m.includes("could not reach the npm registry"))).toBe(true);
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

	it("emits a migration prompt when the bundled version changes (updated message §2C)", async () => {
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
		// §2C: drift message now says "Run /forge:update to apply project migrations"
		expect(msg).toContain("Run /forge:update");
		expect(msg).toContain("migrations");
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

// ── composeUpdateKickoff tests (FORGE-BUG-039) ─────────────────────────────
//
// Tests for the kickoff composition function that reads the plugin's update.md
// from the bundled payload and patches it for the forge-cli context.

describe("composeUpdateKickoff", () => {
	// Minimal update.md with all the anchors we patch
	const SAMPLE_UPDATE_MD = [
		"---",
		"name: update",
		"---",
		"",
		"# /forge:update",
		"",
		"## Locate plugin root",
		"",
		'FORGE_ROOT: !`echo "${CLAUDE_PLUGIN_ROOT}"`',
		"",
		"Detect install mode:",
		"",
		'IS_CANARY = FORGE_ROOT does not contain "/.claude/plugins/"',
		"",
		"- **Managed install** (`IS_CANARY` = false): plugin lives under the Claude Code",
		"  plugins directory (either `/.claude/plugins/cache/` or",
		"  `/.claude/plugins/marketplaces/`). Updated via the plugin manager.",
		"",
		"- **Canary / source install** (`IS_CANARY = true`): FORGE_ROOT is outside the",
		"  Claude Code plugins directory.",
		"",
		"Determine the distribution from FORGE_ROOT path:",
		"",
		"| FORGE_ROOT contains | Distribution |",
		"|---------------------|-------------|",
		"| `/cache/skillforge/forge/` | `forge@skillforge` |",
		"| `/marketplaces/skillforge/forge/` | `forge@skillforge` |",
		"| anything else | `forge@forge` / canary |",
		"",
		"Legacy fallback: if .forge/update-check-cache.json does not exist but a",
		"plugin-level cache does (`${CLAUDE_PLUGIN_DATA}/forge-plugin-data/update-check-cache.json`",
		"",
		"## Step 1 — Check for updates",
		"",
		'Read `$FORGE_ROOT/.claude-plugin/plugin.json`. Extract `"version"` → `LOCAL_VERSION`.',
		"",
		"## Step 2A — Plugin update available",
		"",
		"MIGRATIONS_URL = plugin.json → migrationsUrl",
		"",
		"## Step 2B — Project migration pending",
		"",
		"Read `$FORGE_ROOT/migrations.json` (local).",
		"",
		"## Step 3 — Verify installation",
		"",
		'FORGE_ROOT: !`echo "${CLAUDE_PLUGIN_ROOT}"`',
		"",
		"## Step 4 — Apply migrations",
		"",
		"Read `$FORGE_ROOT/migrations.json` (local — now updated after install).",
	].join("\n");

	const BUNDLE_ROOT = "/opt/forge-cli/dist/forge-payload";

	it("replaces CLAUDE_PLUGIN_ROOT with bundled payload path", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "local-dev",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		// Both occurrences of the directive should be replaced
		expect(result).not.toContain("CLAUDE_PLUGIN_ROOT");
		expect(result).toContain(BUNDLE_ROOT);
	});

	it("replaces CLAUDE_PLUGIN_DATA with bundled payload path", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "local-dev",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		expect(result).not.toContain("CLAUDE_PLUGIN_DATA");
		expect(result).toContain(`${BUNDLE_ROOT}/forge-plugin-data`);
	});

	it("patches migrations.json path from $FORGE_ROOT/migrations.json to $FORGE_ROOT/.schemas/migrations.json", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "local-dev",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		expect(result).not.toContain("$FORGE_ROOT/migrations.json");
		expect(result).toContain("$FORGE_ROOT/.schemas/migrations.json");
	});

	it("marks IS_CANARY as always true for forge-cli", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "local-dev",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		expect(result).toContain("IS_CANARY");
		expect(result).toContain("forge-cli: IS_CANARY is ALWAYS true");
	});

	it("sets DISTRIBUTION to forge@forge for forge-cli", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "local-dev",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		expect(result).toContain("forge-cli note");
		expect(result).toContain('DISTRIBUTION = "forge@forge"');
	});

	it("injects CLI preflight result before Step 1", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "global",
			upgraded: true,
			cliOldVersion: "0.18.0",
			cliNewVersion: "0.19.0",
			npmVersion: "0.19.0",
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		expect(result).toContain("## forge-cli: CLI Preflight Result");
		expect(result).toContain("Install method: **global**");
		expect(result).toContain("CLI upgraded: **0.18.0 → 0.19.0**");
		expect(result).toContain("LOCAL_VERSION (bundled forge): **0.51.3**");
		expect(result).toContain("Skip Step 2A");
		expect(result).toContain("Skip Step 3");
		// The CLI preflight section should appear before Step 1
		const preflightIdx = result.indexOf("## forge-cli: CLI Preflight Result");
		const step1Idx = result.indexOf("## Step 1");
		expect(preflightIdx).toBeLessThan(step1Idx);
	});

	it("shows no-upgrade result in CLI preflight for local-dev installs", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "local-dev",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		expect(result).toContain("No CLI upgrade needed");
		expect(result).not.toContain("CLI upgraded:");
	});

	it("shows npm fetch failure in CLI preflight", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "global",
			upgraded: false,
			npmFetchFailed: true,
			bundledForgeVersion: "0.51.3",
		});
		expect(result).toContain("Could not reach npm registry");
		expect(result).toContain("Could not reach registry");
	});

	it("preserves the rest of the update.md content unchanged", () => {
		const result = __test__.composeUpdateKickoff(SAMPLE_UPDATE_MD, BUNDLE_ROOT, {
			method: "local-dev",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		// Major structural elements should survive
		expect(result).toContain("## Step 1 — Check for updates");
		expect(result).toContain("## Step 2A — Plugin update available");
		expect(result).toContain("## Step 2B — Project migration pending");
		expect(result).toContain("## Step 3 — Verify installation");
		expect(result).toContain("## Step 4 — Apply migrations");
	});

	it("patches the real bundled update.md from the payload", async () => {
		// Read the actual update.md from the bundled payload and verify
		// all patches apply cleanly (no anchor missed)
		const fsSync = await import("node:fs");
		const payloadRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "dist", "forge-payload");
		const updateMdPath = path.join(payloadRoot, "commands", "update.md");
		if (!fsSync.existsSync(updateMdPath)) {
			// Payload not built yet in CI — skip gracefully
			return;
		}
		const updateMd = fsSync.readFileSync(updateMdPath, "utf8");
		const result = __test__.composeUpdateKickoff(updateMd, "/test/bundle/root", {
			method: "global",
			upgraded: false,
			npmFetchFailed: false,
			bundledForgeVersion: "0.51.3",
		});
		// All CLAUDE_PLUGIN_ROOT references gone
		expect(result).not.toContain("CLAUDE_PLUGIN_ROOT");
		// All $FORGE_ROOT/migrations.json patched
		expect(result).not.toContain("$FORGE_ROOT/migrations.json");
		expect(result).toContain("$FORGE_ROOT/.schemas/migrations.json");
		// CLI preflight section present
		expect(result).toContain("## forge-cli: CLI Preflight Result");
	});
});

// ── Drift notification message test (§2C) ─────────────────────────────────

describe("drift notification message", () => {
	it("contains 'Run /forge:update' and 'migrations' (§2C)", async () => {
		const notify = vi.fn();
		const cacheDir = tmpCacheDir();
		try {
			await __test__.writeDriftCache(cacheDir, {
				lastSeenBundledForgeVersion: "0.43.0",
				promptedForVersions: [],
			});
			await checkBundledForgeDrift({ currentBundledForgeVersion: "0.44.0", notify, cacheDir });
			const [msg] = notify.mock.calls[0]!;
			expect(msg).toContain("Run /forge:update");
			expect(msg).toContain("migrations");
			expect(msg).toContain("v0.43.0");
			expect(msg).toContain("v0.44.0");
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});
});
