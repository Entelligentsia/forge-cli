import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Paired test for tools/check-import-layering.cjs.
 *
 * Exercises the script via spawnSync with an argv array (Iron Law #6: no
 * shell-string interpolation). Each scenario builds an isolated tmp directory
 * mirroring src/extensions/forgecli/, then runs the script with
 * `--root <tmpdir>` so the layer rules are evaluated against the fixture,
 * not the live repo.
 *
 * Enforced rules (see script header):
 *   1. lib/     may relative-import only within lib/
 *   2. paths/   may relative-import only within paths/
 *   3. parsers/ may relative-import only within parsers/ or into lib/
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "check-import-layering.cjs");
const EXT_DIR = path.join("src", "extensions", "forgecli");

function runScript(rootDir: string) {
	return spawnSync(process.execPath, [SCRIPT, "--root", rootDir], {
		encoding: "utf8",
	});
}

function makeFixture(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "forgecli-layer-gate-"));
	for (const sub of ["lib", "paths", "parsers"]) {
		mkdirSync(path.join(dir, EXT_DIR, sub), { recursive: true });
	}
	return dir;
}

function writeExt(dir: string, rel: string, content: string) {
	writeFileSync(path.join(dir, EXT_DIR, rel), content);
}

describe("tools/check-import-layering.cjs", () => {
	let cleanDir: string;
	let libUpwardDir: string;
	let pathsUpwardDir: string;
	let parsersOkDir: string;
	let parsersBadDir: string;
	let dynamicImportDir: string;

	beforeAll(() => {
		cleanDir = makeFixture();
		writeExt(cleanDir, "lib/a.ts", `import { b } from "./b.js";\nexport const a = b;\n`);
		writeExt(cleanDir, "lib/b.ts", `import * as fs from "node:fs";\nexport const b = 1;\n`);
		writeExt(cleanDir, "top.ts", `import { a } from "./lib/a.js";\nexport const t = a;\n`);

		libUpwardDir = makeFixture();
		writeExt(libUpwardDir, "lib/bad.ts", `import { x } from "../config-layer.js";\nexport const y = x;\n`);

		pathsUpwardDir = makeFixture();
		writeExt(pathsUpwardDir, "paths/bad.ts", `import { x } from "../lib/a.js";\nexport const y = x;\n`);

		parsersOkDir = makeFixture();
		writeExt(parsersOkDir, "parsers/ok.ts", `import { a } from "../lib/a.js";\nexport const y = a;\n`);

		parsersBadDir = makeFixture();
		writeExt(parsersBadDir, "parsers/bad.ts", `import { x } from "../forge-tools.js";\nexport const y = x;\n`);

		dynamicImportDir = makeFixture();
		writeExt(
			dynamicImportDir,
			"lib/bad-dynamic.ts",
			`export async function f() {\n\treturn import("../model-resolver.js");\n}\n`,
		);
	});

	afterAll(() => {
		for (const d of [cleanDir, libUpwardDir, pathsUpwardDir, parsersOkDir, parsersBadDir, dynamicImportDir]) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("exits 0 silently on a clean tree", () => {
		const r = runScript(cleanDir);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("exits 1 with file:line when lib/ imports upward", () => {
		const r = runScript(libUpwardDir);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/lib[/\\]bad\.ts:\d+/);
	});

	it("exits 1 when paths/ imports outside paths/", () => {
		const r = runScript(pathsUpwardDir);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/paths[/\\]bad\.ts:\d+/);
	});

	it("allows parsers/ to import lib/", () => {
		const r = runScript(parsersOkDir);
		expect(r.status).toBe(0);
	});

	it("exits 1 when parsers/ imports a non-lib top-level module", () => {
		const r = runScript(parsersBadDir);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/parsers[/\\]bad\.ts:\d+/);
	});

	it("catches dynamic import() escapes from lib/", () => {
		const r = runScript(dynamicImportDir);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/bad-dynamic\.ts:\d+/);
	});

	it("live repo passes the gate (the rules reflect reality)", () => {
		const r = runScript(REPO_ROOT);
		expect(r.stdout + r.stderr).toBe("");
		expect(r.status).toBe(0);
	});
});
