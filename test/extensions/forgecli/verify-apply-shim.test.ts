// verify-apply-shim.test.ts
// Verify that buildForgeVerifyApply calls verify-apply.cjs with the correct
// claimed paths as argv (FORGE-S26-T16 shim conversion).

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("forge_verify_apply shim (FORGE-S26-T16)", () => {
	it("returns error when verify-apply.cjs is not found", async () => {
		const { registerForgeTools } = await import("../../../src/extensions/forgecli/forge-tools.js");

		// Build a minimal pi mock
		const registeredTools: Map<string, import("@earendil-works/pi-coding-agent").ToolDefinition> = new Map();
		const piMock = {
			registerTool: (def: import("@earendil-works/pi-coding-agent").ToolDefinition) =>
				registeredTools.set(def.name, def),
			on: vi.fn(),
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

		// Use a non-existent toolDir so verify-apply.cjs won't be found
		const fakeForgePath = "/non-existent/path/that/does/not/exist/forge";
		const fakeProjectRoot = "/tmp";
		registerForgeTools(piMock, fakeForgePath, fakeProjectRoot);

		const verifyApplyTool = registeredTools.get("forge_verify_apply");
		expect(verifyApplyTool).toBeDefined();

		const result = await verifyApplyTool!.execute("test-call", { claimed_paths: ["some/file.md"] }, undefined, undefined, undefined as never);
		// Should return error because verify-apply.cjs doesn't exist at the fake path
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect((result.content as Array<{ text: string }>)[0].text).toContain("verify-apply.cjs not found");
	});

	it("calls verify-apply.cjs with claimed paths as argv", async () => {
		// This test verifies the argv structure by intercepting execFileAsync.
		const execHelpersMod = await import("../../../src/extensions/forgecli/lib/exec-helpers.js");
		const execSpy = vi
			.spyOn(execHelpersMod, "execFileAsync")
			.mockResolvedValue({ stdout: '{"modified":["a.md"],"unchanged":[],"untracked":[],"missing":[]}', stderr: "" });

		try {
			const { registerForgeTools } = await import("../../../src/extensions/forgecli/forge-tools.js");

			const registeredTools: Map<string, import("@earendil-works/pi-coding-agent").ToolDefinition> = new Map();
			const piMock = {
				registerTool: (def: import("@earendil-works/pi-coding-agent").ToolDefinition) =>
					registeredTools.set(def.name, def),
				on: vi.fn(),
			} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

			// Use a path where verify-apply.cjs would "exist" from forge-tools' perspective.
			// Since existsSync runs before execFileAsync, we need the file to exist.
			// The installed plugin payload has verify-apply.cjs so use the actual forge payload:
			// Instead, let's mock the entire tool resolution by using a tmpDir with the file.
			const os = await import("node:os");
			const fs = await import("node:fs");
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-apply-shim-"));
			const toolsDir = path.join(tmpDir, "tools");
			fs.mkdirSync(toolsDir, { recursive: true });
			// Create a stub verify-apply.cjs so existsSync returns true
			fs.writeFileSync(path.join(toolsDir, "verify-apply.cjs"), "// stub", "utf8");

			try {
				registerForgeTools(piMock, tmpDir, "/fake/project");

				const verifyApplyTool = registeredTools.get("forge_verify_apply");
				expect(verifyApplyTool).toBeDefined();

				await verifyApplyTool!.execute(
					"test-call",
					{ claimed_paths: ["src/foo.ts", "src/bar.ts"] },
					undefined,
					undefined,
					undefined as never,
				);

				// Verify execFileAsync was called with verify-apply.cjs and correct paths
				const calls = execSpy.mock.calls.filter((c) => {
					const args = c[1] as string[];
					return args && args.some((a) => typeof a === "string" && a.includes("verify-apply.cjs"));
				});
				expect(calls.length).toBeGreaterThan(0);
				const [, callArgs] = calls[0];
				// callArgs = ["/path/to/verify-apply.cjs", "src/foo.ts", "src/bar.ts"]
				// (execFileAsync("node", [toolPath, ...argv], opts) — c[1] is the array arg)
				const argv = (callArgs as string[]).slice(1); // skip tool path, keep claimed paths
				expect(argv).toContain("src/foo.ts");
				expect(argv).toContain("src/bar.ts");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		} finally {
			execSpy.mockRestore();
		}
	});
});
