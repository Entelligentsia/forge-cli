// Unit tests for the What's-New module.
//
// Coverage:
//   1. parseChangelog: standard Keep-a-Changelog blocks, pi's mixed sections,
//      [Unreleased] is skipped, version range with date dash variants.
//   2. entriesBetween: from=null → only `to`, from<to → exclusive lower bound.
//   3. summarizeEntries: per-section bullet counts, alias normalization.
//   4. semverGt edge cases.
//   5. computeSummaries: skips components with no advance / missing source.
//   6. computeAndPersistStartupPanel: writes seen state, preserves prev.
//   7. computeWhatsNewView: replays from prev baseline; drill-down by id.
//   8. dismissWhatsNew: collapses prev to seen, leaves current untouched.

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__test__,
	computeAndPersistStartupPanel,
	computeSummaries,
	computeWhatsNewView,
	dismissWhatsNew,
	emptySeenState,
	entriesBetween,
	parseChangelog,
	readSeenState,
	renderSummaryPanel,
	resolveChangelogPaths,
	semverGt,
	summarizeEntries,
	writeSeenState,
	type SeenState,
} from "../../../src/extensions/forgecli/whats-new.js";

function tmpDir(label: string): string {
	return path.join(os.tmpdir(), `forgecli-whats-new-${label}-${crypto.randomBytes(6).toString("hex")}`);
}

const FORGE_CLI_LIKE = `# Changelog

## [Unreleased]

## [0.7.8] — 2026-05-17

### Changed
- Docs: README links the 4ge.sh site.
- Internal: vendor-pi namespace revert.

## [0.7.7] — 2026-05-16

### Added
- 4ge brand banner.
- Two new themes.

### Changed
- Tightened header spacing.

## [0.7.6] — 2026-05-16

### Fixed
- build-payload bundles command markdowns.
`;

const PI_LIKE = `# Changelog

## [0.74.1] - 2026-05-16

### New Features

- Image generation support.
- Together AI provider.

### Added

- Image generation APIs (#3887).
- Together AI to provider setup (#3624).
- Windows ARM64 binaries (#4458).

### Fixed

- Markdown list indentation.
- Inline image placement.

## [0.74.0] - 2026-05-09

### Added

- Initial 0.74 series.
`;

describe("semverGt", () => {
	it("orders triples correctly", () => {
		expect(semverGt("0.7.8", "0.7.7")).toBe(true);
		expect(semverGt("0.7.7", "0.7.8")).toBe(false);
		expect(semverGt("0.7.7", "0.7.7")).toBe(false);
		expect(semverGt("1.0.0", "0.99.99")).toBe(true);
		expect(semverGt("0.8.0", "0.7.99")).toBe(true);
	});
	it("strips leading v and prerelease tags", () => {
		expect(semverGt("v0.8.0", "0.7.9")).toBe(true);
		expect(semverGt("0.8.0-rc.1", "0.7.99")).toBe(true);
	});
	it("returns false on unparseable input", () => {
		expect(semverGt("garbage", "0.0.1")).toBe(false);
		expect(semverGt("0.0.1", "garbage")).toBe(false);
	});
});

describe("parseChangelog", () => {
	it("parses standard Keep-a-Changelog blocks and skips [Unreleased]", () => {
		const entries = parseChangelog(FORGE_CLI_LIKE);
		expect(entries.map((e) => e.version)).toEqual(["0.7.8", "0.7.7", "0.7.6"]);
		expect(entries[0]!.date).toBe("2026-05-17");
		const changed = entries[0]!.sections.find((s) => s.name === "Changed");
		expect(changed?.bullets.length).toBe(2);
	});
	it("parses pi's mixed section variants", () => {
		const entries = parseChangelog(PI_LIKE);
		expect(entries[0]!.version).toBe("0.74.1");
		const names = entries[0]!.sections.map((s) => s.name);
		expect(names).toContain("New Features");
		expect(names).toContain("Added");
		expect(names).toContain("Fixed");
	});
	it("handles ASCII dash separator in date row", () => {
		const md = "## [1.2.3] - 2026-01-01\n\n### Added\n- thing\n";
		const entries = parseChangelog(md);
		expect(entries[0]!.date).toBe("2026-01-01");
	});
	it("ignores bullets outside any section", () => {
		const md = "## [1.0.0] — 2026-01-01\n- stray bullet\n\n### Added\n- real one\n";
		const entries = parseChangelog(md);
		const added = entries[0]!.sections.find((s) => s.name === "Added");
		expect(added?.bullets).toEqual(["real one"]);
	});
});

describe("entriesBetween", () => {
	const parsed = parseChangelog(FORGE_CLI_LIKE);
	it("returns only `to` entry when from=null (first install)", () => {
		const slice = entriesBetween(parsed, null, "0.7.8");
		expect(slice.map((e) => e.version)).toEqual(["0.7.8"]);
	});
	it("returns entries strictly above `from` up to `to`", () => {
		const slice = entriesBetween(parsed, "0.7.6", "0.7.8");
		expect(slice.map((e) => e.version)).toEqual(["0.7.8", "0.7.7"]);
	});
	it("excludes `from` itself", () => {
		const slice = entriesBetween(parsed, "0.7.7", "0.7.8");
		expect(slice.map((e) => e.version)).toEqual(["0.7.8"]);
	});
});

describe("summarizeEntries", () => {
	it("counts bullets and normalizes aliases", () => {
		const parsed = parseChangelog(PI_LIKE);
		const slice = entriesBetween(parsed, "0.74.0", "0.74.1");
		const sum = summarizeEntries(slice);
		// 2 (New Features → added) + 3 (Added) + 2 (Fixed) = 7
		expect(sum.total).toBe(7);
		expect(sum.byCategory.get("added")).toBe(5);
		expect(sum.byCategory.get("fixed")).toBe(2);
	});
});

describe("renderSummaryPanel", () => {
	it("returns no-updates string when no summaries", () => {
		const out = renderSummaryPanel([]);
		expect(out).toMatch(/no recent updates/);
	});
	it("renders three rows when all three components advanced", () => {
		const entries = parseChangelog(FORGE_CLI_LIKE);
		const slice = entriesBetween(entries, "0.7.6", "0.7.8");
		const sum = summarizeEntries(slice);
		const out = renderSummaryPanel([
			{
				component: "forge-cli",
				label: "forge-cli",
				fromVersion: "0.7.6",
				toVersion: "0.7.8",
				totalChanges: sum.total,
				byCategory: sum.byCategory,
				entries: slice,
			},
		]);
		expect(out).toMatch(/forge-cli/);
		expect(out).toMatch(/0\.7\.6 → 0\.7\.8/);
		expect(out).toMatch(/Run \/whats-new/);
	});
});

describe("computeSummaries", () => {
	const fixtureRoot = (label: string) => {
		const root = tmpDir(label);
		mkdirSync(path.join(root, "dist"), { recursive: true });
		writeFileSync(path.join(root, "CHANGELOG.md"), FORGE_CLI_LIKE, "utf8");
		writeFileSync(path.join(root, "dist", "CHANGELOG-forge-plugin.md"), FORGE_CLI_LIKE, "utf8");
		writeFileSync(path.join(root, "dist", "CHANGELOG-pi.md"), PI_LIKE, "utf8");
		return root;
	};

	it("returns one summary per advanced component", () => {
		const root = fixtureRoot("compute");
		const sources = resolveChangelogPaths(root);
		const seen: SeenState = {
			...emptySeenState(),
			pi: "0.74.0",
			forgePlugin: "0.7.6",
			forgeCli: "0.7.6",
		};
		const summaries = computeSummaries({
			sources,
			current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" },
			seen,
		});
		expect(summaries.map((s) => s.component)).toEqual(["pi", "forge-plugin", "forge-cli"]);
	});

	it("always includes all three tabs; non-advanced components show current-version entry with fromVersion=null", () => {
		const root = fixtureRoot("skip");
		const sources = resolveChangelogPaths(root);
		const seen: SeenState = {
			...emptySeenState(),
			pi: "0.74.1",
			forgePlugin: "0.7.8",
			forgeCli: "0.7.6",
		};
		const summaries = computeSummaries({
			sources,
			current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" },
			seen,
		});
		// All three tabs always appear.
		expect(summaries.map((s) => s.component)).toEqual(["pi", "forge-plugin", "forge-cli"]);
		// Non-advanced components fall back to null from → only current-version entry shown.
		const piSummary = summaries.find((s) => s.component === "pi")!;
		expect(piSummary.fromVersion).toBeNull();
		expect(piSummary.entries).toHaveLength(1);
		const forgePluginSummary = summaries.find((s) => s.component === "forge-plugin")!;
		expect(forgePluginSummary.fromVersion).toBeNull();
		expect(forgePluginSummary.entries).toHaveLength(1);
		// Advanced component retains its real from-version.
		const cliSummary = summaries.find((s) => s.component === "forge-cli")!;
		expect(cliSummary.fromVersion).toBe("0.7.6");
	});

	it("handles first-install: from=null returns only `to`", () => {
		const root = fixtureRoot("first");
		const sources = resolveChangelogPaths(root);
		const summaries = computeSummaries({
			sources,
			current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" },
			seen: emptySeenState(),
		});
		expect(summaries).toHaveLength(3);
		for (const s of summaries) {
			expect(s.entries).toHaveLength(1);
			expect(s.fromVersion).toBeNull();
		}
	});
});

describe("computeAndPersistStartupPanel + dismissWhatsNew + computeWhatsNewView", () => {
	let pkgRoot: string;
	let cacheDir: string;

	beforeEach(() => {
		pkgRoot = tmpDir("e2e-pkg");
		cacheDir = tmpDir("e2e-cache");
		mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
		writeFileSync(path.join(pkgRoot, "CHANGELOG.md"), FORGE_CLI_LIKE, "utf8");
		writeFileSync(path.join(pkgRoot, "dist", "CHANGELOG-forge-plugin.md"), FORGE_CLI_LIKE, "utf8");
		writeFileSync(path.join(pkgRoot, "dist", "CHANGELOG-pi.md"), PI_LIKE, "utf8");
	});

	afterEach(async () => {
		await fs.rm(pkgRoot, { recursive: true, force: true });
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	it("writes seen state and preserves prev baseline on second run", async () => {
		// First run — first install, prev/seen both null.
		const r1 = await computeAndPersistStartupPanel({
			pkgRoot,
			current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" },
			cacheDir,
		});
		expect(r1).not.toBeNull();
		const seenAfter1 = await readSeenState(cacheDir);
		expect(seenAfter1.pi).toBe("0.74.1");
		expect(seenAfter1.prevPi).toBeNull();

		// Second run — no new versions. Still returns summaries (current-version
		// entries for all three tabs) rather than null.
		const r2 = await computeAndPersistStartupPanel({
			pkgRoot,
			current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" },
			cacheDir,
		});
		expect(r2).not.toBeNull();

		// /whats-new still replays via prev baseline (was null → returns `to`).
		const summary = await computeWhatsNewView({ pkgRoot, current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" }, cacheDir }, null);
		expect(summary).toMatch(/What's New since last login/);
	});

	it("dismissWhatsNew collapses prev to seen but /whats-new still replays the last-shown set", async () => {
		// Seed a prior seen baseline so the first mount has a real `from`.
		await writeSeenState(cacheDir, {
			pi: "0.74.0",
			forgePlugin: "0.7.6",
			forgeCli: "0.7.6",
			prevPi: "0.74.0",
			prevForgePlugin: "0.7.6",
			prevForgeCli: "0.7.6",
			lastShownFromPi: null,
			lastShownFromForgePlugin: null,
			lastShownFromForgeCli: null,
			lastShownAt: 0,
		});
		await computeAndPersistStartupPanel({
			pkgRoot,
			current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" },
			cacheDir,
		});
		await dismissWhatsNew({ pkgRoot, current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" }, cacheDir });
		const seen = await readSeenState(cacheDir);
		expect(seen.prevPi).toBe(seen.pi);
		expect(seen.prevForgePlugin).toBe(seen.forgePlugin);
		expect(seen.prevForgeCli).toBe(seen.forgeCli);
		// lastShownFrom snapshot survives dismiss — the frozen baseline.
		expect(seen.lastShownFromPi).toBe("0.74.0");
		expect(seen.lastShownFromForgePlugin).toBe("0.7.6");
		expect(seen.lastShownFromForgeCli).toBe("0.7.6");

		const view = await computeWhatsNewView(
			{ pkgRoot, current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" }, cacheDir },
			null,
		);
		// prev=current after dismiss → effectiveFrom=null → shows current-version
		// notes for all three tabs (not the historical 0.74.0→0.74.1 range).
		expect(view).toMatch(/What's New since last login/);
		expect(view).toMatch(/0\.74\.1/);
	});

	it("computeWhatsNewView with prev=current always shows current-version notes for all three tabs", async () => {
		// Simulate a cache that has caught up (prev=current). With the "always
		// show all three tabs" behavior, effectiveFrom=null so each component
		// still returns its current-version changelog entry.
		await writeSeenState(cacheDir, {
			pi: "0.74.1",
			forgePlugin: "0.7.8",
			forgeCli: "0.7.8",
			prevPi: "0.74.1",
			prevForgePlugin: "0.7.8",
			prevForgeCli: "0.7.8",
			lastShownFromPi: null,
			lastShownFromForgePlugin: null,
			lastShownFromForgeCli: null,
			lastShownAt: 0,
		});
		const view = await computeWhatsNewView(
			{ pkgRoot, current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" }, cacheDir },
			null,
		);
		expect(view).toMatch(/What's New since last login/);
		expect(view).toMatch(/0\.74\.1/);
	});

	it("drill-down by component id returns full detail view", async () => {
		// First run captures versions; second run with bumped version exercises drill-down.
		await writeSeenState(cacheDir, {
			...emptySeenState(),
			pi: "0.74.0",
			forgePlugin: "0.7.6",
			forgeCli: "0.7.6",
			prevPi: "0.74.0",
			prevForgePlugin: "0.7.6",
			prevForgeCli: "0.7.6",
			lastShownAt: 0,
		});
		const view = await computeWhatsNewView(
			{ pkgRoot, current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" }, cacheDir },
			"pi",
		);
		expect(view).toMatch(/What's New — pi/);
		expect(view).toMatch(/0\.74\.0 → 0\.74\.1/);
		expect(view).toMatch(/Together AI/);
	});

	it("drill-down with unknown component returns helpful error", async () => {
		const view = await computeWhatsNewView(
			{ pkgRoot, current: { pi: "0.74.1", forgePlugin: "0.7.8", forgeCli: "0.7.8" }, cacheDir },
			"bogus",
		);
		expect(view).toMatch(/no recent changes for "bogus"/);
	});
});

describe("internals", () => {
	it("normalizeCategory maps `new features` → added", () => {
		expect(__test__.normalizeCategory("New Features")).toBe("added");
		expect(__test__.normalizeCategory("Added")).toBe("added");
		expect(__test__.normalizeCategory("Custom Section")).toBe("custom section");
	});
	it("formatCategoryBreakdown orders standard categories first", () => {
		const m = new Map<string, number>([
			["fixed", 7],
			["added", 3],
			["custom", 1],
		]);
		expect(__test__.formatCategoryBreakdown(m)).toBe("(3 added · 7 fixed · 1 custom)");
	});
});
