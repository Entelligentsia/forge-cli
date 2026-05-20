// bug-025-payload-completeness.test.ts
//
// Regression guard for forge-cli#25 defects A and B:
//   A — dist/forge-payload/meta/ directory must be bundled
//   B — three specific tools must be present in dist/forge-payload/tools/
//
// These tests run against the ALREADY-BUILT dist/ so they verify the
// actual shipping payload. Run `npm run build` before running tests.
//
// Iron Law 2: these tests were written BEFORE the build-payload.cjs fix
// and should fail on the unpatched payload, then pass after the fix.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getBundledPayloadRoot } from "../../../src/extensions/forgecli/forge-init.js";

const PAYLOAD_ROOT = getBundledPayloadRoot();

describe("forge-cli#25 defect A — meta/ directory present in bundled payload", () => {
	it("dist/forge-payload/meta/ directory exists", () => {
		const metaDir = path.join(PAYLOAD_ROOT, "meta");
		expect(
			fs.existsSync(metaDir),
			`meta/ directory missing from bundled payload at ${metaDir}. ` +
				"build-payload.cjs must copy forge/forge/meta/ into the payload.",
		).toBe(true);
	});

	it("dist/forge-payload/meta/personas/ contains at least one file", () => {
		const personasDir = path.join(PAYLOAD_ROOT, "meta", "personas");
		expect(fs.existsSync(personasDir), `meta/personas/ not found at ${personasDir}`).toBe(true);
		const files = fs.readdirSync(personasDir).filter((f) => f.endsWith(".md"));
		expect(files.length).toBeGreaterThan(0);
	});

	it("dist/forge-payload/meta/skills/ contains at least one file", () => {
		const skillsDir = path.join(PAYLOAD_ROOT, "meta", "skills");
		expect(fs.existsSync(skillsDir), `meta/skills/ not found at ${skillsDir}`).toBe(true);
		const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
		expect(files.length).toBeGreaterThan(0);
	});
});

describe("forge-cli#25 defect B — three missing tools present in bundled payload", () => {
	const TOOLS_DIR = path.join(PAYLOAD_ROOT, "tools");

	it("check-structure.cjs is bundled in tools/", () => {
		const p = path.join(TOOLS_DIR, "check-structure.cjs");
		expect(
			fs.existsSync(p),
			`check-structure.cjs missing from bundled tools/ at ${p}. ` +
				"Add it to TOOLS_TO_COPY in build-payload.cjs.",
		).toBe(true);
	});

	it("list-skills.js is bundled in tools/", () => {
		const p = path.join(TOOLS_DIR, "list-skills.js");
		expect(
			fs.existsSync(p),
			`list-skills.js missing from bundled tools/ at ${p}. ` +
				"Add it to TOOLS_TO_COPY in build-payload.cjs.",
		).toBe(true);
	});

	it("verify-integrity.cjs is bundled in tools/", () => {
		const p = path.join(TOOLS_DIR, "verify-integrity.cjs");
		expect(
			fs.existsSync(p),
			`verify-integrity.cjs missing from bundled tools/ at ${p}. ` +
				"Add it to TOOLS_TO_COPY in build-payload.cjs.",
		).toBe(true);
	});
});
