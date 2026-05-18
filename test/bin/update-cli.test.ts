// Unit tests for the forge update bin subcommand (Plan 15).
//
// Stubs: fetchImpl, globalRootResolver, upgradeRunner — all injected.
// pkgRootOverride mimics a globally-installed path so detectInstallMethod
// returns "global".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "../../src/bin/update-cli.js";
import type { UpgradeResult } from "../../src/extensions/forgecli/forge-update-command.js";

const GLOBAL_ROOT = "/usr/local/lib/node_modules";
const PKG_ROOT = `${GLOBAL_ROOT}/@entelligentsia/forgecli`;

function makeGlobalResolver(): () => Promise<string | null> {
	return () => Promise.resolve(GLOBAL_ROOT);
}

function makeNonGlobalResolver(): () => Promise<string | null> {
	return () => Promise.resolve(null);
}

type FetchLike = typeof fetch;

function makeFetch(tag: string, body = ""): FetchLike {
	return (() =>
		Promise.resolve({
			ok: true,
			json: () => Promise.resolve({ tag_name: tag, body }),
		} as Response)) as FetchLike;
}

function makeFailFetch(): FetchLike {
	return (() => Promise.resolve({ ok: false } as Response)) as FetchLike;
}

function makeUpgrader(ok: boolean): (spec: string) => Promise<UpgradeResult> {
	return (_spec) =>
		Promise.resolve(
			ok
				? { ok: true, stdout: "added 1 package", stderr: "" }
				: { ok: false, stdout: "", stderr: "EACCES permission denied" },
		);
}

describe("runUpdate", () => {
	let origNonInteractive: string | undefined;

	beforeEach(() => {
		origNonInteractive = process.env.FORGE_NON_INTERACTIVE;
		process.env.FORGE_NON_INTERACTIVE = "1"; // prevent readline prompts in tests
	});

	afterEach(() => {
		if (origNonInteractive === undefined) {
			delete process.env.FORGE_NON_INTERACTIVE;
		} else {
			process.env.FORGE_NON_INTERACTIVE = origNonInteractive;
		}
		vi.restoreAllMocks();
	});

	it("already up-to-date → exit 0", async () => {
		const exit = await runUpdate([], {
			forgeCli: "0.8.0",
			fetchImpl: makeFetch("v0.8.0"),
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: makeUpgrader(true),
			pkgRootOverride: PKG_ROOT,
		});
		expect(exit).toBe(0);
	});

	it("upgrade available + --check → exit 2", async () => {
		const exit = await runUpdate(["--check"], {
			forgeCli: "0.7.0",
			fetchImpl: makeFetch("v0.8.0"),
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: makeUpgrader(true),
			pkgRootOverride: PKG_ROOT,
		});
		expect(exit).toBe(2);
	});

	it("upgrade available + --yes → calls upgradeRunner once, exit 0", async () => {
		const spy = vi.fn(makeUpgrader(true));
		const exit = await runUpdate(["--yes"], {
			forgeCli: "0.7.0",
			fetchImpl: makeFetch("v0.8.0", "some release notes"),
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: spy,
			pkgRootOverride: PKG_ROOT,
		});
		expect(exit).toBe(0);
		expect(spy).toHaveBeenCalledOnce();
		expect(spy).toHaveBeenCalledWith("@entelligentsia/forgecli@0.8.0");
	});

	it("non-global install → exit 1 without calling upgradeRunner", async () => {
		const spy = vi.fn(makeUpgrader(true));
		const exit = await runUpdate([], {
			forgeCli: "0.7.0",
			fetchImpl: makeFetch("v0.8.0"),
			globalRootResolver: makeNonGlobalResolver(),
			upgradeRunner: spy,
			pkgRootOverride: "/home/user/projects/forgecli",
		});
		expect(exit).toBe(1);
		expect(spy).not.toHaveBeenCalled();
	});

	it("fetch failure → exit 1", async () => {
		const exit = await runUpdate(["--yes"], {
			forgeCli: "0.7.0",
			fetchImpl: makeFailFetch(),
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: makeUpgrader(true),
			pkgRootOverride: PKG_ROOT,
		});
		expect(exit).toBe(1);
	});

	it("npm i -g fails → exit 1", async () => {
		const exit = await runUpdate(["--yes"], {
			forgeCli: "0.7.0",
			fetchImpl: makeFetch("v0.8.0"),
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: makeUpgrader(false),
			pkgRootOverride: PKG_ROOT,
		});
		expect(exit).toBe(1);
	});

	it("--version override skips changelog fetch and up-to-date check", async () => {
		const spy = vi.fn(makeUpgrader(true));
		// current === latest but we're forcing --version 0.9.0
		const exit = await runUpdate(["--yes", "--version", "0.9.0"], {
			forgeCli: "0.9.0",
			fetchImpl: makeFailFetch(), // should not be called for the version check
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: spy,
			pkgRootOverride: PKG_ROOT,
		});
		// Even though current === forced version, isUpgrade check is skipped
		expect(exit).toBe(0);
		expect(spy).toHaveBeenCalledWith("@entelligentsia/forgecli@0.9.0");
	});

	it("unknown option → exit 1", async () => {
		const exit = await runUpdate(["--unknown-flag"], {
			forgeCli: "0.8.0",
			fetchImpl: makeFetch("v0.8.0"),
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: makeUpgrader(true),
			pkgRootOverride: PKG_ROOT,
		});
		expect(exit).toBe(1);
	});

	it("--version without value → exit 1", async () => {
		const exit = await runUpdate(["--version"], {
			forgeCli: "0.8.0",
			fetchImpl: makeFetch("v0.8.0"),
			globalRootResolver: makeGlobalResolver(),
			upgradeRunner: makeUpgrader(true),
			pkgRootOverride: PKG_ROOT,
		});
		expect(exit).toBe(1);
	});
});
