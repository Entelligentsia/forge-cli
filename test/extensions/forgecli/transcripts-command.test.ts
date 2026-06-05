// Unit tests for /forge:transcripts — recall surface over the central archive.
//
// Coverage:
//   - parseTranscriptsArgs: subcommand routing, flags, error cases
//   - formatList / formatTimeline / formatProjects / formatShow against a
//     seeded archive (written through the real archiveRun path)
//   - --since filtering, --by model aggregation
//   - show digest is a per-turn digest, never a raw JSON dump
//   - registration works with no forgeRoot (outside any Forge project)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	collectListRows,
	collectTimeline,
	digestPhasePayload,
	formatList,
	formatProjects,
	formatShow,
	formatTimeline,
	parseTranscriptsArgs,
	registerTranscriptsCommand,
	resolveRun,
} from "../../../src/extensions/forgecli/commands/transcripts-command.js";
import { archiveRun, gunzipPhase, readProjects } from "../../../src/extensions/forgecli/transcript-archive.js";

let tmpRoot: string;
let projectDir: string;
const PRIOR_FORGE_CLI_HOME = process.env.FORGE_CLI_HOME;
const PRIOR_SKIP_MIGRATION = process.env.FORGE_CLI_SKIP_MIGRATION;

const ENTITY_ID = "CART-BUG-001";
const RUN_START = "2026-06-01T10:00:00.000Z";
const RUN_ID = "20260601T100000Z";

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-transcripts-cmd-"));
	process.env.FORGE_CLI_HOME = path.join(tmpRoot, "forge-cli-user");
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";
	projectDir = path.join(tmpRoot, "project");
	fs.mkdirSync(path.join(projectDir, ".forge"), { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, ".forge", "config.json"),
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

/** Seed one complete archived run through the real archiveRun path. */
function seedArchivedRun(opts: { startIso?: string; entityId?: string } = {}): void {
	const startIso = opts.startIso ?? RUN_START;
	const entityId = opts.entityId ?? ENTITY_ID;
	const compact = startIso.replace(/[-:]/g, "").replace(/\.\d+/, "");
	const entityDir = path.join(projectDir, ".forge", "transcripts", entityId);
	fs.mkdirSync(entityDir, { recursive: true });

	const jsonlPath = path.join(entityDir, `${compact}__${entityId}__orchestrator.jsonl`);
	const endIso = new Date(new Date(startIso).getTime() + 660_000).toISOString();
	const events = [
		{ kind: "pipeline-start", ts: startIso, entityKind: "bug", entityId },
		{ kind: "phase-end", ts: endIso, phase: "triage", phaseIndex: 0, attempt: 1, verdict: "approved", elapsedMs: 300000 },
		{ kind: "pipeline-end", ts: endIso, outcome: "complete", elapsedMs: 660000 },
	];
	fs.writeFileSync(jsonlPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

	const phaseTs = new Date(new Date(startIso).getTime() + 1000)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+/, "");
	fs.writeFileSync(
		path.join(entityDir, `${phaseTs}__${entityId}__triage.json`),
		JSON.stringify({
			schema: "forge-subagent-transcript/v1",
			startedAt: startIso,
			persona: "engineer",
			model: "claude-opus-4-8",
			provider: "anthropic",
			exitCode: 0,
			usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 2 },
			messageCount: 3,
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal reasoning" },
						{ type: "text", text: "Reading the bug report first.\nMore detail here." },
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } },
					],
				},
				{ role: "toolResult", toolCallId: "tc1", toolName: "read", content: "file contents", isError: false },
				{ role: "assistant", content: [{ type: "text", text: "Diagnosis: stale cache." }] },
			],
		}),
		"utf8",
	);

	const result = archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath });
	expect(result.archived).toBe(true);
}

// ── parseTranscriptsArgs ─────────────────────────────────────────────────

describe("parseTranscriptsArgs", () => {
	it("defaults to list; bare entityId stays positional", () => {
		expect(parseTranscriptsArgs("")).toMatchObject({ subcommand: "list", positional: [], json: false });
		expect(parseTranscriptsArgs("CART-BUG-001")).toMatchObject({ subcommand: "list", positional: ["CART-BUG-001"] });
	});

	it("parses flags", () => {
		const p = parseTranscriptsArgs("list CART-BUG-001 --project cart-12345678 --since 7d --json");
		expect(p).toMatchObject({
			subcommand: "list",
			positional: ["CART-BUG-001"],
			project: "cart-12345678",
			sinceDays: 7,
			json: true,
		});
	});

	it("parses timeline --by model", () => {
		expect(parseTranscriptsArgs("timeline --by model")).toMatchObject({ subcommand: "timeline", by: "model" });
	});

	it("rejects bad flags with an error", () => {
		expect(parseTranscriptsArgs("list --since soon").error).toMatch(/--since/);
		expect(parseTranscriptsArgs("timeline --by vibes").error).toMatch(/--by/);
		expect(parseTranscriptsArgs("list --frobnicate").error).toMatch(/unknown flag/);
	});
});

// ── list ─────────────────────────────────────────────────────────────────

describe("collectListRows + formatList", () => {
	it("lists an archived run with totals and project name", () => {
		seedArchivedRun();
		const rows = collectListRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			runId: RUN_ID,
			entityId: ENTITY_ID,
			entityKind: "bug",
			projectName: "Cartographer",
			outcome: "complete",
			input: 1000,
			output: 200,
			durationMs: 660000,
		});

		const lines = formatList(rows);
		const joined = lines.join("\n");
		expect(joined).toContain(ENTITY_ID);
		expect(joined).toContain("Cartographer");
		expect(joined).toContain("complete");
		expect(joined).toContain("1.0k/200");
	});

	it("filters by entityId and --since", () => {
		seedArchivedRun(); // 2026-06-01
		seedArchivedRun({ startIso: "2020-01-01T00:00:00.000Z", entityId: "CART-BUG-002" });

		expect(collectListRows({ entityId: "CART-BUG-002" })).toHaveLength(1);
		expect(collectListRows({ entityId: "CART-BUG-404" })).toHaveLength(0);

		// --since: only runs newer than the cutoff survive (the 2020 run drops out)
		const recent = collectListRows({ sinceDays: 36500 });
		expect(recent).toHaveLength(2);
		const veryRecent = collectListRows({ sinceDays: 1 });
		expect(veryRecent.every((r) => r.startedAt >= "2026-06-01")).toBe(true);
		expect(veryRecent.find((r) => r.entityId === "CART-BUG-002")).toBeUndefined();
	});

	it("formats an empty archive with a hint, not an empty table", () => {
		const lines = formatList([]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("no archived runs");
	});
});

// ── show ─────────────────────────────────────────────────────────────────

describe("resolveRun + formatShow + digest", () => {
	it("resolves by runId and by entityId (latest run)", () => {
		seedArchivedRun();
		seedArchivedRun({ startIso: "2026-06-02T10:00:00.000Z" });

		const byRunId = resolveRun(RUN_ID);
		expect(byRunId?.entry.runId).toBe(RUN_ID);

		const byEntity = resolveRun(ENTITY_ID);
		expect(byEntity?.entry.runId).toBe("20260602T100000Z"); // latest
		expect(byEntity?.siblingCount).toBe(2);

		expect(resolveRun("NOPE-404")).toBeNull();
	});

	it("formatShow renders header, totals, and phases table", () => {
		seedArchivedRun();
		const resolved = resolveRun(RUN_ID);
		expect(resolved).not.toBeNull();
		const lines = formatShow(resolved!.manifest);
		const joined = lines.join("\n");
		expect(joined).toContain(`Run ${RUN_ID} — ${ENTITY_ID} (bug)`);
		expect(joined).toContain("complete");
		expect(joined).toContain("triage");
		expect(joined).toContain("approved");
		expect(joined).toContain("claude-opus-4-8");
		expect(joined).toContain("$0.50");
	});

	it("digestPhasePayload yields a per-turn digest, never a raw JSON dump", () => {
		seedArchivedRun();
		const resolved = resolveRun(RUN_ID);
		const record = resolved!.manifest.phases.find((p) => p.role === "triage");
		expect(record?.file).toBeTruthy();
		const payload = gunzipPhase(resolved!.runDir, record!.file!);
		expect(payload).not.toBeNull();

		const lines = digestPhasePayload(payload!);
		const joined = lines.join("\n");
		expect(joined).toContain("t1  Reading the bug report first.");
		expect(joined).toContain("→ read");
		expect(joined).toContain("← read ✓");
		expect(joined).toContain("t2  Diagnosis: stale cache.");
		// Not a raw dump: no JSON braces from the payload, no thinking text
		expect(joined).not.toContain('"messages"');
		expect(joined).not.toContain("internal reasoning");
	});
});

// ── timeline ─────────────────────────────────────────────────────────────

describe("collectTimeline + formatTimeline", () => {
	it("--by model aggregates per-model usage across runs", () => {
		seedArchivedRun();
		seedArchivedRun({ startIso: "2026-06-02T10:00:00.000Z" });

		const rows = collectTimeline({}, "model");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: "claude-opus-4-8", phases: 2, input: 2000, output: 400 });

		const lines = formatTimeline(rows, "model");
		const joined = lines.join("\n");
		expect(joined).toContain("Timeline by model");
		expect(joined).toContain("claude-opus-4-8");
		expect(joined).toContain("2.0k");
	});

	it("--by outcome groups runs", () => {
		seedArchivedRun();
		const rows = collectTimeline({}, "outcome");
		expect(rows).toEqual([expect.objectContaining({ key: "complete", runs: 1 })]);
	});

	it("default day grouping buckets by date", () => {
		seedArchivedRun();
		seedArchivedRun({ startIso: "2026-06-02T10:00:00.000Z" });
		const rows = collectTimeline({}, "day");
		expect(rows.map((r) => r.key)).toEqual(["2026-06-02", "2026-06-01"]);
	});
});

// ── projects ─────────────────────────────────────────────────────────────

describe("formatProjects", () => {
	it("lists the project registry", () => {
		seedArchivedRun();
		const lines = formatProjects(readProjects());
		const joined = lines.join("\n");
		expect(joined).toContain("Cartographer");
		expect(joined).toContain("CART");
		expect(joined).toMatch(/cart-[0-9a-f]{8}/);
	});

	it("handles an empty registry", () => {
		expect(formatProjects({ version: 1, projects: {} })[0]).toContain("no projects");
	});
});

// ── registration (outside any Forge project) ─────────────────────────────

describe("registerTranscriptsCommand", () => {
	function buildPi(): { pi: ExtensionAPI; handlers: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>> } {
		const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		const pi = {
			registerCommand: vi.fn((name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
				handlers.set(name, spec.handler);
			}),
		} as unknown as ExtensionAPI;
		return { pi, handlers };
	}

	function buildCtx(): { ctx: ExtensionCommandContext; notifications: Array<{ message: string; severity: string }> } {
		const notifications: Array<{ message: string; severity: string }> = [];
		const ctx = {
			ui: {
				notify: vi.fn((message: string, severity: string) => {
					notifications.push({ message, severity });
				}),
				setStatus: vi.fn(),
			},
		} as unknown as ExtensionCommandContext;
		return { ctx, notifications };
	}

	it("registers forge:transcripts and serves list with no forgeRoot (outside a project)", async () => {
		seedArchivedRun();
		const { pi, handlers } = buildPi();
		registerTranscriptsCommand(pi);
		expect(handlers.has("forge:transcripts")).toBe(true);

		const { ctx, notifications } = buildCtx();
		await handlers.get("forge:transcripts")!("list", ctx);
		const joined = notifications.map((n) => n.message).join("\n");
		expect(joined).toContain(ENTITY_ID);
		expect(notifications.every((n) => n.severity === "info")).toBe(true);
	});

	it("show <entityId> <phase> emits the digest", async () => {
		seedArchivedRun();
		const { pi, handlers } = buildPi();
		registerTranscriptsCommand(pi);
		const { ctx, notifications } = buildCtx();
		await handlers.get("forge:transcripts")!(`show ${ENTITY_ID} triage`, ctx);
		const joined = notifications.map((n) => n.message).join("\n");
		expect(joined).toContain("triage digest");
		expect(joined).toContain("Diagnosis: stale cache.");
	});

	it("show with an unknown id emits an error, not a crash", async () => {
		const { pi, handlers } = buildPi();
		registerTranscriptsCommand(pi);
		const { ctx, notifications } = buildCtx();
		await handlers.get("forge:transcripts")!("show NOPE-404", ctx);
		expect(notifications.some((n) => n.severity === "error" && n.message.includes("NOPE-404"))).toBe(true);
	});

	it("--json emits machine-readable rows", async () => {
		seedArchivedRun();
		const { pi, handlers } = buildPi();
		registerTranscriptsCommand(pi);
		const { ctx, notifications } = buildCtx();
		await handlers.get("forge:transcripts")!("list --json", ctx);
		const parsed = JSON.parse(notifications.map((n) => n.message).join("\n")) as Array<{ runId: string }>;
		expect(parsed[0].runId).toBe(RUN_ID);
	});
});
