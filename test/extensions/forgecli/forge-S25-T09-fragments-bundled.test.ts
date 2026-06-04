// forge-S25-T09-fragments-bundled.test.ts
//
// Regression guard for FORGE-S25-T09: the `meta/workflows/_fragments/`
// surface must survive `build-payload.cjs` bundling and reach both the
// `dist/forge-payload/meta/` and `dist/forge-payload/.base-pack/` trees.
//
// Why a dedicated file (rather than extending bug-025-payload-completeness):
// bug-025 is a named regression guard for a closed defect (forge-cli#25,
// defects A + B). Mixing forward-looking sprint coverage into it muddies
// the audit trail. This file is the FORGE-S25-T09 gating contract.
//
// Why the implicit-allowlist matters: build-payload.cjs uses a recursive
// `copyDir(metaSrcDir, metaDestDir)` for `meta/` and a recursive
// `copyDir(basePackSrc, basePackDest)` for `.base-pack/`. `_fragments/`
// rides on those recursive copies — there is no explicit allowlist entry.
// Any refactor toward per-subdir explicit copy could silently drop
// `_fragments/`. This test converts that implicit guarantee into a
// defended invariant.
//
// Empty-file pinning (per TASK_PROMPT planner-callout): zero-byte fragment
// files must round-trip the migration-engine walker unchanged. The
// `test/fixtures/_fragments/EMPTY_FIXTURE.md` companion exercises that
// half of the wiring — see the new case in `migration-engine.test.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getBundledPayloadRoot } from "../../../src/extensions/forgecli/forge-init/forge-init.js";

const PAYLOAD_ROOT = getBundledPayloadRoot();
const META_FRAGMENTS_DIR = path.join(PAYLOAD_ROOT, "meta", "workflows", "_fragments");
const BASE_PACK_FRAGMENTS_DIR = path.join(PAYLOAD_ROOT, ".base-pack", "workflows", "_fragments");

// Source of truth — the plugin's authoring location. Tests below cross-check
// that every authored fragment survives the bundling step into BOTH bundled
// paths. Path resolved relative to the forge-cli package root, mirroring how
// `build-payload.cjs` locates the sibling-forge clone.
const FORGE_PLUGIN_FRAGMENTS_SRC = path.resolve(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"forge",
	"forge",
	"meta",
	"workflows",
	"_fragments",
);

function listMarkdown(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

describe("FORGE-S25-T09 — _fragments/ surface bundled in meta/", () => {
	it("dist/forge-payload/meta/workflows/_fragments/ exists", () => {
		expect(
			fs.existsSync(META_FRAGMENTS_DIR),
			`meta/workflows/_fragments/ missing from bundled payload at ${META_FRAGMENTS_DIR}. ` +
				"build-payload.cjs must recursively copy forge/forge/meta/ — _fragments/ rides on that.",
		).toBe(true);
	});

	it("dist/forge-payload/meta/workflows/_fragments/ contains ≥1 markdown fragment", () => {
		const files = listMarkdown(META_FRAGMENTS_DIR);
		expect(files.length, `expected ≥1 .md fragment in ${META_FRAGMENTS_DIR}`).toBeGreaterThan(0);
	});
});

describe("FORGE-S25-T09 — _fragments/ surface bundled in .base-pack/", () => {
	it("dist/forge-payload/.base-pack/workflows/_fragments/ exists", () => {
		expect(
			fs.existsSync(BASE_PACK_FRAGMENTS_DIR),
			`.base-pack/workflows/_fragments/ missing from bundled payload at ${BASE_PACK_FRAGMENTS_DIR}. ` +
				"build-payload.cjs must recursively copy forge/forge/init/base-pack/.",
		).toBe(true);
	});

	it("dist/forge-payload/.base-pack/workflows/_fragments/ contains ≥1 markdown fragment", () => {
		const files = listMarkdown(BASE_PACK_FRAGMENTS_DIR);
		expect(files.length, `expected ≥1 .md fragment in ${BASE_PACK_FRAGMENTS_DIR}`).toBeGreaterThan(0);
	});
});

describe("FORGE-S25-T09 — _fragments/ name parity (source → meta + base-pack)", () => {
	// Pinning assertion: every fragment present in the plugin's authoring
	// directory must be present in BOTH bundled paths. Cross-check that
	// build-payload's recursive copy is not silently filtering by name.
	//
	// This test SKIPs (records WARN-style) if the sibling-forge source dir is
	// absent (e.g. CI matrix runs without the sibling clone). In the standard
	// forge-engineering dev layout the directory is always present.
	const sourceAvailable = fs.existsSync(FORGE_PLUGIN_FRAGMENTS_SRC);

	it.runIf(sourceAvailable)("every authored fragment appears in dist/forge-payload/meta/workflows/_fragments/", () => {
		const authored = listMarkdown(FORGE_PLUGIN_FRAGMENTS_SRC);
		const bundled = listMarkdown(META_FRAGMENTS_DIR);
		for (const name of authored) {
			expect(bundled, `authored fragment ${name} missing from bundled meta/ path`).toContain(name);
		}
	});

	it.runIf(sourceAvailable)(
		"every authored fragment appears in dist/forge-payload/.base-pack/workflows/_fragments/",
		() => {
			const authored = listMarkdown(FORGE_PLUGIN_FRAGMENTS_SRC);
			const bundled = listMarkdown(BASE_PACK_FRAGMENTS_DIR);
			for (const name of authored) {
				expect(bundled, `authored fragment ${name} missing from bundled .base-pack/ path`).toContain(name);
			}
		},
	);
});
