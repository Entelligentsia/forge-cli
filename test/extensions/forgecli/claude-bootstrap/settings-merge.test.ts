// settings-merge.test.ts — Tests for claude-bootstrap/settings-merge.ts (FORGE-S31-T03)
//
// Full fixture suite per AC2 — 9 branches:
//   1. no settings file      — file absent → created with Forge hooks block only
//   2. empty file            — treat as malformed → "error", file unchanged
//   3. empty JSON object     — {} → hooks key added → "merged"
//   4. existing without hooks (unrelated keys) — hooks added, other keys preserved → "merged"
//   5. existing with unrelated hooks — Forge entries merged in, others survive → "merged"
//   6. existing with Forge hooks (no-op) — already present → "already-present", hash stable
//   7. malformed JSON        — "error", file NOT overwritten
//   8. write permission failure — "error", descriptive warning
//   9. idempotency           — second call = "already-present", file hash unchanged

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildForgeHooksBlock,
	type MergeResult,
	mergeForgeHooks,
} from "../../../../src/extensions/forgecli/claude-bootstrap/settings-merge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileHash(filePath: string): string {
	try {
		const content = fs.readFileSync(filePath);
		return crypto.createHash("sha256").update(content).digest("hex");
	} catch {
		return "";
	}
}

let tmpRoot: string;

beforeAll(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-s31-t03-"));
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

// ── buildForgeHooksBlock sanity checks ───────────────────────────────────────

describe("buildForgeHooksBlock", () => {
	it("returns an object with SessionStart, PreToolUse, PostToolUse, PermissionRequest", () => {
		const block = buildForgeHooksBlock();
		expect(block).toHaveProperty("SessionStart");
		expect(block).toHaveProperty("PreToolUse");
		expect(block).toHaveProperty("PostToolUse");
		expect(block).toHaveProperty("PermissionRequest");
	});

	it("SessionStart has at least 2 hooks (check-update, preflight-session)", () => {
		const block = buildForgeHooksBlock();
		const sessionStart = block.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
		const cmds = sessionStart.flatMap((e) => e.hooks.map((h) => h.command));
		expect(cmds.some((c) => c.includes("check-update"))).toBe(true);
		expect(cmds.some((c) => c.includes("preflight-session"))).toBe(true);
	});

	it("PreToolUse has validate-write for Write|Edit|MultiEdit matcher", () => {
		const block = buildForgeHooksBlock();
		const preToolUse = block.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
		const entry = preToolUse.find((e) => e.matcher?.includes("Write"));
		expect(entry).toBeDefined();
		const cmds = entry!.hooks.map((h) => h.command);
		expect(cmds.some((c) => c.includes("validate-write"))).toBe(true);
	});

	it("PostToolUse has triage-error, query-logger, post-init, post-sprint for Bash matcher", () => {
		const block = buildForgeHooksBlock();
		const postToolUse = block.PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
		const entry = postToolUse.find((e) => e.matcher === "Bash");
		expect(entry).toBeDefined();
		const cmds = entry!.hooks.map((h) => h.command);
		expect(cmds.some((c) => c.includes("triage-error"))).toBe(true);
		expect(cmds.some((c) => c.includes("query-logger"))).toBe(true);
		expect(cmds.some((c) => c.includes("post-init"))).toBe(true);
		expect(cmds.some((c) => c.includes("post-sprint"))).toBe(true);
	});

	it("all hook commands reference vendored $CLAUDE_PROJECT_DIR/.forge/tools/ paths", () => {
		const block = buildForgeHooksBlock();
		// Collect all hook commands across all event types
		const allCommands: string[] = [];
		for (const eventGroups of Object.values(block)) {
			for (const group of eventGroups as Array<{ hooks: Array<{ command: string }> }>) {
				for (const hook of group.hooks) {
					allCommands.push(hook.command);
				}
			}
		}
		expect(allCommands.length).toBeGreaterThan(0);
		for (const cmd of allCommands) {
			// query-logger is a *tool* (lives at tools/query-logger.cjs in the plugin,
			// per forge/forge/hooks/hooks.json) — everything else is a hook script
			// vendored under tools/hooks/.
			if (cmd.includes("query-logger")) {
				expect(cmd).toBe('node "$CLAUDE_PROJECT_DIR/.forge/tools/query-logger.cjs"');
			} else {
				expect(cmd).toMatch(/\$CLAUDE_PROJECT_DIR\/\.forge\/tools\/hooks\//);
			}
		}
	});
});

// ── mergeForgeHooks fixture branches ─────────────────────────────────────────

describe("mergeForgeHooks", () => {
	describe("branch 1: no settings file", () => {
		it("creates file with Forge hooks block; outcome='created'", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");

			const result: MergeResult = mergeForgeHooks(settingsPath);

			expect(result.outcome).toBe("created");
			expect(result.warning).toBeUndefined();
			expect(fs.existsSync(settingsPath)).toBe(true);

			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: unknown };
			expect(parsed).toHaveProperty("hooks");
			// Should only have 'hooks' key (no other keys added)
			expect(Object.keys(parsed)).toEqual(["hooks"]);
		});
	});

	describe("branch 2: empty file (malformed — treated as error)", () => {
		it("returns outcome='error', file content unchanged", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");
			fs.writeFileSync(settingsPath, "", "utf8");

			const hashBefore = fileHash(settingsPath);
			const result: MergeResult = mergeForgeHooks(settingsPath);

			expect(result.outcome).toBe("error");
			expect(result.warning).toBeTruthy();
			// File content must be unchanged
			expect(fileHash(settingsPath)).toBe(hashBefore);
		});
	});

	describe("branch 3: empty JSON object {}", () => {
		it("adds hooks key; outcome='merged'; other keys (none) preserved", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");
			fs.writeFileSync(settingsPath, "{}", "utf8");

			const result: MergeResult = mergeForgeHooks(settingsPath);

			expect(result.outcome).toBe("merged");
			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: unknown };
			expect(parsed).toHaveProperty("hooks");
		});
	});

	describe("branch 4: existing settings without hooks (unrelated keys)", () => {
		it("adds hooks key; preserves other keys byte-identical; outcome='merged'", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");
			const initial = { model: "claude-sonnet-4-5", theme: "dark" };
			fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");

			const result: MergeResult = mergeForgeHooks(settingsPath);

			expect(result.outcome).toBe("merged");
			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
				model: string;
				theme: string;
				hooks: unknown;
			};
			expect(parsed.model).toBe("claude-sonnet-4-5");
			expect(parsed.theme).toBe("dark");
			expect(parsed).toHaveProperty("hooks");
		});
	});

	describe("branch 5: existing settings with unrelated hooks", () => {
		it("merges Forge entries in; other tool hooks survive; outcome='merged'", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");
			// Pre-existing hooks from another tool
			const initial = {
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: "node /some/other/tool.cjs",
									timeout: 5000,
								},
							],
						},
					],
				},
			};
			fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");

			const result: MergeResult = mergeForgeHooks(settingsPath);

			expect(result.outcome).toBe("merged");
			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
				hooks: {
					SessionStart: Array<{ hooks: Array<{ command: string }> }>;
				};
			};
			// Other tool hook still present
			const allSessionCmds = parsed.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
			expect(allSessionCmds.some((c) => c.includes("other/tool.cjs"))).toBe(true);
			// Forge hooks also added
			expect(allSessionCmds.some((c) => c.includes(".forge/tools/hooks/"))).toBe(true);
		});
	});

	describe("branch 6: existing with Forge hooks (no-op)", () => {
		it("returns outcome='already-present', file hash unchanged", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");

			// First run — creates file
			mergeForgeHooks(settingsPath);
			const hashAfterFirst = fileHash(settingsPath);

			// Second run — should be no-op
			const result: MergeResult = mergeForgeHooks(settingsPath);

			expect(result.outcome).toBe("already-present");
			expect(fileHash(settingsPath)).toBe(hashAfterFirst);
		});
	});

	describe("branch 7: malformed JSON", () => {
		it("returns outcome='error', file NOT overwritten", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");
			const malformed = "{ not valid json";
			fs.writeFileSync(settingsPath, malformed, "utf8");

			const hashBefore = fileHash(settingsPath);
			const result: MergeResult = mergeForgeHooks(settingsPath);

			expect(result.outcome).toBe("error");
			expect(result.warning).toBeTruthy();
			expect(result.warning).toMatch(/malformed|parse|invalid/i);
			// File must NOT be overwritten
			expect(fileHash(settingsPath)).toBe(hashBefore);
			expect(fs.readFileSync(settingsPath, "utf8")).toBe(malformed);
		});
	});

	describe("branch 8: write permission failure", () => {
		it("returns outcome='error' with descriptive warning when file is read-only", () => {
			const dir = makeTmp();
			// Make directory read-only to cause write failure
			const readOnlyDir = path.join(dir, "readonly");
			fs.mkdirSync(readOnlyDir, { recursive: true });
			fs.chmodSync(readOnlyDir, 0o555);

			const settingsPath = path.join(readOnlyDir, "settings.json");
			const result: MergeResult = mergeForgeHooks(settingsPath);

			// Should be error (cannot write to read-only dir)
			expect(result.outcome).toBe("error");
			expect(result.warning).toBeTruthy();

			// Restore for cleanup
			fs.chmodSync(readOnlyDir, 0o755);
		});
	});

	describe("branch 9: idempotency", () => {
		it("second consecutive call = 'already-present', file hash unchanged", () => {
			const dir = makeTmp();
			const settingsPath = path.join(dir, "settings.json");

			const result1 = mergeForgeHooks(settingsPath);
			expect(result1.outcome).toBe("created");

			const hash1 = fileHash(settingsPath);

			const result2 = mergeForgeHooks(settingsPath);
			expect(result2.outcome).toBe("already-present");
			expect(fileHash(settingsPath)).toBe(hash1);

			// Third call also idempotent
			const result3 = mergeForgeHooks(settingsPath);
			expect(result3.outcome).toBe("already-present");
			expect(fileHash(settingsPath)).toBe(hash1);
		});
	});
});
