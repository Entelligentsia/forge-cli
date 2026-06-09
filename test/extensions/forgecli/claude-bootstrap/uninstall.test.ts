// uninstall.test.ts — Tests for claude-bootstrap/uninstall.ts (4ge uninstall claude).
//
// Integration-style unit tests against the real uninstallClaudeProject() using
// actual fs on tmp dirs (no fs mocking). The fixture bootstraps a project with
// the real bootstrapClaudeProject(), seeds user data, then uninstalls.
//
// Covered:
//   1. refuses when no .bootstrap-manifest.json (bootstrapped=false, ok=false)
//   2. removes the full scaffold, preserves config.json + store (kept) by default
//   3. un-merges Forge hooks from settings.json, preserving a non-Forge hook
//   4. un-appends the Forge .gitignore block, preserving prior content
//   5. idempotent second run — nothing left to remove
//   6. --purge removes config + store too
//   7. preserves a user-authored agent that is not in the payload
//   8. parseUninstallArgs — platform/dir/flags + error paths

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapClaudeProject } from "../../../../src/extensions/forgecli/claude-bootstrap/bootstrap.js";
import { uninstallClaudeProject } from "../../../../src/extensions/forgecli/claude-bootstrap/uninstall.js";
import { parseUninstallArgs } from "../../../../src/bin/uninstall.js";

function makeMinimalPayload(dir: string): string {
	const payloadRoot = path.join(dir, "forge-payload");
	const w = (rel: string, content = "// stub\n") => {
		const p = path.join(payloadRoot, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content, "utf8");
	};
	w("tools/store-cli.cjs");
	w("tools/query-logger.cjs");
	w("tools/package.json", '{\n  "type": "commonjs"\n}\n');
	w("tools/lib/helper.cjs");
	w("hooks/check-update.cjs");
	w("hooks/lib/common.cjs");
	w("schemas/config.schema.json", '{"type":"object"}\n');
	w("schemas/_defs/common.json", '{"$defs":{}}\n');
	w("commands/status.md", "# /forge:status\n");
	w(".base-pack/commands/plan.md", "# /forge:plan\n");
	w(".base-pack/workflows-js/wfl-run-task.js");
	w("init/phases/phase-1-collect.md", "# Phase 1\n");
	w("meta/workflows/meta-migrate.md", "# Meta migrate\n");
	w("agents/tomoshibi.md", "# Tomoshibi agent\n");
	w("skills/refresh-kb-links/SKILL.md", "# refresh-kb-links skill\n");
	w(".claude-plugin/plugin.json", JSON.stringify({ version: "1.2.99" }));
	w("integrity.json", JSON.stringify({ hash: "abc123" }));
	return payloadRoot;
}

let tmpRoot: string;
let payloadRoot: string;
let projDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-uninstall-"));
	payloadRoot = makeMinimalPayload(tmpRoot);
	projDir = path.join(tmpRoot, "proj");
	fs.mkdirSync(projDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedUserData(): void {
	// Simulate post-/forge:init user data the scaffold must never destroy.
	fs.writeFileSync(path.join(projDir, ".forge", "config.json"), JSON.stringify({ prefix: "ACME" }), "utf8");
	fs.writeFileSync(path.join(projDir, ".forge", "store", "sprints", "ACME-S01.json"), '{"id":"ACME-S01"}', "utf8");
	fs.mkdirSync(path.join(projDir, "engineering"), { recursive: true });
	fs.writeFileSync(path.join(projDir, "engineering", "MASTER_INDEX.md"), "# KB\n", "utf8");
}

describe("uninstallClaudeProject", () => {
	it("refuses when no .bootstrap-manifest.json is present", () => {
		// Fresh dir, never bootstrapped.
		const r = uninstallClaudeProject({ dir: projDir, payloadRoot, purge: false });
		expect(r.bootstrapped).toBe(false);
		expect(r.ok).toBe(false);
		expect(r.removed).toEqual([]);
		expect(r.warnings.join(" ")).toMatch(/not a forge-bootstrapped project/i);
	});

	it("removes the scaffold but preserves config.json + store by default", () => {
		bootstrapClaudeProject({ dir: projDir, payloadRoot });
		seedUserData();

		const r = uninstallClaudeProject({ dir: projDir, payloadRoot, purge: false });

		expect(r.ok).toBe(true);
		expect(r.bootstrapped).toBe(true);

		// Scaffold gone.
		expect(fs.existsSync(path.join(projDir, ".forge", "tools"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge", "schemas"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge", "init"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge", ".base-pack"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge", "meta"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge", ".claude-plugin"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge", ".bootstrap-manifest.json"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".claude", "commands", "forge"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".claude", "workflows"))).toBe(false);

		// User data preserved.
		expect(fs.existsSync(path.join(projDir, ".forge", "config.json"))).toBe(true);
		expect(fs.existsSync(path.join(projDir, ".forge", "store", "sprints", "ACME-S01.json"))).toBe(true);
		expect(fs.existsSync(path.join(projDir, "engineering", "MASTER_INDEX.md"))).toBe(true);
		expect(r.kept.some((p) => p.endsWith("config.json"))).toBe(true);
		expect(r.kept.some((p) => p.endsWith(path.join(".forge", "store")))).toBe(true);
	});

	it("un-merges Forge hooks from settings.json while preserving a non-Forge hook", () => {
		bootstrapClaudeProject({ dir: projDir, payloadRoot });
		// Inject a non-Forge hook alongside the Forge ones.
		const settingsPath = path.join(projDir, ".claude", "settings.json");
		const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		s.hooks.SessionStart.push({ hooks: [{ type: "command", command: "node ./my-own-hook.js", timeout: 1000 }] });
		fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));

		uninstallClaudeProject({ dir: projDir, payloadRoot, purge: false });

		const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const allCommands = JSON.stringify(after);
		expect(allCommands).not.toMatch(/\.forge\/tools\//); // Forge hooks gone
		expect(allCommands).toMatch(/my-own-hook\.js/); // user hook preserved
	});

	it("un-appends the Forge .gitignore block, preserving prior content", () => {
		fs.writeFileSync(path.join(projDir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
		bootstrapClaudeProject({ dir: projDir, payloadRoot });

		uninstallClaudeProject({ dir: projDir, payloadRoot, purge: false });

		const gi = fs.readFileSync(path.join(projDir, ".gitignore"), "utf8");
		expect(gi).toContain("node_modules/");
		expect(gi).not.toContain(".forge/store/events/");
	});

	it("is idempotent — a second run removes nothing more", () => {
		bootstrapClaudeProject({ dir: projDir, payloadRoot });
		seedUserData();
		uninstallClaudeProject({ dir: projDir, payloadRoot, purge: false });
		// Manifest is gone, so a second run refuses (bootstrapped=false) — clean no-op.
		const second = uninstallClaudeProject({ dir: projDir, payloadRoot, purge: false });
		expect(second.removed).toEqual([]);
	});

	it("--purge also removes config.json and store", () => {
		bootstrapClaudeProject({ dir: projDir, payloadRoot });
		seedUserData();

		const r = uninstallClaudeProject({ dir: projDir, payloadRoot, purge: true });

		expect(r.ok).toBe(true);
		expect(fs.existsSync(path.join(projDir, ".forge", "config.json"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge", "store"))).toBe(false);
		expect(fs.existsSync(path.join(projDir, ".forge"))).toBe(false); // empty → removed
		// KB folder is never auto-removed, even on purge.
		expect(fs.existsSync(path.join(projDir, "engineering", "MASTER_INDEX.md"))).toBe(true);
		expect(r.kept).toEqual([]);
	});

	it("preserves a user-authored agent that is not part of the payload", () => {
		bootstrapClaudeProject({ dir: projDir, payloadRoot });
		const userAgent = path.join(projDir, ".claude", "agents", "my-custom-agent.md");
		fs.writeFileSync(userAgent, "# my agent\n", "utf8");

		uninstallClaudeProject({ dir: projDir, payloadRoot, purge: false });

		// Forge's tomoshibi.md removed; user's custom agent + the dir survive.
		expect(fs.existsSync(path.join(projDir, ".claude", "agents", "tomoshibi.md"))).toBe(false);
		expect(fs.existsSync(userAgent)).toBe(true);
	});
});

describe("parseUninstallArgs", () => {
	it("requires a platform argument", () => {
		const r = parseUninstallArgs([]);
		expect("error" in r && r.error).toMatch(/platform argument required/);
	});

	it("rejects an unknown platform", () => {
		const r = parseUninstallArgs(["windsurf"]);
		expect("error" in r && r.error).toMatch(/unknown platform/);
	});

	it("defaults dir to cwd and flags to false", () => {
		const r = parseUninstallArgs(["claude"]);
		expect("platform" in r && r.platform).toBe("claude");
		expect("dir" in r && r.dir).toBe(process.cwd());
		expect("purge" in r && r.purge).toBe(false);
		expect("yes" in r && r.yes).toBe(false);
	});

	it("parses dir + --purge + --yes in any order", () => {
		const r = parseUninstallArgs(["claude", "--purge", "/tmp/x", "-y"]);
		expect("dir" in r && r.dir).toBe(path.resolve("/tmp/x"));
		expect("purge" in r && r.purge).toBe(true);
		expect("yes" in r && r.yes).toBe(true);
	});

	it("rejects an unknown flag", () => {
		const r = parseUninstallArgs(["claude", "--force"]);
		expect("error" in r && r.error).toMatch(/unknown option/);
	});
});
