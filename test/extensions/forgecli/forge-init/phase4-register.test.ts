// phase4-register.test.ts — FORGE-S25-T24 (B-5)
// Unit tests for forge-init/phase4-register.ts:
//   - runPhase4(): step 4-1 abort on missing store-cli, advisory non-fatal steps,
//     kbPathFinal extraction from configCache, deleteInitProgress called on completion.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Phase4Context, runPhase4 } from "../../../../src/extensions/forgecli/forge-init/phase4-register.js";

// ── Test utilities ─────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "phase4-test-"));
}

function rmTmpDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function makeCtx(): {
	ui: {
		notify: ReturnType<typeof vi.fn>;
		confirm: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
	};
} {
	return {
		ui: {
			notify: vi.fn(),
			confirm: vi.fn().mockResolvedValue(true),
			setStatus: vi.fn(),
		},
	};
}

function makeCtx4(tmpDir: string, bundleRoot: string, overrides: Partial<Phase4Context> = {}): Phase4Context {
	const ctx = makeCtx();
	return {
		cwd: tmpDir,
		bundleRoot,
		toolsRoot: path.join(bundleRoot, "tools"),
		projectName: "TestProject",
		configCache: {},
		ctx: ctx as never,
		isPiRuntime: () => true,
		getBundledToolsRoot: () => path.join(bundleRoot, "tools"),
		...overrides,
	};
}

/**
 * Create a minimal bundle structure so phase4 can proceed past most guards.
 * Returns bundleRoot.
 */
function makeBundle(dir: string, opts: { storeCli?: boolean; pluginJson?: boolean } = {}): string {
	const bundleRoot = path.join(dir, "bundle");
	const toolsRoot = path.join(bundleRoot, "tools");
	fs.mkdirSync(toolsRoot, { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, ".claude-plugin"), { recursive: true });

	if (opts.storeCli !== false) {
		fs.writeFileSync(path.join(toolsRoot, "store-cli.cjs"), "// stub", "utf8");
	}
	// manage-config.cjs — required for step 4-1 to proceed
	fs.writeFileSync(path.join(toolsRoot, "manage-config.cjs"), "// stub", "utf8");

	if (opts.pluginJson !== false) {
		fs.writeFileSync(
			path.join(bundleRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ version: "0.15.5" }),
			"utf8",
		);
	}

	return bundleRoot;
}

// ── Step 4-1: store-cli.cjs missing → abort ───────────────────────────────

describe("runPhase4 — step 4-1 abort on missing store-cli", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	it("returns 'abort' when store-cli.cjs is missing", async () => {
		const bundleRoot = makeBundle(tmpDir, { storeCli: false });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, { isPiRuntime: () => true });

		const result = await runPhase4(ctx4);

		expect(result).toBe("abort");
	});

	it("emits an error notification when store-cli is missing", async () => {
		const bundleRoot = makeBundle(tmpDir, { storeCli: false });
		const ctx = makeCtx();
		const ctx4: Phase4Context = {
			...makeCtx4(tmpDir, bundleRoot),
			ctx: ctx as never,
			isPiRuntime: () => true,
		};

		await runPhase4(ctx4);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("store-cli.cjs missing"), "error");
	});

	it("does NOT return 'abort' when store-cli.cjs exists", async () => {
		const bundleRoot = makeBundle(tmpDir, { storeCli: true });
		// Minimal cwd setup so downstream steps don't throw
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, { isPiRuntime: () => true });

		const result = await runPhase4(ctx4);

		// Should return Phase4Result, not "abort"
		expect(result).not.toBe("abort");
	});
});

// ── kbPathFinal from configCache ───────────────────────────────────────────

describe("runPhase4 — kbPathFinal extraction from configCache", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	it("returns kbPathFinal from configCache.paths.engineering", async () => {
		const bundleRoot = makeBundle(tmpDir);
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, {
			configCache: { paths: { engineering: "my-custom-kb" } },
			isPiRuntime: () => true,
		});

		const result = await runPhase4(ctx4);

		expect(result).not.toBe("abort");
		if (result !== "abort") {
			expect(result.kbPathFinal).toBe("my-custom-kb");
		}
	});

	it("defaults kbPathFinal to 'engineering' when configCache.paths is absent", async () => {
		const bundleRoot = makeBundle(tmpDir);
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, { configCache: {}, isPiRuntime: () => true });

		const result = await runPhase4(ctx4);

		expect(result).not.toBe("abort");
		if (result !== "abort") {
			expect(result.kbPathFinal).toBe("engineering");
		}
	});
});

// ── deleteInitProgress called on completion ────────────────────────────────

describe("runPhase4 — deleteInitProgress called on success", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	it("deletes .forge/init-progress.json after all steps complete", async () => {
		const bundleRoot = makeBundle(tmpDir);
		const forgeDir = path.join(tmpDir, ".forge");
		fs.mkdirSync(forgeDir, { recursive: true });
		const progressPath = path.join(forgeDir, "init-progress.json");
		fs.writeFileSync(progressPath, JSON.stringify({ lastPhase: 3 }), "utf8");

		expect(fs.existsSync(progressPath)).toBe(true);

		const ctx4 = makeCtx4(tmpDir, bundleRoot, { isPiRuntime: () => true });
		const result = await runPhase4(ctx4);

		expect(result).not.toBe("abort");
		expect(fs.existsSync(progressPath)).toBe(false);
	});

	it("does NOT delete progress when abort is returned (store-cli missing)", async () => {
		const bundleRoot = makeBundle(tmpDir, { storeCli: false });
		const forgeDir = path.join(tmpDir, ".forge");
		fs.mkdirSync(forgeDir, { recursive: true });
		const progressPath = path.join(forgeDir, "init-progress.json");
		fs.writeFileSync(progressPath, JSON.stringify({ lastPhase: 3 }), "utf8");

		const ctx4 = makeCtx4(tmpDir, bundleRoot, { isPiRuntime: () => true });
		await runPhase4(ctx4);

		// Progress file should still exist — we aborted at step 4-1
		expect(fs.existsSync(progressPath)).toBe(true);
	});
});

// ── Step 4-3: generation-manifest seed from KB dir ────────────────────────

const STUB_GENERATION_MANIFEST = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const [,, subcmd, ...rest] = process.argv;
const MANIFEST_PATH = path.join(process.cwd(), '.forge', 'generation-manifest.json');
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { return { files: {} }; }
}
function writeManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\\n', 'utf8');
}
if (subcmd === 'record') {
  const filePath = rest[0];
  const m = readManifest();
  if (!m.files) m.files = {};
  m.files[path.relative(process.cwd(), path.resolve(filePath))] = { hash: 'stub-hash', generatedAt: new Date().toISOString() };
  writeManifest(m);
  process.stdout.write('〇 Recorded: ' + filePath + '\\n');
  process.exit(0);
} else if (subcmd === 'record-all') {
  const m = readManifest();
  const count = Object.keys(m.files || {}).length;
  if (count === 0) { process.stdout.write('── No files tracked — nothing to re-hash.\\n'); process.exit(0); }
  process.stdout.write('〇 Re-hashed ' + count + ' file(s).\\n');
  process.exit(0);
} else {
  process.stderr.write('Unknown subcommand: ' + subcmd + '\\n');
  process.exit(2);
}
`;

describe("runPhase4 — step 4-3 generation-manifest seeds KB .md files inline path", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	function makeBundleWithManifestStub(dir: string): string {
		const bundleRoot = makeBundle(dir);
		fs.writeFileSync(path.join(bundleRoot, "tools", "generation-manifest.cjs"), STUB_GENERATION_MANIFEST, "utf8");
		return bundleRoot;
	}

	it("records all .md files in the KB dir when manifest starts empty (inline Phase 2 path)", async () => {
		const bundleRoot = makeBundleWithManifestStub(tmpDir);

		const kbDir = path.join(tmpDir, "engineering");
		fs.mkdirSync(path.join(kbDir, "architecture"), { recursive: true });
		fs.writeFileSync(path.join(kbDir, "architecture", "stack.md"), "# Stack", "utf8");
		fs.writeFileSync(path.join(kbDir, "MASTER_INDEX.md"), "# Index", "utf8");

		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, {
			configCache: { paths: { engineering: "engineering" } },
			isPiRuntime: () => true,
		});

		const result = await runPhase4(ctx4);
		expect(result).not.toBe("abort");

		const manifestPath = path.join(tmpDir, ".forge", "generation-manifest.json");
		expect(fs.existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			files: Record<string, unknown>;
		};
		expect(Object.keys(manifest.files)).toContain("engineering/architecture/stack.md");
		expect(Object.keys(manifest.files)).toContain("engineering/MASTER_INDEX.md");
	});

	it("does not crash when KB dir is absent (no .md files to seed)", async () => {
		const bundleRoot = makeBundleWithManifestStub(tmpDir);
		// No KB dir created
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, {
			configCache: { paths: { engineering: "engineering" } },
			isPiRuntime: () => true,
		});

		const result = await runPhase4(ctx4);
		expect(result).not.toBe("abort");
		// Manifest should not exist (nothing seeded, record-all no-op on empty)
		const manifestPath = path.join(tmpDir, ".forge", "generation-manifest.json");
		expect(fs.existsSync(manifestPath)).toBe(false);
	});

	it("uses configCache.paths.engineering to find the KB dir", async () => {
		const bundleRoot = makeBundleWithManifestStub(tmpDir);

		const kbDir = path.join(tmpDir, "my-docs");
		fs.mkdirSync(kbDir, { recursive: true });
		fs.writeFileSync(path.join(kbDir, "notes.md"), "# Notes", "utf8");

		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, {
			configCache: { paths: { engineering: "my-docs" } },
			isPiRuntime: () => true,
		});

		await runPhase4(ctx4);

		const manifestPath = path.join(tmpDir, ".forge", "generation-manifest.json");
		expect(fs.existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			files: Record<string, unknown>;
		};
		expect(Object.keys(manifest.files)).toContain("my-docs/notes.md");
	});
});

// ── Advisory non-fatal steps ──────────────────────────────────────────────

describe("runPhase4 — advisory non-fatal steps", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => rmTmpDir(tmpDir));

	it("proceeds past step 4-8 even if plugin.json is missing (non-fatal)", async () => {
		// Remove plugin.json to simulate missing file
		const bundleRoot = makeBundle(tmpDir, { pluginJson: false });
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx = makeCtx();
		const ctx4: Phase4Context = {
			...makeCtx4(tmpDir, bundleRoot),
			ctx: ctx as never,
			isPiRuntime: () => true,
		};

		const result = await runPhase4(ctx4);

		// Should NOT abort — step 4-8 is non-fatal
		expect(result).not.toBe("abort");
		// Should emit a warning about non-fatal
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("update-check cache"), "warning");
	});

	it("proceeds past step 4-4 (build-persona-pack) even when tool is absent", async () => {
		const bundleRoot = makeBundle(tmpDir);
		// Do NOT create build-persona-pack.cjs
		fs.mkdirSync(path.join(tmpDir, ".forge"), { recursive: true });
		const ctx4 = makeCtx4(tmpDir, bundleRoot, { isPiRuntime: () => true });

		const result = await runPhase4(ctx4);

		expect(result).not.toBe("abort");
	});
});
