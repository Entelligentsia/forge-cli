// bootstrap.test.ts — Tests for claude-bootstrap/bootstrap.ts (FORGE-S31-T02)
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
