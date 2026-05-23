// store-cli-timeouts.test.ts — FORGE-S25-T17 (N-C-A)
//
// Unit tests for lib/store-cli-timeouts.ts: exported named timeout constants.

import { describe, expect, it } from "vitest";
import {
	STORE_CLI_TIMEOUT_MS,
	STORE_CLI_EMIT_TIMEOUT_MS,
} from "../../../../src/extensions/forgecli/lib/store-cli-timeouts.js";

describe("store-cli-timeouts (lib/store-cli-timeouts.ts)", () => {
	it("exports STORE_CLI_TIMEOUT_MS as 10_000", () => {
		expect(STORE_CLI_TIMEOUT_MS).toBe(10_000);
	});

	it("exports STORE_CLI_EMIT_TIMEOUT_MS as 10_000", () => {
		expect(STORE_CLI_EMIT_TIMEOUT_MS).toBe(10_000);
	});

	it("both constants are positive integers", () => {
		expect(Number.isInteger(STORE_CLI_TIMEOUT_MS)).toBe(true);
		expect(STORE_CLI_TIMEOUT_MS).toBeGreaterThan(0);
		expect(Number.isInteger(STORE_CLI_EMIT_TIMEOUT_MS)).toBe(true);
		expect(STORE_CLI_EMIT_TIMEOUT_MS).toBeGreaterThan(0);
	});
});
