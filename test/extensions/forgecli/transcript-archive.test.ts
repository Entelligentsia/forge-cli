// Unit tests for transcript-archive.ts — the central transcript archive core.
//
// Coverage:
//   1. computeProjectKey — stability, collision avoidance, realpath fallback
//   2. readProjectIdentity — valid config, malformed-config defaults
//   3. buildRunsForEntityDir — manifest from seeded fixture (totals, revisionLoops,
//      phase/file matching, outcome, runId)
//   4. archiveRun — idempotency (double-call → one index line), gzip round-trip
//      byte equality
//   5. sweepProjectTranscripts — adopts only orphans
//   6. readManifest — TypeBox guard on truncated manifest

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRunArchiveDir, getTranscriptIndexPath } from "../../../src/extensions/forgecli/paths/paths.js";
import {
	archiveRun,
	buildRunsForEntityDir,
	computeProjectKey,
	gunzipPhase,
	readIndex,
	readManifest,
	readProjectIdentity,
	readProjects,
	sweepProjectTranscripts,
} from "../../../src/extensions/forgecli/transcript-archive.js";

let tmpRoot: string;
let projectDir: string;
let configPath: string;
const PRIOR_FORGE_CLI_HOME = process.env.FORGE_CLI_HOME;
const PRIOR_SKIP_MIGRATION = process.env.FORGE_CLI_SKIP_MIGRATION;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-transcript-archive-"));
	process.env.FORGE_CLI_HOME = path.join(tmpRoot, "forge-cli-user");
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";

	projectDir = path.join(tmpRoot, "project");
	configPath = path.join(projectDir, ".forge", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		JSON.stringify({ version: "1.0", project: { prefix: "CART", name: "Cartographer" } }),
		"utf8",
	);
});

afterEach(() => {
	if (PRIOR_FORGE_CLI_HOME === undefined) delete process.env.FORGE_CLI_HOME;
	else process.env.FORGE_CLI_HOME = PRIOR_FORGE_CLI_HOME;
	if (PRIOR_SKIP_MIGRATION === undefined) delete process.env.FORGE_CLI_SKIP_MIGRATION;
	else process.env.FORGE_CLI_SKIP_MIGRATION = PRIOR_SKIP_MIGRATION;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Fixture seeding ──────────────────────────────────────────────────────

const ENTITY_ID = "CART-BUG-001";
const RUN1_START = "2026-06-01T10:00:00.000Z";
const RUN1_ID = "20260601T100000Z";

function entityDir(): string {
	return path.join(projectDir, ".forge", "transcripts", ENTITY_ID);
}

function phaseUsage(input: number, output: number, cost: number) {
	return { input, output, cacheRead: 100, cacheWrite: 50, cost, contextTokens: 0, turns: 3 };
}

function writePhaseFile(ts: string, role: string, opts: { model: string; provider: string; usage: ReturnType<typeof phaseUsage> }): string {
	const name = `${ts}__${ENTITY_ID}__${role}.json`;
	fs.writeFileSync(
		path.join(entityDir(), name),
		JSON.stringify(
			{
				schema: "forge-subagent-transcript/v1",
				startedAt: ts,
				persona: role,
				model: opts.model,
				provider: opts.provider,
				exitCode: 0,
				usage: opts.usage,
				messageCount: 2,
				messages: [
					{ role: "user", content: [{ type: "text", text: "go" }] },
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
				],
			},
			null,
			2,
		),
		"utf8",
	);
	return name;
}

/** Seed a complete two-phase run with one revision loopback. */
function seedRun1(): { jsonlPath: string; phaseFileNames: string[] } {
	fs.mkdirSync(entityDir(), { recursive: true });
	const jsonlPath = path.join(entityDir(), `${RUN1_ID}__${ENTITY_ID}__orchestrator.jsonl`);
	const events = [
		{ kind: "pipeline-start", ts: RUN1_START, entityKind: "bug", entityId: ENTITY_ID },
		{ kind: "phase-start", ts: "2026-06-01T10:00:01.000Z", phase: "triage", phaseIndex: 0, phaseCount: 2, attempt: 1, workflowFile: "w.md", persona: "engineer" },
		{ kind: "phase-end", ts: "2026-06-01T10:05:00.000Z", phase: "triage", phaseIndex: 0, attempt: 1, verdict: "n/a", elapsedMs: 299000 },
		{ kind: "phase-loopback", ts: "2026-06-01T10:05:01.000Z", fromPhase: "review", toPhase: "implement", fromPhaseIndex: 1, toPhaseIndex: 0, reason: "revision" },
		{ kind: "phase-end", ts: "2026-06-01T10:10:00.000Z", phase: "implement", phaseIndex: 1, attempt: 1, verdict: "approved", elapsedMs: 250000 },
		{ kind: "pipeline-end", ts: "2026-06-01T10:11:00.000Z", outcome: "complete", elapsedMs: 660000 },
	];
	fs.writeFileSync(jsonlPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	const phaseFileNames = [
		writePhaseFile("20260601T100001Z", "triage", {
			model: "claude-opus-4-8",
			provider: "anthropic",
			usage: phaseUsage(1000, 200, 0.5),
		}),
		writePhaseFile("20260601T100501Z", "implement", {
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			usage: phaseUsage(2000, 800, 1.25),
		}),
	];
	return { jsonlPath, phaseFileNames };
}

/** Seed a second, later run in the same entity dir (incomplete — no pipeline-end). */
function seedRun2(): { jsonlPath: string } {
	const start = "2026-06-02T09:00:00.000Z";
	const jsonlPath = path.join(entityDir(), `20260602T090000Z__${ENTITY_ID}__orchestrator.jsonl`);
	const events = [
		{ kind: "pipeline-start", ts: start, entityKind: "bug", entityId: ENTITY_ID },
		{ kind: "phase-end", ts: "2026-06-02T09:04:00.000Z", phase: "triage", phaseIndex: 0, attempt: 1, verdict: "n/a", elapsedMs: 240000 },
	];
	fs.writeFileSync(jsonlPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	writePhaseFile("20260602T090001Z", "triage", {
		model: "claude-haiku-4-5",
		provider: "anthropic",
		usage: phaseUsage(500, 100, 0.1),
	});
	return { jsonlPath };
}

function identity() {
	return readProjectIdentity(configPath);
}

// ── computeProjectKey ────────────────────────────────────────────────────

describe("computeProjectKey", () => {
	it("is stable for the same dir + prefix", () => {
		expect(computeProjectKey(projectDir, "CART")).toBe(computeProjectKey(projectDir, "CART"));
	});

	it("disambiguates same-prefix projects at different paths", () => {
		const otherDir = path.join(tmpRoot, "other-project");
		fs.mkdirSync(otherDir, { recursive: true });
		const a = computeProjectKey(projectDir, "CART");
		const b = computeProjectKey(otherDir, "CART");
		expect(a).not.toBe(b);
		expect(a).toMatch(/^cart-[0-9a-f]{8}$/);
	});

	it("falls back to the raw path when realpath throws (deleted dir)", () => {
		const gone = path.join(tmpRoot, "does-not-exist");
		expect(computeProjectKey(gone, "CART")).toMatch(/^cart-[0-9a-f]{8}$/);
	});
});

// ── readProjectIdentity ──────────────────────────────────────────────────

describe("readProjectIdentity", () => {
	it("reads prefix/name from a valid config", () => {
		const id = readProjectIdentity(configPath);
		expect(id).toEqual({ prefix: "CART", name: "Cartographer", projectDir });
	});

	it("defaults on malformed config without throwing", () => {
		fs.writeFileSync(configPath, "{not json", "utf8");
		const id = readProjectIdentity(configPath);
		expect(id.prefix).toBe("project");
		expect(id.name).toBe(path.basename(projectDir));
		expect(id.projectDir).toBe(projectDir);
	});

	it("defaults on missing config file", () => {
		fs.rmSync(configPath);
		const id = readProjectIdentity(configPath);
		expect(id.prefix).toBe("project");
	});
});

// ── buildRunsForEntityDir ────────────────────────────────────────────────

describe("buildRunsForEntityDir", () => {
	it("builds a manifest with totals, verdicts, and revisionLoops from the fixture", () => {
		const { phaseFileNames } = seedRun1();
		const id = identity();
		const key = computeProjectKey(projectDir, id.prefix);
		const runs = buildRunsForEntityDir(entityDir(), id, key);

		expect(runs).toHaveLength(1);
		const m = runs[0].manifest;
		expect(runs[0].runId).toBe(RUN1_ID);
		expect(m.entityId).toBe(ENTITY_ID);
		expect(m.entityKind).toBe("bug");
		expect(m.outcome).toBe("complete");
		expect(m.startedAt).toBe(RUN1_START);
		expect(m.durationMs).toBe(660000);
		expect(m.totals.revisionLoops).toBe(1);
		expect(m.totals.input).toBe(3000);
		expect(m.totals.output).toBe(1000);
		expect(m.totals.cost).toBeCloseTo(1.75);
		expect(m.totals.byModel["claude-opus-4-8"]).toEqual({ input: 1000, output: 200, cost: 0.5, phases: 1 });
		expect(m.totals.byProvider.anthropic.phases).toBe(2);

		expect(m.phases).toHaveLength(2);
		const triage = m.phases.find((p) => p.role === "triage");
		expect(triage?.file).toBe(phaseFileNames[0]);
		expect(triage?.model).toBe("claude-opus-4-8");
		expect(triage?.elapsedMs).toBe(299000);
		const implement = m.phases.find((p) => p.role === "implement");
		expect(implement?.verdict).toBe("approved");
	});

	it("assigns phase files to the correct run when two runs share an entity dir", () => {
		seedRun1();
		seedRun2();
		const id = identity();
		const key = computeProjectKey(projectDir, id.prefix);
		const runs = buildRunsForEntityDir(entityDir(), id, key);

		expect(runs).toHaveLength(2);
		expect(runs[0].phaseFiles).toHaveLength(2);
		expect(runs[1].phaseFiles).toHaveLength(1);
		expect(runs[1].manifest.outcome).toBe("incomplete");
		expect(runs[1].manifest.phases[0].model).toBe("claude-haiku-4-5");
	});

	it("stamps the sprintId back-reference when provided", () => {
		seedRun1();
		const id = identity();
		const key = computeProjectKey(projectDir, id.prefix);
		const runs = buildRunsForEntityDir(entityDir(), id, key, { sprintId: "CART-S01" });
		expect(runs[0].manifest.sprintId).toBe("CART-S01");
	});

	it("survives a crash-truncated orchestrator JSONL tail line", () => {
		const { jsonlPath } = seedRun1();
		fs.appendFileSync(jsonlPath, '{"kind":"notify","ts":"2026-06-01T10:1', "utf8");
		const id = identity();
		const runs = buildRunsForEntityDir(entityDir(), id, computeProjectKey(projectDir, id.prefix));
		expect(runs).toHaveLength(1);
		expect(runs[0].manifest.outcome).toBe("complete");
	});
});

// ── archiveRun ───────────────────────────────────────────────────────────

describe("archiveRun", () => {
	it("archives a run: gzip round-trip equals original bytes, index + projects updated", () => {
		const { jsonlPath, phaseFileNames } = seedRun1();
		const result = archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath });

		expect(result.archived).toBe(true);
		const runDir = result.runDir as string;
		expect(fs.existsSync(path.join(runDir, "orchestrator.jsonl"))).toBe(true);

		// Gzip round-trip byte equality
		const original = fs.readFileSync(path.join(entityDir(), phaseFileNames[0]));
		const roundTrip = gunzipSync(fs.readFileSync(path.join(runDir, `${phaseFileNames[0]}.gz`)));
		expect(roundTrip.equals(original)).toBe(true);

		// gunzipPhase helper parses the archived payload
		const payload = gunzipPhase(runDir, phaseFileNames[0]);
		expect(payload?.model).toBe("claude-opus-4-8");

		// Index + projects
		const index = readIndex();
		expect(index).toHaveLength(1);
		expect(index[0].entityId).toBe(ENTITY_ID);
		expect(index[0].outcome).toBe("complete");
		expect(index[0].input).toBe(3000);
		const projects = readProjects();
		const entry = projects.projects[index[0].projectKey];
		expect(entry?.name).toBe("Cartographer");
		expect(entry?.runCount).toBe(1);

		// Source files untouched (copy-up only — zero delete paths)
		expect(fs.existsSync(jsonlPath)).toBe(true);
		expect(fs.existsSync(path.join(entityDir(), phaseFileNames[0]))).toBe(true);
	});

	it("is idempotent — double-call appends exactly one index line", () => {
		const { jsonlPath } = seedRun1();
		expect(archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath }).archived).toBe(true);
		expect(archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath }).archived).toBe(true);

		const lines = fs
			.readFileSync(getTranscriptIndexPath(), "utf8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(1);
		expect(readProjects().projects[readIndex()[0].projectKey]?.runCount).toBe(1);
	});

	it("never throws on a nonexistent orchestrator path", () => {
		const result = archiveRun({
			cwd: projectDir,
			orchestratorJsonlPath: path.join(entityDir(), "nope__orchestrator.jsonl"),
		});
		expect(result.archived).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

// ── sweepProjectTranscripts ──────────────────────────────────────────────

describe("sweepProjectTranscripts", () => {
	it("adopts only orphan runs", () => {
		const { jsonlPath } = seedRun1();
		archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath });
		seedRun2();

		const first = sweepProjectTranscripts(projectDir);
		expect(first).toEqual({ adopted: 1, errors: 0 });
		expect(readIndex()).toHaveLength(2);

		// Second sweep: nothing left to adopt
		const second = sweepProjectTranscripts(projectDir);
		expect(second).toEqual({ adopted: 0, errors: 0 });
		expect(readIndex()).toHaveLength(2);
	});

	it("returns zeros when the project has no transcripts dir", () => {
		expect(sweepProjectTranscripts(projectDir)).toEqual({ adopted: 0, errors: 0 });
	});
});

// ── readManifest TypeBox guard ───────────────────────────────────────────

describe("readManifest", () => {
	it("returns null for a crash-truncated manifest instead of throwing", () => {
		const { jsonlPath } = seedRun1();
		const result = archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath });
		const runDir = result.runDir as string;

		expect(readManifest(runDir)).not.toBeNull();

		const manifestPath = path.join(runDir, "manifest.json");
		const full = fs.readFileSync(manifestPath, "utf8");
		fs.writeFileSync(manifestPath, full.slice(0, Math.floor(full.length / 2)), "utf8");
		expect(readManifest(runDir)).toBeNull();
	});

	it("returns null when required fields are missing (schema mismatch)", () => {
		const runDir = getRunArchiveDir("cart-deadbeef", ENTITY_ID, RUN1_ID);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ schema: "forge-run-manifest/v1" }), "utf8");
		expect(readManifest(runDir)).toBeNull();
	});
});
