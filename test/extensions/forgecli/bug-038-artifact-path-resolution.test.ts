// bug-038-forge-artifact-path-resolution.test.ts
// Regression test for forge-cli#33:
// forge_artifact tool resolves entity directories from the store record's
// `path` field, not just from the entity ID. Slug-suffixed directories
// (e.g. engineering/bugs/BUG-001-sprint-runner-context-accumulation)
// must be reachable.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Import the module with _testOverrides for DI-based mocking
import { _testOverrides, buildForgeArtifact } from "../../../src/extensions/forgecli/forge-artifact-tool.js";

// ── Mock store records ────────────────────────────────────────────────────

const mockStoreRecords: Record<string, Record<string, Record<string, unknown>>> = {
	bug: {},
	sprint: {},
	task: {},
};

// ── Helpers ──────────────────────────────────────────────────────────────

function createTestProject(root: string, engineeringDir = "engineering") {
	const configDir = path.join(root, ".forge");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ paths: { engineering: engineeringDir } }),
		"utf8",
	);
	const eng = path.join(root, engineeringDir);
	fs.mkdirSync(path.join(eng, "bugs"), { recursive: true });
	fs.mkdirSync(path.join(eng, "sprints"), { recursive: true });
}

function rmDir(dir: string) {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function mockReadStorePath(entity: string, entityId: string): string | null {
	const record = mockStoreRecords[entity]?.[entityId];
	if (record && typeof record.path === "string" && record.path.length > 0) {
		return record.path;
	}
	return null;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("forge_artifact path resolution (forge-cli#33)", () => {
	afterEach(() => {
		mockStoreRecords.bug = {};
		mockStoreRecords.sprint = {};
		mockStoreRecords.task = {};
		_testOverrides.readStorePath = undefined;
	});

	describe("bug: slug-suffixed directory from store path", () => {
		it("resolves bug directory from store record path field", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-test-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const bugSlugDir = path.join(
					tmpDir,
					"engineering",
					"bugs",
					"FORGE-BUG-017-preflight-gate-workflow-shadowing",
				);
				fs.mkdirSync(bugSlugDir, { recursive: true });
				fs.writeFileSync(path.join(bugSlugDir, "TRIAGE.md"), "# Triage content", "utf8");

				mockStoreRecords.bug["FORGE-BUG-017"] = {
					bugId: "FORGE-BUG-017",
					title: "Test bug",
					path: "engineering/bugs/FORGE-BUG-017-preflight-gate-workflow-shadowing",
				};
				_testOverrides.readStorePath = (entity, entityId) => mockReadStorePath(entity, entityId);

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools");
				const result = await artifact.execute(
					"test-call",
					{
						command: "list",
						entity: "bug",
						entityId: "FORGE-BUG-017",
					},
					undefined,
				);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("TRIAGE.md");
				expect(text).not.toContain("directory does not exist");
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("bug: ID-only fallback when store unavailable", () => {
		it("falls back to ID-only path when store record not found", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-fallback-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const bugDir = path.join(tmpDir, "engineering", "bugs", "FORGE-BUG-999");
				fs.mkdirSync(bugDir, { recursive: true });
				fs.writeFileSync(path.join(bugDir, "INDEX.md"), "# Index", "utf8");

				// No store record → mock returns null → falls back to ID-only
				_testOverrides.readStorePath = () => null;

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools");
				const result = await artifact.execute(
					"test-call",
					{
						command: "list",
						entity: "bug",
						entityId: "FORGE-BUG-999",
					},
					undefined,
				);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("INDEX.md");
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("bug: empty path falls back to ID-only", () => {
		it("falls back when store record path is empty", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-empty-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const bugDir = path.join(tmpDir, "engineering", "bugs", "FORGE-BUG-040");
				fs.mkdirSync(bugDir, { recursive: true });
				fs.writeFileSync(path.join(bugDir, "TRIAGE.md"), "# Triage", "utf8");

				mockStoreRecords.bug["FORGE-BUG-040"] = {
					bugId: "FORGE-BUG-040",
					title: "Empty path",
					path: "",
				};
				_testOverrides.readStorePath = (entity, entityId) => mockReadStorePath(entity, entityId);

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools");
				const result = await artifact.execute(
					"test-call",
					{
						command: "list",
						entity: "bug",
						entityId: "FORGE-BUG-040",
					},
					undefined,
				);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("TRIAGE.md");
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("sprint: slug-suffixed directory from store path", () => {
		it("resolves sprint directory from store record path field", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-sprint-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const sprintSlugDir = path.join(tmpDir, "engineering", "sprints", "FORGE-S07-store-custodian");
				fs.mkdirSync(sprintSlugDir, { recursive: true });
				fs.writeFileSync(path.join(sprintSlugDir, "INDEX.md"), "# Sprint Index", "utf8");

				mockStoreRecords.sprint["FORGE-S07"] = {
					sprintId: "FORGE-S07",
					path: "engineering/sprints/FORGE-S07-store-custodian",
				};
				_testOverrides.readStorePath = (entity, entityId) => mockReadStorePath(entity, entityId);

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools");
				const result = await artifact.execute(
					"test-call",
					{
						command: "list",
						entity: "sprint",
						entityId: "FORGE-S07",
					},
					undefined,
				);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("INDEX.md");
				expect(text).not.toContain("directory does not exist");
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("task: slug-suffixed sprint in task path", () => {
		it("resolves task directory using store record path field", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-task-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const taskDir = path.join(
					tmpDir,
					"engineering",
					"sprints",
					"FORGE-S25-foundation-refactor",
					"FORGE-S25-T01",
				);
				fs.mkdirSync(taskDir, { recursive: true });
				fs.writeFileSync(path.join(taskDir, "PLAN.md"), "# Plan", "utf8");

				mockStoreRecords.task["FORGE-S25-T01"] = {
					taskId: "FORGE-S25-T01",
					sprintId: "FORGE-S25",
					path: "engineering/sprints/FORGE-S25-foundation-refactor/FORGE-S25-T01",
				};
				_testOverrides.readStorePath = (entity, entityId) => mockReadStorePath(entity, entityId);

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools");
				const result = await artifact.execute(
					"test-call",
					{
						command: "list",
						entity: "task",
						entityId: "FORGE-S25-T01",
					},
					undefined,
				);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("PLAN.md");
				expect(text).not.toContain("directory does not exist");
			} finally {
				rmDir(tmpDir);
			}
		});

		it("falls back to sprint path when task path is empty", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-task-fb-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const taskDir = path.join(tmpDir, "engineering", "sprints", "FORGE-S07-store-custodian", "FORGE-S07-T01");
				fs.mkdirSync(taskDir, { recursive: true });
				fs.writeFileSync(path.join(taskDir, "PLAN.md"), "# Plan", "utf8");

				// Task has empty path — resolveEntityDir should fall back to sprint path
				mockStoreRecords.task["FORGE-S07-T01"] = {
					taskId: "FORGE-S07-T01",
					sprintId: "FORGE-S07",
					path: "",
				};
				mockStoreRecords.sprint["FORGE-S07"] = {
					sprintId: "FORGE-S07",
					path: "engineering/sprints/FORGE-S07-store-custodian",
				};
				_testOverrides.readStorePath = (entity, entityId) => mockReadStorePath(entity, entityId);

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools");
				const result = await artifact.execute(
					"test-call",
					{
						command: "list",
						entity: "task",
						entityId: "FORGE-S07-T01",
					},
					undefined,
				);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("PLAN.md");
				expect(text).not.toContain("directory does not exist");
			} finally {
				rmDir(tmpDir);
			}
		});
	});

	describe("regression: old BUG-NNN slug-suffixed directories", () => {
		it("resolves BUG-001 with slug suffix from store", async () => {
			const tmpDir = path.join(process.env.TEMP ?? "/tmp", `forge-artifact-bug001-${Date.now()}`);
			try {
				createTestProject(tmpDir);

				const bugDir = path.join(tmpDir, "engineering", "bugs", "BUG-001-sprint-runner-context-accumulation");
				fs.mkdirSync(bugDir, { recursive: true });
				fs.writeFileSync(path.join(bugDir, "INDEX.md"), "# BUG-001 Index", "utf8");

				mockStoreRecords.bug["BUG-001"] = {
					bugId: "BUG-001",
					title: "Sprint runner accumulates context",
					path: "engineering/bugs/BUG-001-sprint-runner-context-accumulation",
				};
				_testOverrides.readStorePath = (entity, entityId) => mockReadStorePath(entity, entityId);

				const artifact = buildForgeArtifact(tmpDir, "engineering", "/fake/tools");
				const result = await artifact.execute(
					"test-call",
					{
						command: "list",
						entity: "bug",
						entityId: "BUG-001",
					},
					undefined,
				);

				const text = (result.content as Array<{ type: string; text: string }>)[0].text;
				expect(text).toContain("INDEX.md");
				expect(text).not.toContain("directory does not exist");
			} finally {
				rmDir(tmpDir);
			}
		});
	});
});
