import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runWorkflow } from "../../../../src/extensions/forgecli/wf-engine/engine.js";
import type { WorkerResult } from "../../../../src/extensions/forgecli/wf-engine/types.js";

// Fixture: a 3-node mini workflow with 1 loop-body node (source-process) over 2 items.
// Nodes: intake → source-process (loop, 2 items) → finalize
const FIXTURE_WORKFLOW_YAML = `
id: test-mini
version: 1
description: Fixture workflow for engine-loop integration test.

nodes:
  - id: intake
    prompt: prompts/intake.md
    expects:
      success:
        writes:
          state: [items]
      failure: {}

  - id: source-process
    prompt: prompts/source-process.md
    loop:
      over: items
      alias: loop.item
    expects:
      success:
        writes:
          state: ["items.{loop.item.id}.done"]
      failure: {}

  - id: finalize
    prompt: prompts/finalize.md
    expects:
      success:
        writes:
          artifact: { pattern: "artifacts/RESULT.md" }
      failure: {}

edges:
  - { from: intake,         on: success, to: source-process }
  - { from: intake,         on: failure, halt: intake-failed }
  - { from: source-process, on: success, advance: loop-or-next, next: finalize }
  - { from: source-process, on: failure, halt: process-failed }
  - { from: finalize,       on: success, terminal: complete }
  - { from: finalize,       on: failure, halt: finalize-failed }
`.trim();

const INTAKE_PROMPT = "You are intake.";
const SOURCE_PROCESS_PROMPT = "You are source-process for {{loop.item.id}}.";
const FINALIZE_PROMPT = "You are finalize.";

function makeWorkerFn(responses: Map<string, string>): (opts: { compiledPrompt: string; cwd: string }) => Promise<WorkerResult> {
  return async ({ compiledPrompt }) => {
    // Match by checking which node name appears in the compiled prompt
    for (const [key, response] of responses) {
      if (compiledPrompt.includes(key)) {
        return { responseText: response, exitCode: 0 };
      }
    }
    // Fallback
    return {
      responseText: `\`\`\`json events\n[{"type":"started"},{"type":"failure","reason":"no-match"}]\n\`\`\``,
      exitCode: 0,
    };
  };
}

function eventsBlock(events: unknown[]): string {
  return `\`\`\`json events\n${JSON.stringify(events, null, 2)}\n\`\`\``;
}

describe("engine-loop integration", () => {
  let tmpDir: string;
  let workflowsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-engine-test-"));
    workflowsDir = path.join(tmpDir, "workflows");
    const wfDir = path.join(workflowsDir, "test-mini");
    const promptsDir = path.join(wfDir, "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "workflow.yaml"), FIXTURE_WORKFLOW_YAML);
    fs.writeFileSync(path.join(promptsDir, "intake.md"), INTAKE_PROMPT);
    fs.writeFileSync(path.join(promptsDir, "source-process.md"), SOURCE_PROCESS_PROMPT);
    fs.writeFileSync(path.join(promptsDir, "finalize.md"), FINALIZE_PROMPT);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs a 3-node workflow with 1 loop body over 2 items and completes", async () => {
    const items = [
      { id: "item-a", name: "Alpha" },
      { id: "item-b", name: "Beta" },
    ];

    const intakeResponse = eventsBlock([
      { type: "started" },
      {
        type: "success",
        summary: "Identified 2 items",
        writes: { state: { items } },
      },
    ]);

    // source-process fires once per item
    const processResponseA = eventsBlock([
      { type: "started" },
      {
        type: "success",
        summary: "Processed item-a",
        writes: { state: { "items.item-a.done": true } },
      },
    ]);
    const processResponseB = eventsBlock([
      { type: "started" },
      {
        type: "success",
        summary: "Processed item-b",
        writes: { state: { "items.item-b.done": true } },
      },
    ]);

    const finalizeResponse = eventsBlock([
      { type: "started" },
      {
        type: "success",
        summary: "Done",
        writes: {
          artifact: { path: "artifacts/RESULT.md", content: "# Result\nAll items processed." },
        },
      },
    ]);

    let processCallCount = 0;
    const workerFn = async (opts: { compiledPrompt: string; cwd: string }): Promise<WorkerResult> => {
      if (opts.compiledPrompt.includes("You are intake")) {
        return { responseText: intakeResponse, exitCode: 0 };
      }
      if (opts.compiledPrompt.includes("You are source-process")) {
        processCallCount++;
        return {
          responseText: processCallCount === 1 ? processResponseA : processResponseB,
          exitCode: 0,
        };
      }
      if (opts.compiledPrompt.includes("You are finalize")) {
        return { responseText: finalizeResponse, exitCode: 0 };
      }
      return { responseText: eventsBlock([{ type: "started" }, { type: "failure", reason: "unknown" }]), exitCode: 0 };
    };

    const result = await runWorkflow({
      workflowsDir,
      workflowId: "test-mini",
      cwd: tmpDir,
      entryPrompt: "test run",
      workerFn,
    });

    expect(result.status).toBe("completed");

    // Assert state.json exists and has the top-level items array from intake
    const stateRaw = fs.readFileSync(path.join(result.workingDir, "state.json"), "utf8");
    const state = JSON.parse(stateRaw) as Record<string, unknown>;
    expect(Array.isArray(state["items"])).toBe(true);

    // Assert events.log.jsonl is non-empty and contains expected events
    const eventLog = fs.readFileSync(path.join(result.workingDir, "events.log.jsonl"), "utf8");
    const eventLines = eventLog.trim().split("\n").map(l => JSON.parse(l));
    const eventTypes = eventLines.map((e: { type: string }) => e.type);

    expect(eventTypes).toContain("workflow.started");
    expect(eventTypes).toContain("workflow.completed");
    expect(eventTypes.filter((t: string) => t === "node.dispatched")).toHaveLength(4); // intake + 2×process + finalize
    expect(eventTypes.filter((t: string) => t === "node.committed")).toHaveLength(4);

    // Assert loop body fired N=2 times
    expect(processCallCount).toBe(2);

    // Assert artifact written
    const brief = fs.readFileSync(path.join(result.workingDir, "artifacts", "RESULT.md"), "utf8");
    expect(brief).toContain("Result");

    // Assert node archives exist
    const nodesDir = path.join(result.workingDir, "nodes");
    const nodeEntries = fs.readdirSync(nodesDir);
    expect(nodeEntries.length).toBe(4); // intake + 2×process + finalize
  });

  it("halts when a node emits a remit violation", async () => {
    const intakeResponse = eventsBlock([
      { type: "started" },
      {
        type: "success",
        summary: "ok",
        writes: { state: { items: [{ id: "item-a" }] } },
      },
    ]);

    // process node writes to an undeclared state key
    const badProcessResponse = eventsBlock([
      { type: "started" },
      {
        type: "success",
        writes: { state: { "undeclared.key": true } },
      },
    ]);

    const workerFn = async (opts: { compiledPrompt: string; cwd: string }): Promise<WorkerResult> => {
      if (opts.compiledPrompt.includes("You are intake")) {
        return { responseText: intakeResponse, exitCode: 0 };
      }
      return { responseText: badProcessResponse, exitCode: 0 };
    };

    const result = await runWorkflow({
      workflowsDir,
      workflowId: "test-mini",
      cwd: tmpDir,
      entryPrompt: "test run",
      workerFn,
    });

    expect(result.status).toBe("halted");
    expect(result.haltReason).toContain("remit-violation");
  });

  it("FORGE-BUG-033: loop state writes into array-backed collection survive JSON round-trip", async () => {
    // intake writes sources as an array; source-process writes sources.<id>.done via dotted path.
    // Before the fix, setPath set a named property on the Array object which
    // JSON.stringify dropped silently — so done flags never appeared in state.json.
    const items = [
      { id: "item-a" },
      { id: "item-b" },
    ];

    const intakeResponse = eventsBlock([
      { type: "started" },
      { type: "success", writes: { state: { items } } },
    ]);

    let callIdx = 0;
    const processResponses = [
      eventsBlock([{ type: "started" }, { type: "success", writes: { state: { "items.item-a.done": true } } }]),
      eventsBlock([{ type: "started" }, { type: "success", writes: { state: { "items.item-b.done": true } } }]),
    ];
    const finalizeResponse = eventsBlock([
      { type: "started" },
      { type: "success", writes: { artifact: { path: "artifacts/RESULT.md", content: "# Done" } } },
    ]);

    const workerFn = async (opts: { compiledPrompt: string; cwd: string }): Promise<WorkerResult> => {
      if (opts.compiledPrompt.includes("You are intake")) return { responseText: intakeResponse, exitCode: 0 };
      if (opts.compiledPrompt.includes("You are source-process")) return { responseText: processResponses[callIdx++]!, exitCode: 0 };
      return { responseText: finalizeResponse, exitCode: 0 };
    };

    const result = await runWorkflow({ workflowsDir, workflowId: "test-mini", cwd: tmpDir, entryPrompt: "test", workerFn });
    expect(result.status).toBe("completed");

    const state = JSON.parse(fs.readFileSync(path.join(result.workingDir, "state.json"), "utf8")) as {
      items: Array<{ id: string; done?: boolean }>;
    };

    // Both done flags must survive the JSON round-trip (FORGE-BUG-033 regression guard)
    const a = state.items.find(x => x.id === "item-a");
    const b = state.items.find(x => x.id === "item-b");
    expect(a?.done).toBe(true);
    expect(b?.done).toBe(true);
  });
});
