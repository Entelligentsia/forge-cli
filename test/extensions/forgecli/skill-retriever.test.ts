// Unit tests for skill-retriever module (FORGE-S24-T08).
//
// Coverage:
//   buildSkillIndex:
//     1. Builds without throwing for a small typed corpus.
//
//   retrieveTopK:
//     2. Deterministic top-k order for a known corpus + query (BM25 via lunr.js).
//     3. Respects k (no more than k results returned).
//     4. Returns empty array for query with no token overlap.
//     5. Each hit includes a finite numeric `score` and the source `skillId`.
//
//   emitSkillUsageEvents:
//     6. Emits one `skill_usage` event per retrieved skill via
//        `node <storeCli> emit <sprintId> <json>` (Iron Law 6: argv array, no shell).
//     7. Each emitted event has retrieved=true, used=false, type="skill_usage",
//        populated retrieval_score in [0,1], and all schema-required canonical fields.
//     8. Surfaces non-zero subprocess exit as { ok: false } without throwing.
//
// All subprocess calls are mocked — no real store, no real lunr build is exercised
// outside this process.

import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import {
	buildSkillIndex,
	emitSkillUsageEvents,
	type RetrievableSkill,
	retrieveTopK,
} from "../../../src/extensions/forgecli/skill-retriever.js";

const mockSpawnSync = vi.mocked(childProcess.spawnSync);

// ── Fixture corpus (deterministic) ────────────────────────────────────────────

const CORPUS: RetrievableSkill[] = [
	{
		skillId: "refresh-kb-links",
		name: "refresh-kb-links",
		description: "Refresh Forge KB and workflow links in agent instruction files (CLAUDE.md, AGENTS.md).",
		frontmatter: { name: "refresh-kb-links", tags: ["kb", "links", "agents"] },
	},
	{
		skillId: "store-query-nlp",
		name: "store-query-nlp",
		description: "Query the Forge store using natural language. Find tasks, bugs, sprints, features.",
		frontmatter: { name: "store-query-nlp", tags: ["store", "query", "nlp"] },
	},
	{
		skillId: "store-query-grammar",
		name: "store-query-grammar",
		description: "Reference for the Forge NLP query grammar — entity synonyms, status synonyms.",
		frontmatter: { name: "store-query-grammar", tags: ["grammar", "query"] },
	},
	{
		skillId: "store-custodian",
		name: "store-custodian",
		description: "Sole authorized gateway for reading and writing the Forge JSON store via store-cli.",
		frontmatter: { name: "store-custodian", tags: ["store", "gateway"] },
	},
];

beforeEach(() => {
	mockSpawnSync.mockReset();
	// FORGE-S24-T12 — this suite tests the flag-on path. The dedicated
	// gate test (skill-curation-flag.test.ts) covers the default-off
	// no-op contract.
	process.env.FORGE_CLI_SKILL_CURATION_ENABLED = "1";
});

afterEach(() => {
	vi.clearAllMocks();
	delete process.env.FORGE_CLI_SKILL_CURATION_ENABLED;
});

describe("skill-retriever / buildSkillIndex", () => {
	it("builds an index for a small corpus without throwing", () => {
		expect(() => buildSkillIndex(CORPUS)).not.toThrow();
	});
});

describe("skill-retriever / retrieveTopK", () => {
	it("returns deterministic top-k for a known query", () => {
		const index = buildSkillIndex(CORPUS);
		const hits = retrieveTopK(index, "query forge store", 3);

		expect(hits.length).toBeGreaterThan(0);
		expect(hits.length).toBeLessThanOrEqual(3);

		// All three store-* skills should appear; refresh-kb-links should not be top.
		const ids = hits.map((h) => h.skillId);
		expect(ids[0]).toMatch(/^store-/);
		// Determinism: same call returns same order.
		const hits2 = retrieveTopK(index, "query forge store", 3);
		expect(hits2.map((h) => h.skillId)).toEqual(ids);
	});

	it("respects k", () => {
		const index = buildSkillIndex(CORPUS);
		const hits = retrieveTopK(index, "store query grammar nlp", 2);
		expect(hits.length).toBeLessThanOrEqual(2);
	});

	it("returns empty for a query with no token overlap", () => {
		const index = buildSkillIndex(CORPUS);
		const hits = retrieveTopK(index, "xyzzy unrelatedwidget", 3);
		expect(hits).toEqual([]);
	});

	it("each hit carries a finite score and skillId", () => {
		const index = buildSkillIndex(CORPUS);
		const hits = retrieveTopK(index, "store", 3);
		for (const h of hits) {
			expect(typeof h.skillId).toBe("string");
			expect(h.skillId.length).toBeGreaterThan(0);
			expect(Number.isFinite(h.score)).toBe(true);
		}
	});
});

describe("skill-retriever / emitSkillUsageEvents", () => {
	const runtime = {
		storeCli: "/tmp/store-cli.cjs",
		cwd: "/tmp/proj",
		sprintId: "FORGE-S24",
		taskId: "FORGE-S24-T08",
		role: "engineer",
		action: "/forge:retrieve-skills",
		phase: "engineer",
		iteration: 1,
		startTimestamp: "2026-05-22T00:00:00.000Z",
		endTimestamp: "2026-05-22T00:00:01.000Z",
		durationMinutes: 0.02,
		model: "claude-opus-4-7",
		provider: "anthropic",
	};

	it("emits one event per retrieved skill via spawnSync argv-array", () => {
		mockSpawnSync.mockReturnValue({
			status: 0,
			stderr: "",
			stdout: "",
			pid: 0,
			output: [],
			signal: null,
		} as unknown as ReturnType<typeof childProcess.spawnSync>);

		const hits = [
			{ skillId: "store-query-nlp", score: 1.42 },
			{ skillId: "store-custodian", score: 0.91 },
		];

		const result = emitSkillUsageEvents(hits, runtime);
		expect(result.emitted).toBe(2);
		expect(result.failed).toBe(0);
		expect(mockSpawnSync).toHaveBeenCalledTimes(2);

		const firstCall = mockSpawnSync.mock.calls[0];
		// FORGE-S25-T17: spawnStoreCliEmit uses process.execPath (not bare "node")
		expect(firstCall[0]).toBe(process.execPath);
		const argv = firstCall[1] as string[];
		expect(Array.isArray(argv)).toBe(true);
		expect(argv[0]).toBe(runtime.storeCli);
		expect(argv[1]).toBe("emit");
		expect(argv[2]).toBe(runtime.sprintId);

		const event = JSON.parse(argv[3]);
		expect(event.type).toBe("skill_usage");
		expect(event.retrieved).toBe(true);
		expect(event.used).toBe(false);
		expect(event.skillId).toBe("store-query-nlp");
		expect(event.sprintId).toBe("FORGE-S24");
		expect(event.taskId).toBe("FORGE-S24-T08");
		expect(event.role).toBe("engineer");
		expect(event.action).toBe("/forge:retrieve-skills");
		expect(event.startTimestamp).toBe(runtime.startTimestamp);
		expect(event.endTimestamp).toBe(runtime.endTimestamp);
		expect(event.durationMinutes).toBe(runtime.durationMinutes);
		expect(event.model).toBe(runtime.model);
		expect(event.provider).toBe(runtime.provider);
		expect(typeof event.eventId).toBe("string");
		expect(event.eventId.length).toBeGreaterThan(0);

		// retrieval_score must be present, finite, and clamped to [0,1].
		expect(typeof event.retrieval_score).toBe("number");
		expect(event.retrieval_score).toBeGreaterThanOrEqual(0);
		expect(event.retrieval_score).toBeLessThanOrEqual(1);

		// tool_call_success_rate is part of the required set; for retrieval-only
		// emissions (used=false) there is no tool-call yet, so it MUST be 0.
		expect(event.tool_call_success_rate).toBe(0);
	});

	it("surfaces non-zero exit as failed without throwing", () => {
		mockSpawnSync.mockReturnValue({
			status: 1,
			stderr: "store-cli: validation error",
			stdout: "",
			pid: 0,
			output: [],
			signal: null,
		} as unknown as ReturnType<typeof childProcess.spawnSync>);

		const hits = [{ skillId: "refresh-kb-links", score: 0.5 }];
		expect(() => emitSkillUsageEvents(hits, runtime)).not.toThrow();
		const r = emitSkillUsageEvents(hits, runtime);
		expect(r.emitted).toBe(0);
		expect(r.failed).toBe(1);
	});
});
