// payload-manifest-single-source.test.ts — AC3 guard (FORGE-S32-T03).
//
// The three payload consumers (scripts/build-payload.cjs, claude-bootstrap/
// bootstrap.ts, claude-bootstrap/uninstall.ts) must derive WHAT they copy /
// vendor / remove from forge/forge/payload-manifest.json — never from a
// hand-maintained literal array. This static scan fails if any consumer
// re-introduces a duplicated copy/removal list (the FORGE-BUG-030 / FORGE-BUG-036
// MODULE_NOT_FOUND lockstep class) and asserts each consumer actually reads the
// manifest via the shared reader.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const buildPayload = fs.readFileSync(path.join(repoRoot, "scripts/build-payload.cjs"), "utf8");
const bootstrap = fs.readFileSync(path.join(repoRoot, "src/extensions/forgecli/claude-bootstrap/bootstrap.ts"), "utf8");
const uninstall = fs.readFileSync(path.join(repoRoot, "src/extensions/forgecli/claude-bootstrap/uninstall.ts"), "utf8");

describe("AC3 — no re-introduced literal copy/removal lists", () => {
	it("build-payload.cjs does not hard-code the deleted tool/lib/skill allowlists", () => {
		// Sentinel members that previously lived ONLY inside TOOLS_TO_COPY /
		// LIB_ALLOWLIST / SKILLS_TO_COPY literal arrays. Their reappearance as a
		// quoted literal means a hand-list was re-introduced.
		for (const sentinel of [
			'"commit-task.cjs"',
			'"query-logger.cjs"',
			'"forge-preflight.cjs"',
			'"store-query-exec.cjs"',
			'"store-custodian"',
		]) {
			expect(buildPayload.includes(sentinel)).toBe(false);
		}
	});

	it("build-payload.cjs derives tools/lib/skills from the manifest", () => {
		expect(buildPayload).toMatch(/manifestSelect\(["']tools["']\)/);
		expect(buildPayload).toMatch(/manifestSelect\(["']tools\/lib["']\)/);
		expect(buildPayload).toMatch(/manifestSelect\(["']skills["']\)/);
	});

	it("bootstrap.ts vendors from the manifest, not a hard-coded copy table", () => {
		expect(bootstrap).toMatch(/loadManifest\(payloadRoot\)/);
		expect(bootstrap).toMatch(/installEntries\(/);
		// The legacy literal forge-root / claude-asset copy tables are gone.
		expect(bootstrap.includes("FORGE_ROOT_DIRS")).toBe(false);
		expect(bootstrap.includes("CLAUDE_ASSET_DIRS")).toBe(false);
	});

	it("uninstall.ts removes by manifest owner, not a literal .forge/ sub-list", () => {
		expect(uninstall).toMatch(/groupByOwner\(/);
		// The legacy literal removal array (["tools","schemas","init",...]) is gone.
		expect(uninstall).not.toMatch(/\[\s*"tools",\s*"schemas",\s*"init"/);
	});
});
