// bug-036-payload-lib-completeness.test.ts
//
// Regression guard for FORGE-BUG-036: forge-cli/scripts/build-payload.cjs
// uses a LIB_ALLOWLIST to gate which forge/forge/tools/lib/ files get copied
// into dist/forge-payload/tools/lib/. When a bundled lib file requires a
// sibling that is NOT in the allowlist, the bundle ships broken — every
// invocation of the consumer (e.g. store-cli.cjs -> validate.js -> suggest.cjs)
// crashes with MODULE_NOT_FOUND.
//
// Original incident: T03 (FORGE-S22) added suggest.cjs and made validate.js
// import it; LIB_ALLOWLIST was never updated; every store-cli.cjs invocation
// from forge-cli crashed (observed in emberglow-forge-sprint-intake transcript).
//
// This test walks the bundled tools/lib/ tree, parses local relative imports
// from each file, and asserts each target exists in the same dir. Any missing
// target = a LIB_ALLOWLIST gap.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { getBundledPayloadRoot } from "../../../src/extensions/forgecli/forge-init.js";

const LIB_DIR = path.join(getBundledPayloadRoot(), "tools", "lib");
const REQUIRE_RE = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;

function resolveLocalImport(targetSpec: string, fromDir: string): string[] {
	const base = path.join(fromDir, targetSpec);
	const candidates = [base];
	if (!/\.(cjs|js|mjs|json)$/.test(targetSpec)) {
		candidates.push(`${base}.cjs`, `${base}.js`, `${base}.mjs`);
	}
	return candidates;
}

describe("FORGE-BUG-036: bundled tools/lib/ import completeness", () => {
	it("every local relative import in bundled lib resolves to a sibling that exists", () => {
		expect(fs.existsSync(LIB_DIR)).toBe(true);

		const files = fs
			.readdirSync(LIB_DIR)
			.filter((f) => /\.(cjs|js|mjs)$/.test(f))
			.map((f) => path.join(LIB_DIR, f));

		const missing: string[] = [];

		for (const file of files) {
			const src = fs.readFileSync(file, "utf8");
			let m: RegExpExecArray | null;
			REQUIRE_RE.lastIndex = 0;
			while ((m = REQUIRE_RE.exec(src)) !== null) {
				const spec = m[1];
				const candidates = resolveLocalImport(spec, path.dirname(file));
				if (!candidates.some((c) => fs.existsSync(c))) {
					missing.push(`${path.basename(file)} imports '${spec}' — not found in bundled lib`);
				}
			}
		}

		expect(missing).toEqual([]);
	});

	it("suggest.cjs is present in bundled lib (T03 regression check)", () => {
		expect(fs.existsSync(path.join(LIB_DIR, "suggest.cjs"))).toBe(true);
	});
});
