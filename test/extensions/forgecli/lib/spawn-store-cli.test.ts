// spawn-store-cli.test.ts — FORGE-S25-T17 (C-1, C-17, N-C-A)
//
// Unit tests for lib/spawn-store-cli.ts:
//   - spawnStoreCliEmit, spawnStoreCliRead, spawnStoreCliValidate
//   - argv array discipline (IL6: no shell interpolation)
//   - timeout wiring (N-C-A: emit calls carry STORE_CLI_EMIT_TIMEOUT_MS)
//   - error paths surface correctly (fail-open vs fail-closed per wrapper)

import * as childProcess from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	spawnStoreCliEmit,
	spawnStoreCliRead,
	spawnStoreCliValidate,
} from "../../../../src/extensions/forgecli/lib/spawn-store-cli.js";
import {
	STORE_CLI_EMIT_TIMEOUT_MS,
	STORE_CLI_TIMEOUT_MS,
} from "../../../../src/extensions/forgecli/lib/store-cli-timeouts.js";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(childProcess.spawnSync);

function makeSpawnResult(status: number, stdout: string, stderr: string) {
	return {
		status,
		stdout,
		stderr,
		pid: 1,
		output: [null, Buffer.from(stdout), Buffer.from(stderr)],
		signal: null,
		error: undefined,
	} as unknown as ReturnType<typeof childProcess.spawnSync>;
}

beforeEach(() => {
	mockSpawnSync.mockReset();
});

describe("spawnStoreCliEmit", () => {
	it("calls spawnSync with argv array — no shell interpolation", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, "", ""));
		const storeCli = "/forge/tools/store-cli.cjs";
		const sprintId = "FORGE-S25";
		const event = { type: "plan", taskId: "FORGE-S25-T17" };
		spawnStoreCliEmit(storeCli, sprintId, event, "/project");
		expect(mockSpawnSync).toHaveBeenCalledOnce();
		const [cmd, args, opts] = mockSpawnSync.mock.calls[0] as [string, string[], Record<string, unknown>];
		expect(cmd).toBe(process.execPath);
		expect(args).toEqual([storeCli, "emit", sprintId, JSON.stringify(event)]);
		expect(opts.cwd).toBe("/project");
		expect(opts.timeout).toBe(STORE_CLI_EMIT_TIMEOUT_MS);
	});

	it("returns ok=false when spawnSync exits non-zero", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(1, "", "emit failed"));
		const result = spawnStoreCliEmit("/fake/store-cli.cjs", "FORGE-S25", {}, "/project");
		expect(result.ok).toBe(false);
		expect(result.stderr).toBe("emit failed");
	});

	it("returns ok=true on exit 0", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, "{}", ""));
		const result = spawnStoreCliEmit("/fake/store-cli.cjs", "FORGE-S25", {}, "/project");
		expect(result.ok).toBe(true);
	});
});

describe("spawnStoreCliRead", () => {
	it("calls spawnSync with correct argv for read", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, '{"status":"plan-approved"}', ""));
		const storeCli = "/forge/tools/store-cli.cjs";
		spawnStoreCliRead(storeCli, "task", "FORGE-S25-T17", "/project");
		const [cmd, args, opts] = mockSpawnSync.mock.calls[0] as [string, string[], Record<string, unknown>];
		expect(cmd).toBe(process.execPath);
		expect(args).toEqual([storeCli, "read", "task", "FORGE-S25-T17"]);
		expect(opts.cwd).toBe("/project");
		expect(opts.timeout).toBe(STORE_CLI_TIMEOUT_MS);
	});

	it("returns null when spawnSync exits non-zero (fail-open)", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(1, "", "not found"));
		const result = spawnStoreCliRead("/fake/store-cli.cjs", "task", "FORGE-S25-T17", "/project");
		expect(result).toBeNull();
	});

	it("returns parsed JSON on success", () => {
		const record = { taskId: "FORGE-S25-T17", status: "plan-approved" };
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, JSON.stringify(record), ""));
		const result = spawnStoreCliRead("/fake/store-cli.cjs", "task", "FORGE-S25-T17", "/project");
		expect(result).toEqual(record);
	});

	it("returns null when stdout is unparseable JSON", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, "NOT JSON", ""));
		const result = spawnStoreCliRead("/fake/store-cli.cjs", "task", "FORGE-S25-T17", "/project");
		expect(result).toBeNull();
	});
});

describe("spawnStoreCliValidate", () => {
	it("calls spawnSync with entity and payload as argv elements", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, "", ""));
		const storeCli = "/forge/tools/store-cli.cjs";
		const payload = { taskId: "FORGE-S25-T17", status: "plan-approved" };
		spawnStoreCliValidate(storeCli, "task", payload, "/project");
		const [cmd, args, opts] = mockSpawnSync.mock.calls[0] as [string, string[], Record<string, unknown>];
		expect(cmd).toBe(process.execPath);
		expect(args).toEqual([storeCli, "validate", "task", JSON.stringify(payload)]);
		expect(opts.cwd).toBe("/project");
		expect(opts.timeout).toBe(STORE_CLI_TIMEOUT_MS);
	});

	it("returns ok=false with reason on non-zero exit", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(1, "", "schema violation"));
		const result = spawnStoreCliValidate("/fake/store-cli.cjs", "task", {}, "/project");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("schema violation");
	});

	it("returns ok=true on exit 0", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, "", ""));
		const result = spawnStoreCliValidate("/fake/store-cli.cjs", "task", {}, "/project");
		expect(result.ok).toBe(true);
	});

	it("accepts a string payload and passes it unchanged", () => {
		mockSpawnSync.mockReturnValueOnce(makeSpawnResult(0, "", ""));
		const storeCli = "/forge/tools/store-cli.cjs";
		const rawPayload = '{"taskId":"FORGE-S25-T17"}';
		spawnStoreCliValidate(storeCli, "task", rawPayload, "/project");
		const [, args] = mockSpawnSync.mock.calls[0] as [string, string[], Record<string, unknown>];
		expect(args[3]).toBe(rawPayload);
	});
});
