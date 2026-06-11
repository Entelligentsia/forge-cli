// payload-requires-walker.test.ts
//
// Failing-first spec (Iron Law 2) for FORGE-S32-T04: a deterministic,
// build-side require-walker that statically proves every require() target and
// referenced runtime path in the bundled payload's .cjs/.js tools and hooks
// resolves inside the bundle. Generalizes the two narrow guards
// (bug-025-payload-completeness, bug-036-payload-lib-completeness) into one
// walker over ALL .cjs/.js under dist/forge-payload/{tools,hooks}.
//
// Exit/return contract:
//   ok:true,  code 0  — every static require + enumerated dynamic target resolves
//   ok:false, code 1  — one or more unresolvable targets OR an un-enumerated
//                        dynamic require(<variable>) site (Iron Law 5 guard)
//   code 2            — bad invocation / payloadRoot not found (CLI only)

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getBundledPayloadRoot } from "../../../src/extensions/forgecli/forge-init/forge-init.js";

const _DIR = path.dirname(fileURLToPath(import.meta.url));
const WALKER = path.resolve(_DIR, "../../../tools/check-payload-requires.cjs");
const FIXTURES = path.resolve(_DIR, "../../fixtures/payload-requires");

const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadWalker(): any {
	return require_(WALKER);
}

/** Run the walker CLI; capture exit code + stderr without throwing. */
function runCli(payloadRoot: string): { code: number; stderr: string; stdout: string } {
	try {
		const stdout = execFileSync(process.execPath, [WALKER, payloadRoot], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, stderr: "", stdout };
	} catch (err) {
		const e = err as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
		return {
			code: typeof e.status === "number" ? e.status : 1,
			stderr: String(e.stderr ?? ""),
			stdout: String(e.stdout ?? ""),
		};
	}
}

describe("FORGE-S32-T04: payload require-walker — programmatic API", () => {
	it("exports checkPayloadRequires(payloadRoot, opts)", () => {
		const mod = loadWalker();
		expect(typeof mod.checkPayloadRequires).toBe("function");
	});

	it("resolves a clean synthetic payload (static + bare + .js consumer + comment-ghost) — ok:true", () => {
		const { checkPayloadRequires } = loadWalker();
		const res = checkPayloadRequires(path.join(FIXTURES, "good"));
		expect(res.ok).toBe(true);
		expect(res.unresolved).toEqual([]);
		expect(res.unenumeratedDynamic).toEqual([]);
		// The .js consumer (tools/c.js) must actually be walked, not skipped.
		expect(res.scannedFiles).toContain("tools/c.js");
	});

	it("flags a missing static require target and names it — ok:false", () => {
		const { checkPayloadRequires } = loadWalker();
		const res = checkPayloadRequires(path.join(FIXTURES, "missing-target"));
		expect(res.ok).toBe(false);
		expect(res.unresolved.some((u: { target: string }) => u.target.includes("nope"))).toBe(true);
	});

	it("hard-fails an un-enumerated dynamic require(variable) site (Iron Law 5)", () => {
		const { checkPayloadRequires } = loadWalker();
		const res = checkPayloadRequires(path.join(FIXTURES, "dynamic-unenumerated"));
		expect(res.ok).toBe(false);
		expect(res.unenumeratedDynamic.length).toBeGreaterThan(0);
		expect(res.unenumeratedDynamic[0].file).toBe("tools/d.cjs");
	});

	it("passes an enumerated dynamic site whose injected allowlist target resolves", () => {
		const { checkPayloadRequires } = loadWalker();
		const res = checkPayloadRequires(path.join(FIXTURES, "dynamic-enumerated"), {
			dynamicSites: [{ file: "tools/d.cjs", expr: "require(modName)", targets: ["tools/target.cjs"] }],
		});
		expect(res.ok).toBe(true);
		expect(res.unenumeratedDynamic).toEqual([]);
	});

	it("fails an enumerated dynamic site whose declared target is missing", () => {
		const { checkPayloadRequires } = loadWalker();
		const res = checkPayloadRequires(path.join(FIXTURES, "dynamic-enumerated"), {
			dynamicSites: [{ file: "tools/d.cjs", expr: "require(modName)", targets: ["tools/ghost.cjs"] }],
		});
		expect(res.ok).toBe(false);
		expect(res.unresolved.some((u: { target: string }) => u.target.includes("ghost"))).toBe(true);
	});
});

describe("FORGE-S32-T04: payload require-walker — CLI contract", () => {
	it("exits 0 on the clean good fixture", () => {
		expect(runCli(path.join(FIXTURES, "good")).code).toBe(0);
	});

	it("exits 1 and lists the target on the missing-target fixture", () => {
		const r = runCli(path.join(FIXTURES, "missing-target"));
		expect(r.code).toBe(1);
		expect(r.stderr).toMatch(/nope/);
	});

	it("exits 1 on an un-enumerated dynamic require site", () => {
		expect(runCli(path.join(FIXTURES, "dynamic-unenumerated")).code).toBe(1);
	});

	it("exits 2 on a non-existent payload root", () => {
		expect(runCli(path.join(FIXTURES, "does-not-exist")).code).toBe(2);
	});
});

describe("FORGE-S32-T04: green on the real built payload", () => {
	it("checkPayloadRequires resolves the entire bundled payload — ok:true", () => {
		const { checkPayloadRequires } = loadWalker();
		const res = checkPayloadRequires(getBundledPayloadRoot());
		const detail = JSON.stringify(
			{ unresolved: res.unresolved, unenumeratedDynamic: res.unenumeratedDynamic },
			null,
			2,
		);
		expect(res.ok, `walker found unresolved bundle references:\n${detail}`).toBe(true);
	});
});
