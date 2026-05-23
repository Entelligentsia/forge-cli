// exec-helpers.test.ts — FORGE-S25-T18 (N-C-E)
//
// Unit tests for lib/exec-helpers.ts: execFileAsync and ExecFileAsyncType.

import { describe, expect, it } from "vitest";
import { execFileAsync } from "../../../../src/extensions/forgecli/lib/exec-helpers.js";
import type { ExecFileAsyncType } from "../../../../src/extensions/forgecli/lib/exec-helpers.js";

describe("execFileAsync", () => {
	it("is a function", () => {
		expect(typeof execFileAsync).toBe("function");
	});

	it("resolves with stdout for a successful command", async () => {
		const result = await execFileAsync("node", ["--version"], { encoding: "utf8" });
		expect(result.stdout).toMatch(/^v\d+\./);
	});

	it("rejects for a non-existent command", async () => {
		await expect(execFileAsync("node", ["--eval", "process.exit(1)"])).rejects.toThrow();
	});
});

describe("ExecFileAsyncType", () => {
	it("can be used to annotate a variable holding execFileAsync", () => {
		// Type-level check: the import must compile without error.
		const fn: ExecFileAsyncType = execFileAsync;
		expect(typeof fn).toBe("function");
	});
});

describe("regression: export shape is compatible with forge-tools.ts consumer", () => {
	it("execFileAsync from lib/exec-helpers matches the shape previously declared in forge-tools.ts", async () => {
		// Before T18, forge-tools.ts declared: const execFileAsync = promisify(execFile)
		// This test verifies that the exported function has the same observable behaviour.
		const result = await execFileAsync("node", ["-e", "process.stdout.write('hello')"], {
			encoding: "utf8",
		});
		expect(result.stdout).toBe("hello");
	});
});
