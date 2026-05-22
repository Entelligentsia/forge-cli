import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * FORGE-S25-T02 — paired test for tools/check-no-skipped-tests.cjs.
 *
 * Exercises the script via spawnSync with an argv array (Iron Law #6: no
 * shell-string interpolation). Each scenario builds an isolated tmp directory
 * with a `test/` subtree, then runs the script with `--root <tmpdir>` so the
 * production globs are evaluated against the fixture, not the live repo.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "check-no-skipped-tests.cjs");

function runScript(rootDir: string) {
	return spawnSync(process.execPath, [SCRIPT, "--root", rootDir], {
		encoding: "utf8",
	});
}

function makeFixture(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "forgecli-skip-gate-"));
	mkdirSync(path.join(dir, "test"), { recursive: true });
	mkdirSync(path.join(dir, "src"), { recursive: true });
	return dir;
}

describe("tools/check-no-skipped-tests.cjs", () => {
	let cleanDir: string;
	let skipDir: string;
	let onlyDir: string;
	let xitDir: string;
	let todoDir: string;

	beforeAll(() => {
		cleanDir = makeFixture();
		writeFileSync(
			path.join(cleanDir, "test", "a.test.ts"),
			`import { it } from "vitest";\nit("clean", () => {});\n`,
		);

		skipDir = makeFixture();
		writeFileSync(
			path.join(skipDir, "test", "b.test.ts"),
			`import { it } from "vitest";\nit.skip("skipped", () => {});\n`,
		);

		onlyDir = makeFixture();
		writeFileSync(
			path.join(onlyDir, "test", "c.test.ts"),
			`import { describe } from "vitest";\ndescribe.only("focused", () => {});\n`,
		);

		xitDir = makeFixture();
		writeFileSync(
			path.join(xitDir, "test", "d.test.ts"),
			`xit("excluded", () => {});\n`,
		);

		todoDir = makeFixture();
		writeFileSync(
			path.join(todoDir, "test", "e.test.ts"),
			`import { it } from "vitest";\n// TODO: re-enable once upstream lands\nit("passes", () => {});\n`,
		);
	});

	afterAll(() => {
		for (const d of [cleanDir, skipDir, onlyDir, xitDir, todoDir]) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("exits 0 silently on a clean tree", () => {
		const r = runScript(cleanDir);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("exits 1 with file:line on it.skip", () => {
		const r = runScript(skipDir);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/b\.test\.ts:\d+/);
	});

	it("exits 1 with file:line on describe.only", () => {
		const r = runScript(onlyDir);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/c\.test\.ts:\d+/);
	});

	it("exits 1 with file:line on xit(", () => {
		const r = runScript(xitDir);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/d\.test\.ts:\d+/);
	});

	it("warns on re-enable TODO without failing (exit 0, message on stderr)", () => {
		const r = runScript(todoDir);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/re-?enable|TODO/i);
	});
});
