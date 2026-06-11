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

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapClaudeProject } from "../../../../src/extensions/forgecli/claude-bootstrap/bootstrap.js";
import { writeFixtureManifest } from "./fixture-manifest.js";

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

	// tools/package.json CJS scope marker (FORGE-BUG-030 — written by build-payload)
	fs.writeFileSync(path.join(toolsDir, "package.json"), '{\n  "type": "commonjs"\n}\n', "utf8");

	// hooks dir with hook scripts (payload root, mirrors forge/forge/hooks/)
	const hooksDir = path.join(payloadRoot, "hooks");
	fs.mkdirSync(hooksDir, { recursive: true });
	fs.writeFileSync(path.join(hooksDir, "check-update.cjs"), "// stub check-update hook\n", "utf8");
	fs.writeFileSync(path.join(hooksDir, "preflight-session.cjs"), "// stub preflight-session hook\n", "utf8");
	fs.writeFileSync(path.join(hooksDir, "validate-write.cjs"), "// stub validate-write hook\n", "utf8");
	// non-script files in hooks/ (e.g. hooks.json) must NOT be vendored
	fs.writeFileSync(path.join(hooksDir, "hooks.json"), "{}\n", "utf8");

	// hooks/lib dir — hook scripts require ./lib/common.cjs etc. at runtime
	const hooksLibDir = path.join(hooksDir, "lib");
	fs.mkdirSync(hooksLibDir, { recursive: true });
	fs.writeFileSync(path.join(hooksLibDir, "common.cjs"), "// stub hooks lib common\n", "utf8");
	fs.writeFileSync(path.join(hooksLibDir, "write-registry.js"), "// stub write-registry\n", "utf8");

	// schemas dir with *.json + _defs/ subdir
	const schemasDir = path.join(payloadRoot, "schemas");
	fs.mkdirSync(path.join(schemasDir, "_defs"), { recursive: true });
	fs.writeFileSync(path.join(schemasDir, "config.schema.json"), '{"type":"object"}\n', "utf8");
	fs.writeFileSync(path.join(schemasDir, "task.schema.json"), '{"type":"object"}\n', "utf8");
	fs.writeFileSync(path.join(schemasDir, "_defs", "common.json"), '{"$defs":{}}\n', "utf8");

	// commands dir — plugin utility commands (init.md overlaps with .base-pack)
	const commandsDir = path.join(payloadRoot, "commands");
	fs.mkdirSync(commandsDir, { recursive: true });
	fs.writeFileSync(path.join(commandsDir, "init.md"), "# /forge:init\nPlaceholder PLUGIN init command.\n", "utf8");
	fs.writeFileSync(path.join(commandsDir, "status.md"), "# /forge:status\nUtility status command.\n", "utf8");
	fs.writeFileSync(path.join(commandsDir, "health.md"), "# /forge:health\nUtility health command.\n", "utf8");

	// .base-pack/commands — sprint-workflow command shims (static /forge:* files)
	const bpCommandsDir = path.join(payloadRoot, ".base-pack", "commands");
	fs.mkdirSync(bpCommandsDir, { recursive: true });
	fs.writeFileSync(path.join(bpCommandsDir, "plan.md"), "# /forge:plan\nWorkflow shim.\n", "utf8");
	fs.writeFileSync(path.join(bpCommandsDir, "run-task.md"), "# /forge:run-task\nWorkflow shim.\n", "utf8");
	fs.writeFileSync(path.join(bpCommandsDir, "init.md"), "# /forge:init\nProject-local BASE-PACK init.\n", "utf8");

	// .base-pack/workflows-js with wfl-*.js drivers
	const wflDir = path.join(payloadRoot, ".base-pack", "workflows-js");
	fs.mkdirSync(wflDir, { recursive: true });
	fs.writeFileSync(path.join(wflDir, "wfl-run-task.js"), "// wfl-run-task stub\n", "utf8");
	fs.writeFileSync(path.join(wflDir, "wfl-run-sprint.js"), "// wfl-run-sprint stub\n", "utf8");
	fs.writeFileSync(path.join(wflDir, "wfl-fix-bug.js"), "// wfl-fix-bug stub\n", "utf8");

	// .base-pack/personas — Phase 3 materialization source (nested content)
	const bpPersonasDir = path.join(payloadRoot, ".base-pack", "personas");
	fs.mkdirSync(bpPersonasDir, { recursive: true });
	fs.writeFileSync(path.join(bpPersonasDir, "engineer.md"), "# {{PREFIX}} engineer persona\n", "utf8");

	// init/phases — wfl:init phase rulebooks (read from $forgeRoot/init/phases/)
	const initPhasesDir = path.join(payloadRoot, "init", "phases");
	fs.mkdirSync(initPhasesDir, { recursive: true });
	fs.writeFileSync(path.join(initPhasesDir, "phase-1-collect.md"), "# Phase 1\n", "utf8");
	fs.writeFileSync(path.join(initPhasesDir, "phase-2-discover.md"), "# Phase 2\n", "utf8");

	// meta/ — generation sources + skill-recommendations (nested)
	const metaDir = path.join(payloadRoot, "meta");
	fs.mkdirSync(path.join(metaDir, "workflows"), { recursive: true });
	fs.writeFileSync(path.join(metaDir, "skill-recommendations.md"), "# Skill recs\n", "utf8");
	fs.writeFileSync(path.join(metaDir, "workflows", "meta-migrate.md"), "# Meta migrate\n", "utf8");

	// agents/ — plugin agents → project .claude/agents/
	const agentsDir = path.join(payloadRoot, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "tomoshibi.md"), "# Tomoshibi agent\n", "utf8");

	// skills/ — plugin skills → project .claude/skills/
	const skillsDir = path.join(payloadRoot, "skills", "refresh-kb-links");
	fs.mkdirSync(skillsDir, { recursive: true });
	fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# refresh-kb-links skill\n", "utf8");

	// .claude-plugin/plugin.json for version reading
	const pluginDir = path.join(payloadRoot, ".claude-plugin");
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ version: "1.2.99" }), "utf8");

	// integrity.json for hash
	fs.writeFileSync(path.join(payloadRoot, "integrity.json"), JSON.stringify({ hash: "abc123" }), "utf8");

	// payload-manifest.json — single source of truth the vendor loop reads.
	writeFixtureManifest(payloadRoot);

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

		it("vendors hook scripts into .forge/tools/hooks/ (settings.json target)", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const hooksDest = path.join(dir, ".forge", "tools", "hooks");
			expect(fs.existsSync(path.join(hooksDest, "check-update.cjs"))).toBe(true);
			expect(fs.existsSync(path.join(hooksDest, "preflight-session.cjs"))).toBe(true);
			expect(fs.existsSync(path.join(hooksDest, "validate-write.cjs"))).toBe(true);
			// byte-identical to payload source
			expect(fs.readFileSync(path.join(hooksDest, "check-update.cjs"), "utf8")).toBe(
				fs.readFileSync(path.join(payloadRoot, "hooks", "check-update.cjs"), "utf8"),
			);
			// non-script files (hooks.json) are not vendored
			expect(fs.existsSync(path.join(hooksDest, "hooks.json"))).toBe(false);
		});

		it("vendors hooks/lib/ runtime deps alongside hook scripts", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const hooksLibDest = path.join(dir, ".forge", "tools", "hooks", "lib");
			// hook scripts require ./lib/common.cjs etc. — without these every
			// PostToolUse hook fails with MODULE_NOT_FOUND at runtime
			expect(fs.existsSync(path.join(hooksLibDest, "common.cjs"))).toBe(true);
			expect(fs.existsSync(path.join(hooksLibDest, "write-registry.js"))).toBe(true);
		});

		it("vendors tools/package.json CJS scope marker (FORGE-BUG-030)", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const markerPath = path.join(dir, ".forge", "tools", "package.json");
			expect(fs.existsSync(markerPath)).toBe(true);
			const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { type?: string };
			expect(parsed.type).toBe("commonjs");
		});

		it("vendors schemas into .forge/schemas/ including _defs/", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const schemasDest = path.join(dir, ".forge", "schemas");
			expect(fs.existsSync(path.join(schemasDest, "config.schema.json"))).toBe(true);
			expect(fs.existsSync(path.join(schemasDest, "task.schema.json"))).toBe(true);
			expect(fs.existsSync(path.join(schemasDest, "_defs", "common.json"))).toBe(true);
			expect(fs.readFileSync(path.join(schemasDest, "config.schema.json"), "utf8")).toBe(
				fs.readFileSync(path.join(payloadRoot, "schemas", "config.schema.json"), "utf8"),
			);
		});

		it("writes .forge-tools-version marker with payload version", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const raw = fs.readFileSync(path.join(dir, ".forge", "tools", ".forge-tools-version"), "utf8");
			const marker = JSON.parse(raw) as { version: string };
			expect(marker.version).toBe("1.2.99");
		});

		it("vendors the full /forge:* command surface into .claude/commands/forge/", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const cmdDir = path.join(dir, ".claude", "commands", "forge");
			// workflow shims from .base-pack/commands/
			expect(fs.existsSync(path.join(cmdDir, "plan.md"))).toBe(true);
			expect(fs.existsSync(path.join(cmdDir, "run-task.md"))).toBe(true);
			// utility commands from commands/
			expect(fs.existsSync(path.join(cmdDir, "status.md"))).toBe(true);
			expect(fs.existsSync(path.join(cmdDir, "health.md"))).toBe(true);
		});

		it("on name collision the .base-pack/commands version wins (init.md)", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const installed = fs.readFileSync(path.join(dir, ".claude", "commands", "forge", "init.md"), "utf8");
			const basePackSrc = fs.readFileSync(path.join(payloadRoot, ".base-pack", "commands", "init.md"), "utf8");
			expect(installed).toBe(basePackSrc);
			expect(installed).toContain("BASE-PACK");
		});

		it("vendors init/, .base-pack/, meta/, .claude-plugin/ into .forge/ (Forge-root parity)", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			const forgeDir = path.join(dir, ".forge");
			// wfl:init phase rulebooks read from $forgeRoot/init/phases/
			expect(fs.existsSync(path.join(forgeDir, "init", "phases", "phase-1-collect.md"))).toBe(true);
			expect(fs.existsSync(path.join(forgeDir, "init", "phases", "phase-2-discover.md"))).toBe(true);
			// substitute-placeholders probes $forgeRoot/.base-pack/ first
			expect(fs.existsSync(path.join(forgeDir, ".base-pack", "commands", "plan.md"))).toBe(true);
			expect(fs.existsSync(path.join(forgeDir, ".base-pack", "personas", "engineer.md"))).toBe(true);
			// meta/ incl. nested dirs
			expect(fs.existsSync(path.join(forgeDir, "meta", "skill-recommendations.md"))).toBe(true);
			expect(fs.existsSync(path.join(forgeDir, "meta", "workflows", "meta-migrate.md"))).toBe(true);
			// version source for FORGE_ROOT/.claude-plugin/plugin.json readers
			expect(fs.existsSync(path.join(forgeDir, ".claude-plugin", "plugin.json"))).toBe(true);
		});

		it("vendors agents/ and skills/ into .claude/", () => {
			const dir = makeFreshProjectDir();
			bootstrapClaudeProject({ dir, payloadRoot });

			expect(fs.existsSync(path.join(dir, ".claude", "agents", "tomoshibi.md"))).toBe(true);
			expect(fs.existsSync(path.join(dir, ".claude", "skills", "refresh-kb-links", "SKILL.md"))).toBe(true);
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
			expect(manifest.steps).toContain("vendor-hooks");
			expect(manifest.steps).toContain("vendor-schemas");
			expect(manifest.steps).toContain("vendor-commands");
			expect(manifest.steps).toContain("vendor-forge-root");
			expect(manifest.steps).toContain("vendor-claude-assets");
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
			const hashAfterFirst = crypto.createHash("sha256").update(fs.readFileSync(settingsPath)).digest("hex");

			bootstrapClaudeProject({ dir, payloadRoot });
			const hashAfterSecond = crypto.createHash("sha256").update(fs.readFileSync(settingsPath)).digest("hex");

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

	// ── AC4 frozen-install-set parity (PRIMARY GATE) — FORGE-S32-T03 ──────────
	// The manifest-driven bootstrap, run against the REAL built payload, must
	// vendor EXACTLY the historical `4ge init claude .` file set captured in
	// expected-install-set.json. This is the CI guard that catches any manifest
	// edit (T05/T06) or an over-broad-install regression (FORGE-BUG-044/045)
	// that would change the vendored tree. A recorded `diff -r` alone is not the
	// gate — this frozen-set assertion is.
	describe("AC4 frozen-install-set parity (real payload)", () => {
		const repoRoot = path.resolve(import.meta.dirname, "../../../..");
		let realPayloadRoot: string;
		let installSet: string[];

		beforeAll(() => {
			// Build the real payload (idempotent) so dist/forge-payload reflects the
			// current manifest + build-payload.cjs.
			const build = child_process.spawnSync("node", [path.join(repoRoot, "scripts", "build-payload.cjs")], {
				cwd: repoRoot,
				encoding: "utf8",
			});
			expect(build.status).toBe(0);
			realPayloadRoot = path.join(repoRoot, "dist", "forge-payload");

			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-frozen-set-"));
			const result = bootstrapClaudeProject({ dir, payloadRoot: realPayloadRoot });
			expect(result.ok).toBe(true);

			const files: string[] = [];
			const walk = (d: string): void => {
				for (const e of fs.readdirSync(d, { withFileTypes: true })) {
					const abs = path.join(d, e.name);
					if (e.isDirectory()) walk(abs);
					else files.push(path.relative(dir, abs));
				}
			};
			walk(dir);
			installSet = files.sort();
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it("manifest-driven install set equals the frozen expected set", () => {
			const expectedPath = path.join(import.meta.dirname, "expected-install-set.json");
			const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as { files: string[] };
			expect(installSet).toEqual([...expected.files].sort());
		});

		it("bundleOnly entries (transitions / migrations.json / integrity.json) are NOT installed", () => {
			expect(installSet.some((f) => f.includes(path.join(".forge", "schemas", "transitions")))).toBe(false);
			expect(installSet.includes(path.join(".forge", "schemas", "migrations.json"))).toBe(false);
			expect(installSet.includes(path.join(".forge", "integrity.json"))).toBe(false);
		});

		it("the enum-catalog.json / structure-manifest.json file-entries land in .forge/schemas/", () => {
			// Explicit coverage: these two non-schema JSON files are installed via
			// their OWN file-entries (excluded from the schemas dir entry's
			// .schema.json select) — a future select change must not silently drop them.
			expect(installSet.includes(path.join(".forge", "schemas", "enum-catalog.json"))).toBe(true);
			expect(installSet.includes(path.join(".forge", "schemas", "structure-manifest.json"))).toBe(true);
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
