// bug-038-forge-artifact-path-resolution.test.ts
// After FORGE-S26-T16 shim conversion:
// forge_artifact is now a thin runCjs shim delegating to artifact.cjs on the
// plugin side. Path resolution logic has been moved there. This test verifies
// that the shim dispatches correct argv arrays to artifact.cjs via runCjs.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildForgeArtifact } from "../../../src/extensions/forgecli/forge-artifact-tool.js";

// ── Mock runCjs ──────────────────────────────────────────────────────────────

type RunCjsResult = { stdout: string; stderr: string };

function makeRunCjsMock(response: RunCjsResult) {
	return vi.fn().mockResolvedValue(response);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTestProject(root: string) {
	const configDir = path.join(root, ".forge");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ paths: { engineering: "engineering" } }),
		"utf8",
	);
}

function rmDir(dir: string) {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Tests — shim dispatch correctness ────────────────────────────────────────

describe("forge_artifact shim dispatch (forge-cli#33 / FORGE-S26-T16)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("list command", () => {
		it("dispatches ['list', entity, entityId] to artifact.cjs", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-shim-list-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const mockRunCjs = makeRunCjsMock({
					stdout: "Artifacts in engineering/sprints/FORGE-S26/FORGE-S26-T16/:\n  plan → PLAN.md\n",
					stderr: "",
				});

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools", mockRunCjs);
				const result = await artifact.execute(
					"test-call",
					{ command: "list", entity: "task", entityId: "FORGE-S26-T16" },
					undefined,
					undefined,
					undefined as never,
				);

				expect(mockRunCjs).toHaveBeenCalledOnce();
				const [toolPath, argv] = mockRunCjs.mock.calls[0];
				expect(path.basename(toolPath)).toBe("artifact.cjs");
				expect(argv).toEqual(["list", "task", "FORGE-S26-T16"]);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("PLAN.md");
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("read command", () => {
		it("dispatches ['read', entity, entityId, artifact] to artifact.cjs", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-shim-read-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const mockRunCjs = makeRunCjsMock({
					stdout: "# My Plan\n\nSome plan content.",
					stderr: "",
				});

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools", mockRunCjs);
				const result = await artifact.execute(
					"test-call",
					{ command: "read", entity: "task", entityId: "FORGE-S26-T16", artifact: "plan" },
					undefined,
					undefined,
					undefined as never,
				);

				expect(mockRunCjs).toHaveBeenCalledOnce();
				const [toolPath, argv] = mockRunCjs.mock.calls[0];
				expect(path.basename(toolPath)).toBe("artifact.cjs");
				expect(argv).toEqual(["read", "task", "FORGE-S26-T16", "plan"]);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("# My Plan");
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("write command — inline content (<64KB)", () => {
		it("dispatches ['write', entity, entityId, artifact, content] to artifact.cjs for small content", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-shim-write-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const mockRunCjs = makeRunCjsMock({ stdout: "Wrote 8 bytes to path/PROGRESS.md", stderr: "" });

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools", mockRunCjs);
				await artifact.execute(
					"test-call",
					{
						command: "write",
						entity: "task",
						entityId: "FORGE-S26-T16",
						artifact: "progress",
						content: "# Hello",
					},
					undefined,
					undefined,
					undefined as never,
				);

				expect(mockRunCjs).toHaveBeenCalledOnce();
				const [toolPath, argv] = mockRunCjs.mock.calls[0];
				expect(path.basename(toolPath)).toBe("artifact.cjs");
				expect(argv[0]).toBe("write");
				expect(argv[1]).toBe("task");
				expect(argv[2]).toBe("FORGE-S26-T16");
				expect(argv[3]).toBe("progress");
				expect(argv[4]).toBe("# Hello"); // inline content
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("write command — @-file for large content (>=64KB)", () => {
		it("dispatches @-prefixed temp file path for large content", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-shim-large-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const mockRunCjs = makeRunCjsMock({ stdout: "Wrote bytes to path/PROGRESS.md", stderr: "" });

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools", mockRunCjs);
				const largeContent = "# Large\n" + "x".repeat(65 * 1024); // > 64KB
				await artifact.execute(
					"test-call",
					{
						command: "write",
						entity: "task",
						entityId: "FORGE-S26-T16",
						artifact: "progress",
						content: largeContent,
					},
					undefined,
					undefined,
					undefined as never,
				);

				expect(mockRunCjs).toHaveBeenCalledOnce();
				const [, argv] = mockRunCjs.mock.calls[0];
				expect(argv[4]).toMatch(/^@/); // @-prefixed temp file
				const filePath = argv[4].slice(1);
				expect(fs.existsSync(filePath)).toBe(false); // temp file cleaned up after execute
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("missing artifact argument", () => {
		it("returns error when artifact is missing for read", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-shim-no-art-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const mockRunCjs = makeRunCjsMock({ stdout: "", stderr: "" });

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools", mockRunCjs);
				const result = await artifact.execute(
					"test-call",
					{ command: "read", entity: "task", entityId: "FORGE-S26-T16" },
					undefined,
					undefined,
					undefined as never,
				);

				// runCjs should NOT be called — error returned before dispatch
				expect(mockRunCjs).not.toHaveBeenCalled();
				expect((result as { isError?: boolean }).isError).toBe(true);
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("tool path: bug entity with slug-suffixed directory", () => {
		it("dispatches with bug entity and ID — path resolution is delegated to plugin", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-shim-bug-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const mockRunCjs = makeRunCjsMock({
					stdout: "Artifacts in engineering/bugs/FORGE-BUG-017-slug/:\n  triage → TRIAGE.md\n",
					stderr: "",
				});

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools", mockRunCjs);
				await artifact.execute(
					"test-call",
					{ command: "list", entity: "bug", entityId: "FORGE-BUG-017" },
					undefined,
					undefined,
					undefined as never,
				);

				const [toolPath, argv] = mockRunCjs.mock.calls[0];
				expect(path.basename(toolPath)).toBe("artifact.cjs");
				expect(argv).toEqual(["list", "bug", "FORGE-BUG-017"]);
			} finally {
				rmDir(tmpDir);
			}
		});
	});
});
