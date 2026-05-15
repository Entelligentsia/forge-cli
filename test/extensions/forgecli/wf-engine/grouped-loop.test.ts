import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runWorkflow } from "../../../../src/extensions/forgecli/wf-engine/engine.js";
import type { WorkerResult } from "../../../../src/extensions/forgecli/wf-engine/types.js";

// Fixture: per-item pipeline (loop.group) + conditional `when:` edge.
// intake → [enrich → score → (warm|cold)] (per-item) → digest
const FIXTURE = `
id: test-grouped
version: 1
nodes:
  - id: intake
    prompt: prompts/p.md
    expects: { success: { writes: { state: [items] } }, failure: {} }

  - id: enrich
    prompt: prompts/p.md
    loop: { over: items, alias: loop.item, group: per-item, head: true }
    expects: { success: { writes: { state: ["items.{loop.item.id}.enriched"] } }, failure: {} }

  - id: score
    prompt: prompts/p.md
    loop: { over: items, alias: loop.item, group: per-item }
    expects: { success: { writes: { state: ["items.{loop.item.id}.score"] } }, failure: {} }

  - id: warm
    prompt: prompts/p.md
    loop: { over: items, alias: loop.item, group: per-item }
    expects: { success: { writes: { state: ["items.{loop.item.id}.outcome"] } }, failure: {} }

  - id: cold
    prompt: prompts/p.md
    loop: { over: items, alias: loop.item, group: per-item }
    expects: { success: { writes: { state: ["items.{loop.item.id}.outcome"] } }, failure: {} }

  - id: digest
    prompt: prompts/p.md
    expects: { success: { writes: { artifact: { pattern: "artifacts/R.md" } } }, failure: {} }

edges:
  - { from: intake,  on: success,   to: enrich }
  - { from: intake,  on: failure,   halt: x }
  - { from: enrich,  on: success,   to: score }
  - { from: enrich,  on: failure,   advance: loop-or-next }
  - { from: enrich,  on: exhausted, to: digest }
  - { from: score,   on: success,   when: "loop.item.score >= 4", to: warm }
  - { from: score,   on: success,   to: cold }
  - { from: score,   on: failure,   advance: loop-or-next }
  - { from: warm,    on: success,   advance: loop-or-next }
  - { from: warm,    on: failure,   advance: loop-or-next }
  - { from: cold,    on: success,   advance: loop-or-next }
  - { from: cold,    on: failure,   advance: loop-or-next }
  - { from: digest,  on: success,   terminal: complete }
  - { from: digest,  on: failure,   halt: x }
`.trim();

const NODE_PROMPT = "node={{node.id}} item={{loop.item}}";

function evBlock(events: unknown[]): string {
  return `\`\`\`json events\n${JSON.stringify(events, null, 2)}\n\`\`\``;
}

describe("grouped-loop + conditional integration", () => {
  let tmpDir: string;
  let workflowsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-grouped-"));
    workflowsDir = path.join(tmpDir, "workflows");
    const wfDir = path.join(workflowsDir, "test-grouped");
    fs.mkdirSync(path.join(wfDir, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(wfDir, "workflow.yaml"), FIXTURE);
    fs.writeFileSync(path.join(wfDir, "prompts/p.md"), NODE_PROMPT);
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("runs per-item pipeline and routes by `when:` predicate", async () => {
    // 3 items: scores 5 (warm), 2 (cold), 4 (warm)
    const items = [
      { id: "a", score_hint: 5 },
      { id: "b", score_hint: 2 },
      { id: "c", score_hint: 4 },
    ];

    const intakeResp = evBlock([{ type: "started" }, { type: "success", writes: { state: { items } } }]);

    // node-routing inside worker — emit appropriate event per node + current item
    const seq: string[] = [];   // record the order of (node, item) dispatches
    const workerFn = async (opts: { compiledPrompt: string; cwd: string }): Promise<WorkerResult> => {
      const prompt = opts.compiledPrompt;
      const nodeMatch = prompt.match(/node=(\S+)/);
      const itemIdMatch = prompt.match(/"id":\s*"([^"]+)"/);
      const nodeId = nodeMatch?.[1];
      const itemId = itemIdMatch?.[1];
      if (nodeId && itemId && nodeId !== "intake" && nodeId !== "digest") seq.push(`${nodeId}:${itemId}`);

      if (nodeId === "intake") return { responseText: intakeResp, exitCode: 0 };
      if (nodeId === "enrich") {
        return { responseText: evBlock([
          { type: "started" },
          { type: "success", writes: { state: { [`items.${itemId}.enriched`]: { ok: true } } } },
        ]), exitCode: 0 };
      }
      if (nodeId === "score") {
        const item = items.find(i => i.id === itemId)!;
        return { responseText: evBlock([
          { type: "started" },
          { type: "success", writes: { state: { [`items.${itemId}.score`]: item.score_hint } } },
        ]), exitCode: 0 };
      }
      if (nodeId === "warm") {
        return { responseText: evBlock([
          { type: "started" },
          { type: "success", writes: { state: { [`items.${itemId}.outcome`]: { status: "warm" } } } },
        ]), exitCode: 0 };
      }
      if (nodeId === "cold") {
        return { responseText: evBlock([
          { type: "started" },
          { type: "success", writes: { state: { [`items.${itemId}.outcome`]: { status: "cold" } } } },
        ]), exitCode: 0 };
      }
      if (nodeId === "digest") {
        return { responseText: evBlock([
          { type: "started" },
          { type: "success", writes: { artifact: { path: "artifacts/R.md", content: "# R" } } },
        ]), exitCode: 0 };
      }
      return { responseText: evBlock([{ type: "started" }, { type: "failure", reason: "?" }]), exitCode: 0 };
    };

    const result = await runWorkflow({
      workflowsDir,
      workflowId: "test-grouped",
      cwd: tmpDir,
      entryPrompt: "test",
      workerFn,
    });

    expect(result.status).toBe("completed");

    // Per-item pipeline: enrich:a → score:a → warm:a → enrich:b → score:b → cold:b → enrich:c → score:c → warm:c
    expect(seq).toEqual([
      "enrich:a", "score:a", "warm:a",
      "enrich:b", "score:b", "cold:b",
      "enrich:c", "score:c", "warm:c",
    ]);

    const state = JSON.parse(fs.readFileSync(path.join(result.workingDir, "state.json"), "utf8")) as {
      items: Array<{ id: string; score?: number; outcome?: { status: string } }>;
      loopCursor: Record<string, number>;
    };
    expect(state.items.find(i => i.id === "a")?.outcome?.status).toBe("warm");
    expect(state.items.find(i => i.id === "b")?.outcome?.status).toBe("cold");
    expect(state.items.find(i => i.id === "c")?.outcome?.status).toBe("warm");
    // Shared group cursor (not per-node)
    expect(state.loopCursor["per-item"]).toBe(3);
    expect(state.loopCursor["enrich"]).toBeUndefined();

    // Each grouped node dispatched 3× (once per item)
    const eventLines = fs.readFileSync(path.join(result.workingDir, "events.log.jsonl"), "utf8")
      .trim().split("\n").map(l => JSON.parse(l) as { type: string; nodeExecId: string });
    const dispatched = eventLines.filter(e => e.type === "node.dispatched");
    const enrichCount = dispatched.filter(e => e.nodeExecId.includes("__enrich__")).length;
    expect(enrichCount).toBe(3);
    // warm fired twice (a,c), cold once (b)
    const warmCount = dispatched.filter(e => e.nodeExecId.includes("__warm__")).length;
    const coldCount = dispatched.filter(e => e.nodeExecId.includes("__cold__")).length;
    expect(warmCount).toBe(2);
    expect(coldCount).toBe(1);
  });
});
