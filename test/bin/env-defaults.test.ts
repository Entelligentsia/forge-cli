import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyForgeOwnedEnvDefaults } from "../../src/bin/env-defaults.js";

describe("applyForgeOwnedEnvDefaults", () => {
	const VARS = ["PI_SKIP_VERSION_CHECK", "PI_SKIP_PACKAGE_UPDATE_CHECK"] as const;
	const saved: Partial<Record<(typeof VARS)[number], string>> = {};

	beforeEach(() => {
		for (const v of VARS) {
			saved[v] = process.env[v];
			delete process.env[v];
		}
	});

	afterEach(() => {
		for (const v of VARS) {
			if (saved[v] === undefined) {
				delete process.env[v];
			} else {
				process.env[v] = saved[v];
			}
		}
	});

	it("sets PI_SKIP_VERSION_CHECK=1", () => {
		applyForgeOwnedEnvDefaults();
		expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
	});

	it("sets PI_SKIP_PACKAGE_UPDATE_CHECK=1", () => {
		applyForgeOwnedEnvDefaults();
		expect(process.env.PI_SKIP_PACKAGE_UPDATE_CHECK).toBe("1");
	});

	it("overwrites any pre-existing value", () => {
		process.env.PI_SKIP_VERSION_CHECK = "0";
		process.env.PI_SKIP_PACKAGE_UPDATE_CHECK = "0";
		applyForgeOwnedEnvDefaults();
		expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
		expect(process.env.PI_SKIP_PACKAGE_UPDATE_CHECK).toBe("1");
	});
});
