// mcp-json-merge.test.ts — Tests for claude-bootstrap/mcp-json-merge.ts (FORGE-S34-T06)
//
// Full fixture suite per AC2 — 7 branches:
//   1. template absent         — "error" (payload missing template; non-fatal)
//   2. project .mcp.json absent — reads template, writes forge entry — "created"
//   3. present, valid JSON, already has mcpServers.forge — "already-present" (idempotent no-op)
//   4. present, valid JSON, no mcpServers.forge — deep-merge forge key, preserve others — "merged"
//   5. present, malformed JSON — "error", file never overwritten
//   6. write failure           — "error" with descriptive warning
//   7. idempotency             — second consecutive call = "already-present", file hash unchanged

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeMcpJson, type MergeMcpJsonResult } from "../../../../src/extensions/forgecli/claude-bootstrap/mcp-json-merge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileHash(filePath: string): string {
	try {
		const content = fs.readFileSync(filePath);
		return crypto.createHash("sha256").update(content).digest("hex");
	} catch {
		return "";
	}
}

/** Standard forge .mcp.json template (mirrors T05 output). */
const TEMPLATE_CONTENT = JSON.stringify(
	{
		mcpServers: {
			forge: {
				command: "node",
				args: [".forge/mcp/server.cjs"],
				env: {
					CLAUDE_PROJECT_DIR: "${projectRoot}",
				},
			},
		},
	},
	null,
	2,
) + "\n";

let tmpRoot: string;

beforeAll(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-s34-t06-mcp-merge-"));
});

afterAll(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

function makeTmp(): string {
	return fs.mkdtempSync(path.join(tmpRoot, "case-"));
}

function writeTemplate(dir: string): string {
	const templateDir = path.join(dir, "init", "mcp");
	fs.mkdirSync(templateDir, { recursive: true });
	const templatePath = path.join(templateDir, ".mcp.json");
	fs.writeFileSync(templatePath, TEMPLATE_CONTENT, "utf8");
	return templatePath;
}

// ── Branch 1: template absent ─────────────────────────────────────────────────

describe("mergeMcpJson", () => {
	describe("branch 1: template absent", () => {
		it("returns outcome='error' when templatePath does not exist", () => {
			const dir = makeTmp();
			const mcpJsonPath = path.join(dir, ".mcp.json");
			const missingTemplate = path.join(dir, "nonexistent", ".mcp.json");

			const result: MergeMcpJsonResult = mergeMcpJson(mcpJsonPath, missingTemplate);

			expect(result.outcome).toBe("error");
			expect(result.warning).toBeTruthy();
			// Project .mcp.json should not be created
			expect(fs.existsSync(mcpJsonPath)).toBe(false);
		});
	});

	// ── Branch 2: project .mcp.json absent ───────────────────────────────────────

	describe("branch 2: project .mcp.json absent", () => {
		it("creates .mcp.json with mcpServers.forge entry from template; outcome='created'", () => {
			const dir = makeTmp();
			const templatePath = writeTemplate(dir);
			const mcpJsonPath = path.join(dir, ".mcp.json");

			const result: MergeMcpJsonResult = mergeMcpJson(mcpJsonPath, templatePath);

			expect(result.outcome).toBe("created");
			expect(result.warning).toBeUndefined();
			expect(fs.existsSync(mcpJsonPath)).toBe(true);

			const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8")) as {
				mcpServers: { forge: { command: string; args: string[] } };
			};
			expect(parsed.mcpServers).toBeDefined();
			expect(parsed.mcpServers.forge).toBeDefined();
			expect(parsed.mcpServers.forge.command).toBe("node");
			expect(parsed.mcpServers.forge.args[0]).toBe(".forge/mcp/server.cjs");
		});
	});

	// ── Branch 3: present, valid JSON, already has mcpServers.forge ──────────────

	describe("branch 3: project .mcp.json present with mcpServers.forge (idempotent no-op)", () => {
		it("returns outcome='already-present', file content unchanged", () => {
			const dir = makeTmp();
			const templatePath = writeTemplate(dir);
			const mcpJsonPath = path.join(dir, ".mcp.json");

			// First run creates
			mergeMcpJson(mcpJsonPath, templatePath);
			const hashAfterFirst = fileHash(mcpJsonPath);

			// Second run should be no-op
			const result: MergeMcpJsonResult = mergeMcpJson(mcpJsonPath, templatePath);

			expect(result.outcome).toBe("already-present");
			expect(result.warning).toBeUndefined();
			// File must be unchanged
			expect(fileHash(mcpJsonPath)).toBe(hashAfterFirst);
		});
	});

	// ── Branch 4: present, valid JSON, no mcpServers.forge — merge ───────────────

	describe("branch 4: project .mcp.json present with other servers but no forge", () => {
		it("merges forge entry, preserves unrelated server; outcome='merged'", () => {
			const dir = makeTmp();
			const templatePath = writeTemplate(dir);
			const mcpJsonPath = path.join(dir, ".mcp.json");

			// Pre-create with unrelated server
			const existing = {
				mcpServers: {
					"other-tool": {
						command: "node",
						args: ["./other/server.js"],
					},
				},
			};
			fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n", "utf8");

			const result: MergeMcpJsonResult = mergeMcpJson(mcpJsonPath, templatePath);

			expect(result.outcome).toBe("merged");
			expect(result.warning).toBeUndefined();

			const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8")) as {
				mcpServers: {
					"other-tool": { command: string; args: string[] };
					forge: { command: string; args: string[] };
				};
			};
			// Unrelated server preserved
			expect(parsed.mcpServers["other-tool"]).toBeDefined();
			expect(parsed.mcpServers["other-tool"].command).toBe("node");
			// Forge entry added
			expect(parsed.mcpServers.forge).toBeDefined();
			expect(parsed.mcpServers.forge.command).toBe("node");
			expect(parsed.mcpServers.forge.args[0]).toBe(".forge/mcp/server.cjs");
		});

		it("merges forge when mcpServers key is absent from existing file", () => {
			const dir = makeTmp();
			const templatePath = writeTemplate(dir);
			const mcpJsonPath = path.join(dir, ".mcp.json");

			// Pre-create with no mcpServers key
			fs.writeFileSync(mcpJsonPath, JSON.stringify({ someOtherConfig: true }, null, 2) + "\n", "utf8");

			const result: MergeMcpJsonResult = mergeMcpJson(mcpJsonPath, templatePath);

			expect(result.outcome).toBe("merged");
			const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8")) as {
				someOtherConfig: boolean;
				mcpServers: { forge: { command: string } };
			};
			expect(parsed.someOtherConfig).toBe(true);
			expect(parsed.mcpServers.forge.command).toBe("node");
		});
	});

	// ── Branch 5: present, malformed JSON ────────────────────────────────────────

	describe("branch 5: project .mcp.json present with malformed JSON", () => {
		it("returns outcome='error', file NOT overwritten", () => {
			const dir = makeTmp();
			const templatePath = writeTemplate(dir);
			const mcpJsonPath = path.join(dir, ".mcp.json");

			const malformed = "{ not valid json at all";
			fs.writeFileSync(mcpJsonPath, malformed, "utf8");

			const hashBefore = fileHash(mcpJsonPath);
			const result: MergeMcpJsonResult = mergeMcpJson(mcpJsonPath, templatePath);

			expect(result.outcome).toBe("error");
			expect(result.warning).toBeTruthy();
			// File must NOT be overwritten
			expect(fileHash(mcpJsonPath)).toBe(hashBefore);
			expect(fs.readFileSync(mcpJsonPath, "utf8")).toBe(malformed);
		});
	});

	// ── Branch 6: write failure ───────────────────────────────────────────────────

	describe("branch 6: write failure", () => {
		it("returns outcome='error' with descriptive warning when target dir is read-only", () => {
			const dir = makeTmp();
			const templatePath = writeTemplate(dir);

			// Make directory read-only to cause write failure
			const readOnlyDir = path.join(dir, "readonly");
			fs.mkdirSync(readOnlyDir, { recursive: true });
			fs.chmodSync(readOnlyDir, 0o555);

			const mcpJsonPath = path.join(readOnlyDir, ".mcp.json");
			const result: MergeMcpJsonResult = mergeMcpJson(mcpJsonPath, templatePath);

			expect(result.outcome).toBe("error");
			expect(result.warning).toBeTruthy();

			// Restore for cleanup
			fs.chmodSync(readOnlyDir, 0o755);
		});
	});

	// ── Branch 7: idempotency ─────────────────────────────────────────────────────

	describe("branch 7: idempotency", () => {
		it("third consecutive call = 'already-present', file hash unchanged from after first run", () => {
			const dir = makeTmp();
			const templatePath = writeTemplate(dir);
			const mcpJsonPath = path.join(dir, ".mcp.json");

			const result1 = mergeMcpJson(mcpJsonPath, templatePath);
			expect(result1.outcome).toBe("created");

			const hash1 = fileHash(mcpJsonPath);

			const result2 = mergeMcpJson(mcpJsonPath, templatePath);
			expect(result2.outcome).toBe("already-present");
			expect(fileHash(mcpJsonPath)).toBe(hash1);

			// Third call also idempotent
			const result3 = mergeMcpJson(mcpJsonPath, templatePath);
			expect(result3.outcome).toBe("already-present");
			expect(fileHash(mcpJsonPath)).toBe(hash1);
		});
	});
});
