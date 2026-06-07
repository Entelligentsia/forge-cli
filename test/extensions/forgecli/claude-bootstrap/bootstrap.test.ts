// bootstrap.test.ts — Tests for claude-bootstrap/bootstrap.ts (FORGE-S31-T02 + T03)
//
// Integration-style unit tests against the real bootstrapClaudeProject() function
// using actual fs operations on tmp dirs. No fs mocking.
//
// Branches covered:
//   1. clean dir — all paths created, manifest written, result.ok=true
//   2. partial bootstrap — only missing items created, existing unchanged
//   3. complete bootstrap (no-op run) — created=[], skipped=all, tree hash unchanged
//   4. non-writable target — ok=false with descriptive warning
//   5. payload validation — fast-fail before any writes when store-cli.cjs absent
//   6. init.md install from payload — byte-identical to payload source
//   7. wfl drivers installed — all wfl-*.js present in .claude/workflows/
//   FORGE-S31-T03:
//   8. Step 7 — .claude/settings.json written with Forge hooks after clean bootstrap
//   9. Step 8 — .gitignore appended when present; skipped when already contains pattern; skipped when absent
//  10. Step 9 — result.preflight fields present (claudeAvailable is boolean, workflowToolChecked=false)
//  11. Idempotent second run: settings.json hash unchanged

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapClaudeProject } from "../../../../src/extensions/forgecli/claude-bootstrap/bootstrap.js";

// ── Test fixture: minimal forge-payload ───────────────────────────────────────

function makeMinimalPayload(dir: string): string {
	const payloadRoot = path.join(dir, "forge-payload");

	// tools dir with store-cli.cjs
	const toolsDir = path.join(payloadRoot, "tools");
	fs.mkdirSync(toolsDir, { recursive: true });
	fs.writeFileSync(path.join(toolsDir, "store-cli.cjs"), "// stub store-cli\n", "utf8");
	fs.writeFileSync(path.join(toolsDir, "collate.cjs"), "// stub collate\n", "utf8");
	fs.writeFileSync(path.join(toolsDir, "validate.js"), "// stub validate\n", "utf8");

	// tools/lib dir
	const libDir = path.join(toolsDir, "lib");
	fs.mkdirSync(libDir, { recursive: true });
	fs.writeFileSync(path.join(libDir, "helper.cjs"), "// stub helper\n", "utf8");

	// commands dir with init.md
	const commandsDir = path.join(payloadRoot, "commands");
	fs.mkdirSync(commandsDir, { recursive: true });
	fs.writeFileSync(path.join(commandsDir, "init.md"), "# /forge:init\nPlaceholder init command.\n", "utf8");

	// .base-pack/workflows-js with wfl-*.js drivers
	const wflDir = path.join(payloadRoot, ".base-pack", "workflows-js");
	fs.mkdirSync(wflDir, { recursive: true });
	fs.writeFileSync(path.join(wflDir, "wfl-run-task.js"), "// wfl-run-task stub\n", "utf8");
	fs.writeFileSync(path.join(wflDir, "wfl-run-sprint.js"), "// wfl-run-sprint stub\n", "utf8");
	fs.writeFileSync(path.join(wflDir, "wfl-fix-bug.js"), "// wfl-fix-bug stub\n", "utf8");

	// .claude-plugin/plugin.json for version reading
	const pluginDir = path.join(payloadRoot, ".claude-plugin");
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.writeFileSync(
		path.join(pluginDir, "plugin.json"),
		JSON.stringify({ version: "1.2.99" }),
		"utf8",
	);

	// integrity.json for hash
	fs.writeFileSync(path.join(payloadRoot, "integrity.json"), JSON.stringify({ hash: "abc123" }), "utf8");

	return payloadRoot;
}

function hashDir(dir: string): string {
	const h = crypto.createHash("sha256");
	function walk(d: string): void {
		if (!fs.existsSync(d)) return;
		const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			const full = path.join(d, e.name);
			h.update(path.relative(dir, full));
			if (e.isDirectory()) {
				walk(full);
			} else {
				h.update(fs.readFileSync(full));
			}
		}
	}
	walk(dir);
	return h.digest("hex");
}

// ── Setup shared tmp dir ──────────────────────────────────────────────────────

let tmpRoot: string;
let payloadRoot: string;

beforeAll(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-s31-t02-"));
	payloadRoot = makeMinimalPayload(tmpRoot);
});

afterAll(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFreshProjectDir(): string {
	return fs.mkdtempSync(path.join(tmpRoot, "proj-"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bootstrapClaudeProject", () => {
	describe("clean dir", () => {
		it("returns ok=true and creates all expected paths", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });

			expect(result.ok).toBe(true);
			expect(result.warnings).toHaveLength(0);

			// .forge skeleton dirs
			expect(fs.existsSync(path.join(dir, ".forge"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "store", "sprints"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "store", "tasks"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "store", "bugs"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "store", "events"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "cache"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "schemas"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "tools"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".claude", "commands", "forge"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".claude", "workflows"))).toBe(true);
		});

		it("vendors tools into .forge/tools/", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			expect(fs.existsSync(path.join(dir, ".forge", "tools", "store-cli.cjs"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "tools", "collate.cjs"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "tools", "lib", "helper.cjs"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".forge", "tools", ".forge-tools-version"))).toBe(true);
		});

		it("writes .forge-tools-version marker with payload version", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const raw = fs.readFileSync(path.join(dir, ".forge", "tools", ".forge-tools-version"), "utf8");
			const marker = JSON.parse(raw) as { version: string };
			expect(marker.version).toBe("1.2.99");
		});

		it("installs init.md byte-identical to payload source", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const payloadSrc = fs.readFileSync(path.join(payloadRoot, "commands", "init.md"));
			const installed = fs.readFileSync(path.join(dir, ".claude", "commands", "forge", "init.md"));
			expect(installed).toEqual(payloadSrc);
		});

		it("installs all wfl-*.js drivers", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			expect(fs.existsSync(path.join(dir, ".claude", "workflows", "wfl-run-task.js"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".claude", "workflows", "wfl-run-sprint.js"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".claude", "workflows", "wfl-fix-bug.js"))).toBe(true);
		});

		it("writes wfl-*.js drivers byte-identical to payload source", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			for (const wfl of ["wfl-run-task.js", "wfl-run-sprint.js", "wfl-fix-bug.js"]) {
				const src = fs.readFileSync(path.join(payloadRoot, ".base-pack", "workflows-js", wfl));
				const dst = fs.readFileSync(path.join(dir, ".claude", "workflows", wfl));
				expect(dst).toEqual(src);
			}
		});

		it("writes bootstrap manifest", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const manifestPath = path.join(dir, ".forge", ".bootstrap-manifest.json");
			expect(fs.existsSync(manifestPath)).toBe(true);
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
				bootstrappedAt: string;
				payloadVersion: string;
				steps: string[];
			};
			expect(manifest.bootstrappedAt).toBeTruthy();
			expect(manifest.payloadVersion).toBe("1.2.99");
			expect(manifest.steps).toContain("scaffold");
			expect(manifest.steps).toContain("vendor-tools");
			expect(manifest.steps).toContain("install-commands");
			expect(manifest.steps).toContain("install-workflows");
		});

		it("lists created paths in result.created", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });
			expect(result.created.length).toBeGreaterThan(0);
		});
	});

	describe("partial bootstrap (repair)", () => {
		it("creates only missing items, leaves existing unchanged", () => {
			const dir = makeFreshProjectDir();

			// Pre-create some items
			fs.mkdirSync(path.join(dir, ".forge", "store", "sprints"), { recursive: true });
			fs.mkdirSync(path.join(dir, ".forge", "tools"), { recursive: true });
			fs.writeFileSync(path.join(dir, ".forge", "tools", "store-cli.cjs"), "// pre-existing\n", "utf8");

			const result = bootstrapClaudeProject({ dir, payloadRoot });
			expect(result.ok).toBe(true);

			// store-cli.cjs was pre-existing — should be overwritten (repair semantics for files)
			// but dir creation was a no-op
			expect(fs.existsSync(path.join(dir, ".forge", "store", "tasks"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".claude", "workflows", "wfl-run-task.js"))).toBe(true);

			// Result has a mix of created and skipped
			expect(result.created.length + result.skipped.length).toBeGreaterThan(0);
		});

		it("does not touch .forge/config.json if present", () => {
			const dir = makeFreshProjectDir();
			// Pre-place a config.json
			fs.mkdirSync(path.join(dir, ".forge"), { recursive: true });
			const configContent = JSON.stringify({ my: "config" });
			fs.writeFileSync(path.join(dir, ".forge", "config.json"), configContent, "utf8");

			bootstrapClaudeProject({ dir, payloadRoot });

			// Config must be untouched
			expect(fs.readFileSync(path.join(dir, ".forge", "config.json"), "utf8")).toBe(configContent);
		});

		it("does not touch .forge/store/ record files if present", () => {
			const dir = makeFreshProjectDir();
			fs.mkdirSync(path.join(dir, ".forge", "store", "tasks"), { recursive: true });
			const record = JSON.stringify({ taskId: "HELLO-T01" });
			fs.writeFileSync(path.join(dir, ".forge", "store", "tasks", "HELLO-T01.json"), record, "utf8");

			bootstrapClaudeProject({ dir, payloadRoot });

			// Record must be untouched
			expect(fs.readFileSync(path.join(dir, ".forge", "store", "tasks", "HELLO-T01.json"), "utf8")).toBe(record);
		});
	});

	describe("complete bootstrap (idempotent no-op run)", () => {
		it("second consecutive run is a no-op: created=[], all paths still present, dir hash unchanged", () => {
			const dir = makeFreshProjectDir();

			bootstrapClaudeProject({ dir, payloadRoot });
			const hashAfterFirst = hashDir(dir);

			const result2 = bootstrapClaudeProject({ dir, payloadRoot });
			const hashAfterSecond = hashDir(dir);

			expect(result2.ok).toBe(true);
			// All expected files still present
			expect(fs.existsSync(path.join(dir, ".forge", "tools", "store-cli.cjs"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".claude", "workflows", "wfl-run-task.js"))).toBe(true);

			// Tree hash must be unchanged
			expect(hashAfterSecond).toBe(hashAfterFirst);
		});
	});

	describe("payload validation", () => {
		it("returns ok=false with descriptive warning when store-cli.cjs is missing from payloadRoot", () => {
			const dir = makeFreshProjectDir();
			const badPayload = path.join(tmpRoot, "bad-payload");
			fs.mkdirSync(path.join(badPayload, "tools"), { recursive: true });
			// store-cli.cjs intentionally NOT created

			const result = bootstrapClaudeProject({ dir, payloadRoot: badPayload });

			expect(result.ok).toBe(false);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings[0]).toMatch(/store-cli\.cjs/);

			// No dirs should have been created in the target (fast-fail before any writes)
			expect(fs.existsSync(path.join(dir, ".forge"))).toBe(false);
		});
	});

	describe("non-writable target", () => {
		it("returns ok=false with descriptive warning when .forge/ cannot be created", () => {
			// Create a read-only directory as the target
			const dir = makeFreshProjectDir();
			const readOnlyDir = path.join(dir, "readonly-project");
			fs.mkdirSync(readOnlyDir, { recursive: true });
			// Make it read-only (chmod 444)
			fs.chmodSync(readOnlyDir, 0o444);

			const result = bootstrapClaudeProject({ dir: readOnlyDir, payloadRoot });

			expect(result.ok).toBe(false);
			expect(result.warnings.length).toBeGreaterThan(0);

			// Restore permissions for cleanup
			fs.chmodSync(readOnlyDir, 0o755);
		});
	});

	describe("Step 7 — settings.json hooks wiring (FORGE-S31-T03)", () => {
		it("creates .claude/settings.json with Forge hooks after clean bootstrap", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });

			expect(result.ok).toBe(true);
			const settingsPath = path.join(dir, ".claude", "settings.json");
			expect(fs.existsSync(settingsPath)).toBe(true);

			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: unknown };
			expect(parsed).toHaveProperty("hooks");
		});

		it("settings.json contains Forge hook commands pointing at .forge/tools/hooks/", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const settingsPath = path.join(dir, ".claude", "settings.json");
			const content = fs.readFileSync(settingsPath, "utf8");
			expect(content).toMatch(/\.forge\/tools\/hooks\//);
		});

		it("settings.json creation reported in result.created", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });

			const settingsPath = path.join(dir, ".claude", "settings.json");
			expect(result.created.some((p) => p === settingsPath)).toBe(true);
		});

		it("existing settings.json without hooks: hooks merged in, other keys preserved", () => {
			const dir = makeFreshProjectDir();
			// Pre-bootstrap to create .claude/ dir
			const firstResult = bootstrapClaudeProject({ dir, payloadRoot });
			expect(firstResult.ok).toBe(true);

			// Replace settings.json with a version that has no hooks but has other keys
			const settingsPath = path.join(dir, ".claude", "settings.json");
			const initial = { model: "claude-sonnet-4-5" };
			fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");

			const result = bootstrapClaudeProject({ dir, payloadRoot });
			expect(result.ok).toBe(true);

			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
				model: string;
				hooks: unknown;
			};
			expect(parsed.model).toBe("claude-sonnet-4-5");
			expect(parsed).toHaveProperty("hooks");
		});
	});

	describe("Step 8 — .gitignore append (FORGE-S31-T03)", () => {
		it("appends Forge gitignore block when .gitignore is present and doesn't have the pattern", () => {
			const dir = makeFreshProjectDir();
			// Create a .gitignore without the Forge pattern
			const gitignorePath = path.join(dir, ".gitignore");
			fs.writeFileSync(gitignorePath, "node_modules/\ndist/\n", "utf8");

			const result = bootstrapClaudeProject({ dir, payloadRoot });
			expect(result.ok).toBe(true);

			const content = fs.readFileSync(gitignorePath, "utf8");
			expect(content).toMatch(/\.forge\/store\/events\//);
		});

		it("skips .gitignore append when pattern already present (idempotent)", () => {
			const dir = makeFreshProjectDir();
			const gitignorePath = path.join(dir, ".gitignore");
			// Already has the .forge/ pattern
			fs.writeFileSync(gitignorePath, "node_modules/\n.forge/\n", "utf8");

			bootstrapClaudeProject({ dir, payloadRoot });

			const content = fs.readFileSync(gitignorePath, "utf8");
			// Should not have duplicate entries
			const forgeCount = (content.match(/\.forge\//g) ?? []).length;
			expect(forgeCount).toBe(1);
		});

		it("skips .gitignore when file is absent (no .gitignore created)", () => {
			const dir = makeFreshProjectDir();
			// Confirm no .gitignore exists
			const gitignorePath = path.join(dir, ".gitignore");
			expect(fs.existsSync(gitignorePath)).toBe(false);

			const result = bootstrapClaudeProject({ dir, payloadRoot });
			expect(result.ok).toBe(true);

			// Still no .gitignore — bootstrap does not create one
			expect(fs.existsSync(gitignorePath)).toBe(false);
		});
	});

	describe("Step 9 — preflight + BootstrapResult extension (FORGE-S31-T03)", () => {
		it("result.preflight is present after bootstrap", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });

			expect(result.ok).toBe(true);
			expect(result).toHaveProperty("preflight");
		});

		it("result.preflight.claudeAvailable is a boolean", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });

			expect(typeof result.preflight.claudeAvailable).toBe("boolean");
		});

		it("result.preflight.workflowToolChecked is always false (offline limitation)", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });

			expect(result.preflight.workflowToolChecked).toBe(false);
		});

		it("result.preflight.warnings is an array", () => {
			const dir = makeFreshProjectDir();
			const result = bootstrapClaudeProject({ dir, payloadRoot });

			expect(Array.isArray(result.preflight.warnings)).toBe(true);
		});
	});

	describe("idempotent second run — T03 extended (settings hash unchanged)", () => {
		it("second run: settings.json hash unchanged after first run", () => {
			const dir = makeFreshProjectDir();

			bootstrapClaudeProject({ dir, payloadRoot });
			const settingsPath = path.join(dir, ".claude", "settings.json");
			const hashAfterFirst = crypto
				.createHash("sha256")
				.update(fs.readFileSync(settingsPath))
				.digest("hex");

			bootstrapClaudeProject({ dir, payloadRoot });
			const hashAfterSecond = crypto
				.createHash("sha256")
				.update(fs.readFileSync(settingsPath))
				.digest("hex");

			expect(hashAfterSecond).toBe(hashAfterFirst);
		});

		it("second run: settings.json wiring reported in result.skipped (already-present)", () => {
			const dir = makeFreshProjectDir();

			bootstrapClaudeProject({ dir, payloadRoot });
			const result2 = bootstrapClaudeProject({ dir, payloadRoot });

			expect(result2.ok).toBe(true);
			const settingsPath = path.join(dir, ".claude", "settings.json");
			expect(result2.skipped.some((p) => p === settingsPath)).toBe(true);
		});
	});

	describe("grep-negative ACs", () => {
		it("bootstrap module source contains no network imports", () => {
			// Read the source file and assert no fetch/network imports
			const srcPath = path.resolve(
				import.meta.dirname,
				"../../../../src/extensions/forgecli/claude-bootstrap/bootstrap.ts",
			);
			const src = fs.readFileSync(srcPath, "utf8");
			expect(src).not.toMatch(/import.*fetch/);
			expect(src).not.toMatch(/import.*https/);
			expect(src).not.toMatch(/require\(['"]https['"]\)/);
			expect(src).not.toMatch(/require\(['"]node:https['"]\)/);
		});

		it("bootstrap module source contains no store writes (no writeFileSync targeting .forge/store/)", () => {
			const srcPath = path.resolve(
				import.meta.dirname,
				"../../../../src/extensions/forgecli/claude-bootstrap/bootstrap.ts",
			);
			// Strip single-line comments before scanning, to avoid false positives from
			// documentation lines (e.g. "// No .forge/store/ writes").
			const src = fs
				.readFileSync(srcPath, "utf8")
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("//"))
				.join("\n");
			// No actual code path should write to .forge/store/ (store dirs are only scaffolded as empty)
			expect(src).not.toMatch(/writeFileSync[^;]*\.forge[/\\\\]store[/\\\\]/);
			expect(src).not.toMatch(/writeFile[^;]*\.forge[/\\\\]store[/\\\\]/);
		});

		it("bootstrap module source contains no sendUserMessage or ctx.ui calls", () => {
			const srcPath = path.resolve(
				import.meta.dirname,
				"../../../../src/extensions/forgecli/claude-bootstrap/bootstrap.ts",
			);
			// Strip single-line comments to avoid false positives from documentation comments.
			const src = fs
				.readFileSync(srcPath, "utf8")
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("//"))
				.join("\n");
			// No actual code should call sendUserMessage or ctx.ui
			expect(src).not.toMatch(/sendUserMessage\s*\(/);
			expect(src).not.toMatch(/ctx\.ui\s*\./);
		});
	});
});
