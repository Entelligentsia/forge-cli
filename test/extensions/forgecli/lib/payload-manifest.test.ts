// payload-manifest.test.ts — unit tests for the TS payload-manifest reader
// (FORGE-S32-T03) plus the advisory-2 select-parity assertion that pins the TS
// reader, the CJS build reader, and the T02 validator (check-payload-manifest.cjs)
// to one interpretation of ext / prefix / include / exclude / recursive.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	applySelect,
	groupByInstall,
	groupByOwner,
	installEntries,
	isExcluded,
	loadManifest,
	matchesFilter,
	type PayloadManifest,
} from "../../../../src/extensions/forgecli/lib/payload-manifest.js";

const require = createRequire(import.meta.url);
// CJS build reader (scripts/lib) and the T02 validator (forge/forge/tools).
const cjsReader = require("../../../../scripts/lib/payload-manifest.cjs") as {
	matchesFilter: (name: string, select?: unknown) => boolean;
	applySelect: (absDir: string, select?: unknown) => string[];
};
const checker = require("../../../../../forge/forge/tools/check-payload-manifest.cjs") as {
	matchesFilter: (name: string, select?: unknown) => boolean;
};

// Real forge root (../forge/forge relative to the forge-cli repo root).
const forgeRoot = path.resolve(import.meta.dirname, "../../../../../forge/forge");

let tmp: string;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-manifest-reader-"));
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadManifest", () => {
	it("loads the real forge payload manifest with an entries[] array", () => {
		const m = loadManifest(forgeRoot);
		expect(Array.isArray(m.entries)).toBe(true);
		expect(m.entries.length).toBeGreaterThan(0);
		for (const e of m.entries) {
			expect(typeof e.source).toBe("string");
			expect(typeof e.bundle).toBe("string");
			expect(["file", "dir"]).toContain(e.kind);
			expect(typeof e.owner).toBe("string");
		}
	});

	it("throws on a missing manifest file", () => {
		expect(() => loadManifest(path.join(tmp, "nonexistent"))).toThrow(/cannot read/);
	});

	it("throws on invalid JSON", () => {
		const dir = path.join(tmp, "badjson");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "payload-manifest.json"), "{ not json", "utf8");
		expect(() => loadManifest(dir)).toThrow(/not valid JSON/);
	});

	it("throws on a manifest missing the entries[] array", () => {
		const dir = path.join(tmp, "noentries");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "payload-manifest.json"), JSON.stringify({ foo: 1 }), "utf8");
		expect(() => loadManifest(dir)).toThrow(/malformed/);
	});
});

describe("matchesFilter / isExcluded", () => {
	it("ext filter", () => {
		expect(matchesFilter("store-cli.cjs", { ext: [".cjs", ".js"] })).toBe(true);
		expect(matchesFilter("hooks.json", { ext: [".cjs", ".js"] })).toBe(false);
	});
	it("prefix filter", () => {
		expect(matchesFilter("wfl-run-task.js", { prefix: ["wfl-"], ext: [".js"] })).toBe(true);
		expect(matchesFilter("helper.js", { prefix: ["wfl-"], ext: [".js"] })).toBe(false);
	});
	it("no select matches everything", () => {
		expect(matchesFilter("anything", undefined)).toBe(true);
	});
	it("exclude on path segment or basename", () => {
		expect(isExcluded("__tests__/x.json", "x.json", { exclude: ["__tests__"] })).toBe(true);
		expect(isExcluded("hooks.json", "hooks.json", { exclude: ["hooks.json"] })).toBe(true);
		expect(isExcluded("a/b.json", "b.json", { exclude: ["__tests__"] })).toBe(false);
	});
});

describe("applySelect", () => {
	let root: string;
	beforeAll(() => {
		root = path.join(tmp, "tree");
		const w = (rel: string) => {
			const p = path.join(root, rel);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, "x", "utf8");
		};
		w("a.cjs");
		w("b.js");
		w("c.md");
		w("hooks.json");
		w("sub/d.cjs");
		w("__tests__/e.cjs");
		w("curated/SKILL.md");
		w("other/SKILL.md");
	});

	it("recursive:false stays top-level", () => {
		expect(applySelect(root, { recursive: false, ext: [".cjs", ".js"] })).toEqual(["a.cjs", "b.js"]);
	});
	it("recursive:true descends", () => {
		expect(applySelect(root, { recursive: true, ext: [".cjs"] })).toEqual(["__tests__/e.cjs", "a.cjs", "sub/d.cjs"]);
	});
	it("exclude drops a segment", () => {
		expect(applySelect(root, { recursive: true, ext: [".cjs"], exclude: ["__tests__"] })).toEqual([
			"a.cjs",
			"sub/d.cjs",
		]);
	});
	it("curated include selects only named subtrees", () => {
		expect(applySelect(root, { include: ["curated"] })).toEqual(["curated/SKILL.md"]);
	});
	it("returns [] for a missing dir", () => {
		expect(applySelect(path.join(root, "nope"), { ext: [".cjs"] })).toEqual([]);
	});
});

describe("grouping helpers (real manifest)", () => {
	let m: PayloadManifest;
	beforeAll(() => {
		m = loadManifest(forgeRoot);
	});

	it("installEntries excludes bundleOnly entries", () => {
		const installed = installEntries(m);
		expect(installed.every((e) => e.bundleOnly !== true)).toBe(true);
		// transitions / migrations / integrity are bundleOnly — absent from install.
		expect(installed.some((e) => e.source === "schemas/transitions")).toBe(false);
		expect(installed.some((e) => e.source === "migrations.json")).toBe(false);
		expect(installed.some((e) => e.source === "integrity.json")).toBe(false);
	});

	it("groupByInstall keys are install destinations; commands union shares one dest", () => {
		const groups = groupByInstall(m);
		const cmds = groups.get(".claude/commands/forge/");
		expect(cmds?.length).toBeGreaterThanOrEqual(2);
		// loser `commands` precedes winner `.base-pack/commands` (overwrite wins).
		const idxLoser = cmds?.findIndex((e) => e.source === "commands") ?? -1;
		const idxWinner = cmds?.findIndex((e) => e.source === "init/base-pack/commands") ?? -1;
		expect(idxLoser).toBeGreaterThanOrEqual(0);
		expect(idxWinner).toBeGreaterThan(idxLoser);
	});

	it("groupByOwner buckets every install-bearing entry under a known owner", () => {
		const groups = groupByOwner(m);
		const owners = [...groups.keys()].sort();
		expect(owners).toEqual(["claude-assets", "claude-commands", "forge-scaffold", "workflows"]);
	});
});

describe("select-parity (advisory 2): TS reader === CJS reader === check-payload-manifest.cjs", () => {
	const fixtures: Array<[string, unknown]> = [
		["store-cli.cjs", { recursive: false, ext: [".cjs", ".js"] }],
		["hooks.json", { recursive: false, ext: [".cjs", ".js"] }],
		["wfl-run-task.js", { ext: [".js"], prefix: ["wfl-"] }],
		["helper.js", { ext: [".js"], prefix: ["wfl-"] }],
		["bug.schema.json", { recursive: true, ext: [".schema.json"] }],
		["enum-catalog.json", { recursive: true, ext: [".schema.json"] }],
		["anything", undefined],
		["x.md", { ext: [".md"] }],
	];

	it("matchesFilter agrees across all three implementations", () => {
		for (const [name, select] of fixtures) {
			const ts = matchesFilter(name, select as never);
			const cjs = cjsReader.matchesFilter(name, select);
			const t02 = checker.matchesFilter(name, select);
			expect(ts).toBe(t02);
			expect(cjs).toBe(t02);
		}
	});

	it("TS applySelect === CJS applySelect on a shared fixture tree", () => {
		const root = path.join(tmp, "parity-tree");
		const w = (rel: string) => {
			const p = path.join(root, rel);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, "x", "utf8");
		};
		w("a.cjs");
		w("b.schema.json");
		w("_defs/c.schema.json");
		w("d.md");
		w("__tests__/e.schema.json");
		const select = { recursive: true, ext: [".schema.json"], exclude: ["__tests__"] };
		expect(applySelect(root, select)).toEqual(cjsReader.applySelect(root, select));
	});
});
