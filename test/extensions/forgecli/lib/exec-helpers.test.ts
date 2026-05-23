// exec-helpers.test.ts — FORGE-S25-T18 (N-C-E) + FORGE-S25-T23 (B-4)
//
// Unit tests for lib/exec-helpers.ts: execFileAsync, ExecFileAsyncType,
// runTool, runToolAdvisory.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execFileAsync, runTool, runToolAdvisory } from "../../../../src/extensions/forgecli/lib/exec-helpers.js";
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

// ── runTool (FORGE-S25-T23) ──────────────────────────────────────────────────
// runTool(toolPath, argv, cwd) calls: execFileAsync("node", [toolPath, ...argv], {cwd})
// So toolPath is the script file passed to node, not the node binary itself.

describe("runTool", () => {
	it("resolves when the tool exits 0", async () => {
		// Use a tiny inline script written to a temp file — avoids platform shell quoting
		// runTool calls node with toolPath as the script argument
		const tmpScript = path.join(os.tmpdir(), "forge-t23-exit0.cjs");
		fs.writeFileSync(tmpScript, "process.exit(0);", "utf8");
		await expect(runTool(tmpScript, [], process.cwd(), 5000)).resolves.toBeUndefined();
		fs.unlinkSync(tmpScript);
	});

	it("throws a descriptive error when the tool exits non-zero", async () => {
		const tmpScript = path.join(os.tmpdir(), "forge-t23-exit1.cjs");
		fs.writeFileSync(tmpScript, "process.stderr.write('oops'); process.exit(1);", "utf8");
		await expect(runTool(tmpScript, [], process.cwd(), 5000)).rejects.toThrow("failed");
		fs.unlinkSync(tmpScript);
	});

	it("wraps the tool basename in the error message (not full path)", async () => {
		const tmpScript = path.join(os.tmpdir(), "my-tool.cjs");
		fs.writeFileSync(tmpScript, "process.exit(2);", "utf8");
		let caught: Error | undefined;
		try {
			await runTool(tmpScript, [], process.cwd(), 5000);
		} catch (e) {
			caught = e as Error;
		}
		fs.unlinkSync(tmpScript);
		expect(caught).toBeDefined();
		expect(caught?.message).toContain("my-tool.cjs");
	});
});

// ── runToolAdvisory (FORGE-S25-T23) ─────────────────────────────────────────

describe("runToolAdvisory", () => {
	function buildMockCtx() {
		return {
			ui: {
				notify: vi.fn(),
			},
		};
	}

	it("returns true when the tool succeeds", async () => {
		const tmpScript = path.join(os.tmpdir(), "forge-t23-advisory-ok.cjs");
		fs.writeFileSync(tmpScript, "process.exit(0);", "utf8");
		const ctx = buildMockCtx();
		const result = await runToolAdvisory(tmpScript, [], process.cwd(), ctx as never, "test-label", 5000);
		fs.unlinkSync(tmpScript);
		expect(result).toBe(true);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("returns false and notifies when the tool fails", async () => {
		const tmpScript = path.join(os.tmpdir(), "forge-t23-advisory-fail.cjs");
		fs.writeFileSync(tmpScript, "process.stderr.write('bad'); process.exit(1);", "utf8");
		const ctx = buildMockCtx();
		const result = await runToolAdvisory(tmpScript, [], process.cwd(), ctx as never, "my-step", 5000);
		fs.unlinkSync(tmpScript);
		expect(result).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledOnce();
		const [message, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(message).toContain("my-step");
		expect(level).toBe("warning");
	});

	it("regression: was inline in forge-init.ts, now exported from lib/exec-helpers.ts (B-4)", () => {
		// This test fails if runToolAdvisory is not exported from lib/exec-helpers.
		// It documents the migration so any revert is caught.
		expect(typeof runToolAdvisory).toBe("function");
	});
});
