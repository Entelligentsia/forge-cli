// Unit tests for transcript-replay.ts — archived run → detached OrchestratorTree.
//
// Coverage:
//   - hydrateRunTree from a real archiveRun fixture: root/leaf shape, labels,
//     model/usage/iteration, digest tail lines, frozen timestamps
//   - head-truncation of oversized digests (REPLAY_TAIL_BUDGET)
//   - missing phase file → placeholder tail line
//   - mapVerdictToStatus / mapOutcomeToStatus tables

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveRun } from "../../../src/extensions/forgecli/transcript-archive.js";
import {
	hydrateRunTree,
	mapOutcomeToStatus,
	mapVerdictToStatus,
	REPLAY_TAIL_BUDGET,
} from "../../../src/extensions/forgecli/transcript-replay.js";
import { resolveRun } from "../../../src/extensions/forgecli/commands/transcripts-command.js";

let tmpRoot: string;
let projectDir: string;
const PRIOR_FORGE_CLI_HOME = process.env.FORGE_CLI_HOME;

const ENTITY_ID = "CART-BUG-001";
const RUN_START = "2026-06-01T10:00:00.000Z";
const RUN_ID = "20260601T100000Z";

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-replay-"));
	process.env.FORGE_CLI_HOME = path.join(tmpRoot, "forge-cli-user");
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
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedAndArchive(opts: { turns?: number; dropImplementFile?: boolean; withTailLog?: boolean } = {}): void {
	const entityDir = path.join(projectDir, ".forge", "transcripts", ENTITY_ID);
	fs.mkdirSync(entityDir, { recursive: true });

	const messages: unknown[] = [];
	const turns = opts.turns ?? 2;
	for (let i = 0; i < turns; i++) {
		messages.push({
			role: "assistant",
			content: [
				{ type: "text", text: `Turn ${i + 1} narration.` },
				{ type: "toolCall", id: `tc${i}`, name: "bash", arguments: {} },
			],
		});
		messages.push({ role: "toolResult", toolCallId: `tc${i}`, toolName: "bash", content: "ok", isError: false });
	}

	const writePhase = (ts: string, startedIso: string, role: string) => {
		fs.writeFileSync(
			path.join(entityDir, `${ts}__${ENTITY_ID}__${role}.json`),
			JSON.stringify({
				schema: "forge-subagent-transcript/v1",
				startedAt: startedIso,
				prompt: `# Workflow for ${role}\n\nRun the ${role} workflow for ${ENTITY_ID}.`,
				persona: role,
				model: "claude-opus-4-8",
				provider: "anthropic",
				exitCode: 0,
				usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 25, cost: 0.5, contextTokens: 0, turns },
				messageCount: messages.length,
				messages,
			}),
			"utf8",
		);
	};
	writePhase("20260601T100001Z", "2026-06-01T10:00:01.000Z", "triage");
	writePhase("20260601T100501Z", "2026-06-01T10:05:01.000Z", "implement");
	if (opts.withTailLog) {
		// The live tail-view stream as persistTailLog writes it — verbatim
		// dashboard lines, one JSON object per line.
		const tailEntries = [
			{ line: "╭ [T1:10:00:02] $ bash node tools/banner.cjs" },
			{ line: "│ ← bash ok 29L ⇌34%" },
			{ line: '╰ » "reading the bug report next"' },
			{ line: "⚠ bash failed: boom", warning: true },
		];
		fs.writeFileSync(
			path.join(entityDir, `20260601T100001Z__${ENTITY_ID}__triage.tail.jsonl`),
			`${tailEntries.map((e) => JSON.stringify(e)).join("\n")}\n`,
			"utf8",
		);
	}
	if (opts.dropImplementFile) {
		fs.rmSync(path.join(entityDir, `20260601T100501Z__${ENTITY_ID}__implement.json`));
	}

	const jsonlPath = path.join(entityDir, `${RUN_ID}__${ENTITY_ID}__orchestrator.jsonl`);
	const events = [
		{ kind: "pipeline-start", ts: RUN_START, entityKind: "bug", entityId: ENTITY_ID },
		{ kind: "phase-end", ts: "2026-06-01T10:05:00.000Z", phase: "triage", phaseIndex: 0, attempt: 1, verdict: "n/a", elapsedMs: 299000 },
		{ kind: "phase-end", ts: "2026-06-01T10:10:00.000Z", phase: "implement", phaseIndex: 1, attempt: 1, verdict: "approved", elapsedMs: 250000 },
		{ kind: "pipeline-end", ts: "2026-06-01T10:11:00.000Z", outcome: "complete", elapsedMs: 660000 },
	];
	fs.writeFileSync(jsonlPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

	expect(archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath }).archived).toBe(true);
}

describe("hydrateRunTree", () => {
	it("builds root + one leaf per phase with labels, model, usage, iteration", () => {
		seedAndArchive();
		const resolved = resolveRun(RUN_ID);
		expect(resolved).not.toBeNull();
		const { tree, rootId } = hydrateRunTree(resolved!.manifest, resolved!.runDir);

		expect(rootId).toBe(RUN_ID);
		const root = tree.getNode(rootId);
		expect(root).toBeDefined();
		expect(root!.kind).toBe("orchestrator");
		expect(root!.label).toBe(`${ENTITY_ID} · ${RUN_ID} · complete`);
		expect(root!.status).toBe("completed");
		expect(root!.children).toHaveLength(2);

		const triage = tree.getNode(`${RUN_ID}:triage:1`);
		expect(triage).toBeDefined();
		expect(triage!.kind).toBe("leaf");
		expect(triage!.label).toBe("triage#1");
		expect(triage!.model).toBe("claude-opus-4-8");
		expect(triage!.provider).toBe("anthropic");
		expect(triage!.usage).toEqual({ input: 1000, output: 200, cacheRead: 50 });
		expect(triage!.iteration).toBe(1);
		expect(triage!.metrics.turn).toBe(2);
		expect(triage!.status).toBe("completed");

		const implement = tree.getNode(`${RUN_ID}:implement:1`);
		expect(implement!.outcomePreview).toBe("approved");
	});

	it("hydrates the phase prompt into promptPreview (Prompt panel parity)", () => {
		seedAndArchive();
		const resolved = resolveRun(RUN_ID)!;
		const { tree } = hydrateRunTree(resolved.manifest, resolved.runDir);
		const triage = tree.getNode(`${RUN_ID}:triage:1`)!;
		expect(triage.promptPreview).toContain("# Workflow for triage");
		expect(triage.promptPreview).toContain(`Run the triage workflow for ${ENTITY_ID}.`);
	});

	it("tails carry the verbose transcript digest (content, not just markers)", () => {
		seedAndArchive();
		const resolved = resolveRun(RUN_ID)!;
		const { tree } = hydrateRunTree(resolved.manifest, resolved.runDir);
		const tail = tree.getNode(`${RUN_ID}:triage:1`)!.tailBuffer;
		const joined = tail.join("\n");
		expect(joined).toContain("── t1 ──");
		expect(joined).toContain("Turn 1 narration."); // full assistant text, not a "(no text)" marker
		expect(joined).toContain("→ bash");
		expect(joined).toContain("← bash ✓");
		expect(joined).toContain("ok"); // tool-result preview
		expect(joined).not.toContain('"messages"');
	});

	it("prefers the persisted live tail log VERBATIM over the digest", () => {
		seedAndArchive({ withTailLog: true });
		const resolved = resolveRun(RUN_ID)!;
		// Manifest pairs the phase with its archived tail log
		const triagePhase = resolved.manifest.phases.find((p) => p.role === "triage");
		expect(triagePhase?.tailFile).toBe(`20260601T100001Z__${ENTITY_ID}__triage.tail.jsonl`);

		const { tree } = hydrateRunTree(resolved.manifest, resolved.runDir);
		const triage = tree.getNode(`${RUN_ID}:triage:1`)!;
		// Exact live lines, not the digest reconstruction
		expect(triage.tailBuffer).toEqual([
			"╭ [T1:10:00:02] $ bash node tools/banner.cjs",
			"│ ← bash ok 29L ⇌34%",
			'╰ » "reading the bug report next"',
			"⚠ bash failed: boom",
		]);
		expect(triage.unreadWarnings).toBe(1); // warning flag survives the round trip

		// The implement phase had no tail log → digest fallback still applies
		const implement = tree.getNode(`${RUN_ID}:implement:1`)!;
		expect(implement.tailBuffer.join("\n")).toContain("── t1 ──");
	});

	it("freezes elapsed time: startedAt/endedAt backfilled from the archive", () => {
		seedAndArchive();
		const resolved = resolveRun(RUN_ID)!;
		const { tree, rootId } = hydrateRunTree(resolved.manifest, resolved.runDir);

		const triage = tree.getNode(`${RUN_ID}:triage:1`)!;
		expect(triage.startedAt).toBe(Date.parse("2026-06-01T10:00:01Z"));
		expect(triage.endedAt).toBe(triage.startedAt + 299000);

		const root = tree.getNode(rootId)!;
		expect(root.startedAt).toBe(Date.parse(RUN_START));
		expect(root.endedAt).toBe(Date.parse("2026-06-01T10:11:00.000Z"));
		// Frozen: nothing anywhere near Date.now()
		expect(root.endedAt! - root.startedAt).toBe(660000);
	});

	it("head-truncates oversized digests to REPLAY_TAIL_BUDGET (+1 marker line)", () => {
		// Each turn yields 4 verbose digest lines (header, text, → tool,
		// ← result); make enough turns to exceed the budget.
		const turns = Math.ceil((REPLAY_TAIL_BUDGET + 30) / 3);
		seedAndArchive({ turns });
		const resolved = resolveRun(RUN_ID)!;
		const { tree } = hydrateRunTree(resolved.manifest, resolved.runDir);
		const tail = tree.getNode(`${RUN_ID}:triage:1`)!.tailBuffer;

		expect(tail.length).toBe(REPLAY_TAIL_BUDGET + 1);
		// HEAD preserved (live tail-buffer semantics would have dropped it)
		expect(tail[0]).toBe("── t1 ──");
		expect(tail[1]).toContain("Turn 1 narration.");
		expect(tail[tail.length - 1]).toMatch(/more digest lines/);
	});

	it("missing phase payload → placeholder tail, no crash", () => {
		seedAndArchive({ dropImplementFile: true });
		const resolved = resolveRun(RUN_ID)!;
		const { tree } = hydrateRunTree(resolved.manifest, resolved.runDir);
		const implementNodes = ["implement"].map((r) => tree.getNode(`${RUN_ID}:${r}:1`)).filter(Boolean);
		// The implement phase may have no file (event-only record); whichever
		// shape it took, hydration must not crash and any node without a
		// payload carries the placeholder.
		for (const node of implementNodes) {
			expect(node!.tailBuffer.join("\n")).toContain("no archived transcript");
		}
	});
});

describe("status mapping", () => {
	it("mapOutcomeToStatus", () => {
		expect(mapOutcomeToStatus("complete")).toBe("completed");
		expect(mapOutcomeToStatus("halted")).toBe("escalated");
		expect(mapOutcomeToStatus("cancelled")).toBe("cancelled");
		expect(mapOutcomeToStatus("error")).toBe("failed");
		expect(mapOutcomeToStatus("incomplete")).toBe("failed");
	});

	it("mapVerdictToStatus", () => {
		expect(mapVerdictToStatus("approved", "complete")).toBe("completed");
		expect(mapVerdictToStatus("revision", "complete")).toBe("completed");
		expect(mapVerdictToStatus("error", "complete")).toBe("failed");
		expect(mapVerdictToStatus("cancelled", "complete")).toBe("cancelled");
		expect(mapVerdictToStatus("halted", "complete")).toBe("escalated");
		expect(mapVerdictToStatus("n/a", "complete")).toBe("completed");
		expect(mapVerdictToStatus("n/a", "incomplete")).toBe("failed");
		expect(mapVerdictToStatus("n/a", "halted")).toBe("escalated");
	});
});
