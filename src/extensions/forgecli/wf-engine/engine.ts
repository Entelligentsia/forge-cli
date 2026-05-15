import * as fs from "node:fs";
import * as path from "node:path";
import { loadWorkflow } from "./loader.js";
import { makeInstanceId, makeNodeExecId, makeEventId } from "./id-gen.js";
import { parseEventsBlock } from "./event-parser.js";
import { checkRemit } from "./remit-check.js";
import { StateStore } from "./state-store.js";
import { compilePrompt } from "./prompt-compiler.js";
import { dispatchLlmWorker, type WorkerResult } from "./worker.js";
import { evalPredicate } from "./predicate.js";
import type { EdgeDef, Event, RuntimeState } from "./types.js";
import type { SessionRegistry } from "../session-registry.js";
import { extractTurnPreview } from "../run-task.js";

export interface RunWorkflowOptions {
  workflowsDir: string;     // directory containing workflow folders
  workflowId:   string;     // name of the folder under workflowsDir
  cwd:          string;     // user's cwd (parent of .forge-wf/)
  entryPrompt:  string;     // free-form ARG from /forge:run-workflow
  notify?:      (line: string) => void;
  workerFn?:    (opts: { compiledPrompt: string; cwd: string; onEvent?: (e: unknown) => void }) => Promise<WorkerResult>;
  /** Optional live monitor sink. Receives startSession/startPhase/turn/tool/completePhase/completeSession calls. */
  registry?:    SessionRegistry;
}

export interface RunWorkflowResult {
  status:      "completed" | "halted";
  instanceId:  string;
  workingDir:  string;
  haltReason?: string;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const notify = opts.notify ?? (() => {});
  const workflowDir = path.join(opts.workflowsDir, opts.workflowId);
  const wf = loadWorkflow(workflowDir);

  const instanceId = makeInstanceId(wf.id);
  const workingDir = path.join(opts.cwd, ".forge-wf", "runs", instanceId);
  const store = new StateStore(workingDir);

  const firstNode = wf.nodes[0];
  store.initialState({
    cursor:      firstNode.id,
    loopCursor:  {},
    entryPrompt: opts.entryPrompt,
  });

  fs.writeFileSync(
    path.join(workingDir, "manifest.json"),
    JSON.stringify({
      workflowId: wf.id,
      version:    wf.version,
      instanceId,
      startedAt:  new Date().toISOString(),
      entryPrompt: opts.entryPrompt,
    }, null, 2)
  );

  store.appendEvents([{
    eventId:    makeEventId(instanceId, 0, "workflow.started"),
    nodeExecId: instanceId,
    type:       "workflow.started",
    ts:         new Date().toISOString(),
    workflowId: wf.id,
    instanceId,
  }]);

  notify(`→ workflow ${wf.id} started: ${instanceId}`);

  const registry = opts.registry;
  registry?.startSession(instanceId);

  const workerFn = opts.workerFn ?? dispatchLlmWorker;
  let phaseIndex = 0;

  // Build group-head lookup: group name -> head node id
  const groupHeads = new Map<string, string>();
  for (const n of wf.nodes) {
    if (n.loop?.group && n.loop?.head) groupHeads.set(n.loop.group, n.id);
  }

  // Main loop
  while (true) {
    const state = store.readState();
    const cursor = state.cursor;
    const node = wf.nodes.find(n => n.id === cursor);
    if (!node) {
      throw new Error(`cursor references unknown node: ${cursor}`);
    }

    // Resolve loop context
    let loopCtx: { iter: number; itemId: string; item: unknown; cursorKey: string; group?: string } | undefined;
    if (node.loop) {
      const group = node.loop.group;
      const cursorKey = group ?? node.id;
      const isHead = !group || node.loop.head === true;
      const collection = resolvePath(state, node.loop.over) as Array<{ id: string }> | undefined;
      if (!Array.isArray(collection)) {
        throw new Error(`loop.over '${node.loop.over}' did not resolve to an array`);
      }
      const iter = state.loopCursor[cursorKey] ?? 0;
      if (isHead && iter >= collection.length) {
        // Loop exhausted — for grouped loops, use on:exhausted edge; for non-grouped, use advance: loop-or-next
        let exitTarget: string | undefined;
        if (group) {
          const exitEdge = wf.edges.find(e => e.from === node.id && e.on === "exhausted");
          exitTarget = exitEdge?.to;
        } else {
          const exitEdge = wf.edges.find(e => e.from === node.id && e.advance === "loop-or-next");
          exitTarget = exitEdge?.next;
        }
        if (!exitTarget) {
          throw new Error(`loop exhausted but no exit target from ${node.id}`);
        }
        state.cursor = exitTarget;
        store.writeState(state);
        continue;
      }
      const item = collection[iter];
      const itemId = (item.id as string) ?? String(iter);
      loopCtx = { iter, itemId, item, cursorKey, group };
    }

    const nodeExecId = makeNodeExecId(instanceId, node.id, loopCtx);

    store.appendEvents([{
      eventId:    makeEventId(nodeExecId, 0, "node.dispatched"),
      nodeExecId,
      type:       "node.dispatched",
      ts:         new Date().toISOString(),
    }]);

    const role = loopCtx ? `${node.id}#${loopCtx.iter}` : node.id;
    registry?.startPhase(instanceId, role, phaseIndex++);
    registry?.appendTail(instanceId, role, `─── node ${node.id}${loopCtx ? ` [iter ${loopCtx.iter}, item ${loopCtx.itemId}]` : ""} begin ───`);

    notify(`→ node ${node.id}${loopCtx ? ` [iter ${loopCtx.iter}]` : ""}`);

    const promptFile = path.join(workflowDir, node.prompt);
    const compiled = compilePrompt(promptFile, {
      wf:    { instanceId, workingDir },
      node:  { execId: nodeExecId, id: node.id },
      state,
      loop:  loopCtx ? { item: loopCtx.item } : undefined,
    });

    const argsByCallId = new Map<string, unknown>();
    const onEvent = registry ? (event: unknown) => {
      const e = event as { type: string; [k: string]: unknown };
      switch (e.type) {
        case "turn_start":
          registry.bumpTurn(instanceId);
          break;
        case "turn_end": {
          const preview = extractTurnPreview(e.message);
          if (preview) {
            registry.setTurnPreview(instanceId, preview);
            registry.appendTail(instanceId, role, `» "${preview}"`);
          }
          break;
        }
        case "tool_execution_start": {
          const toolName = e.toolName as string;
          const callId = e.toolCallId as string;
          argsByCallId.set(callId, e.args);
          registry.recordToolStart(instanceId, callId, toolName, e.args);
          registry.appendTail(instanceId, role, `→ ${toolName}`);
          break;
        }
        case "tool_execution_end": {
          const toolName = e.toolName as string;
          const callId = e.toolCallId as string;
          argsByCallId.delete(callId);
          registry.recordToolEnd(instanceId, callId, toolName, !!e.isError, e.result);
          registry.appendTail(instanceId, role, e.isError ? `⚠ ${toolName} failed` : `← ${toolName} ok`,
            e.isError ? { warning: true } : undefined);
          break;
        }
      }
    } : undefined;

    const result = await workerFn({ compiledPrompt: compiled, cwd: opts.cwd, onEvent });

    store.writeNodeArchive(nodeExecId, {
      "prompt.compiled.md": compiled,
      "response.txt":       result.responseText,
    });

    if (result.exitCode !== 0) {
      const haltEvent: Event = {
        eventId:    makeEventId(nodeExecId, 1, "failure"),
        nodeExecId,
        type:       "failure",
        ts:         new Date().toISOString(),
        reason:     "worker-error",
        details:    result.errorMessage ?? "unknown",
      };
      store.appendEvents([haltEvent]);
      store.appendEvents([{
        eventId:    makeEventId(instanceId, 999, "workflow.halted"),
        nodeExecId: instanceId,
        type:       "workflow.halted",
        ts:         new Date().toISOString(),
        reason:     `worker-error in ${node.id}`,
      }]);
      notify(`× workflow halted: worker error in ${node.id}`);
      registry?.appendTail(instanceId, role, `⚠ worker error: ${result.errorMessage ?? "unknown"}`, { warning: true });
      registry?.completePhase(instanceId, role, "failed");
      registry?.completeSession(instanceId, "failed");
      return { status: "halted", instanceId, workingDir, haltReason: `worker-error in ${node.id}` };
    }

    // Parse emitted events
    let parsed;
    try {
      parsed = parseEventsBlock(result.responseText);
    } catch (err) {
      const haltReason = `events-block-parse-error in ${node.id}: ${(err as Error).message}`;
      store.appendEvents([{
        eventId:    makeEventId(instanceId, 999, "workflow.halted"),
        nodeExecId: instanceId,
        type:       "workflow.halted",
        ts:         new Date().toISOString(),
        reason:     haltReason,
      }]);
      notify(`× workflow halted: ${haltReason}`);
      registry?.appendTail(instanceId, role, `⚠ ${haltReason}`, { warning: true });
      registry?.completePhase(instanceId, role, "failed");
      registry?.completeSession(instanceId, "failed");
      return { status: "halted", instanceId, workingDir, haltReason };
    }

    // Stamp engine-side fields on emitted events
    const stamped: Event[] = parsed.events.map((e, i) => ({
      ...e,
      eventId:    e.eventId    ?? makeEventId(nodeExecId, i + 10, e.type),
      nodeExecId: e.nodeExecId ?? nodeExecId,
      ts:         e.ts         ?? new Date().toISOString(),
    }));

    fs.writeFileSync(
      path.join(workingDir, "nodes", nodeExecId, "events.emitted.jsonl"),
      stamped.map(e => JSON.stringify(e)).join("\n") + "\n"
    );

    // Remit check
    const remit = checkRemit(stamped, node, loopCtx?.itemId);
    if (!remit.ok) {
      const haltEvent: Event = {
        eventId:      makeEventId(nodeExecId, 998, "node.remit-violation"),
        nodeExecId,
        type:         "node.remit-violation",
        ts:           new Date().toISOString(),
        reason:       "remit-violation",
        details:      remit.violations.join("; "),
      };
      store.appendEvents([haltEvent]);
      store.appendEvents([{
        eventId:    makeEventId(instanceId, 999, "workflow.halted"),
        nodeExecId: instanceId,
        type:       "workflow.halted",
        ts:         new Date().toISOString(),
        reason:     `remit-violation in ${node.id}`,
      }]);
      notify(`× workflow halted: remit-violation in ${node.id} — ${remit.violations.join("; ")}`);
      registry?.appendTail(instanceId, role, `⚠ remit-violation: ${remit.violations.join("; ")}`, { warning: true });
      registry?.completePhase(instanceId, role, "failed");
      registry?.completeSession(instanceId, "failed");
      return { status: "halted", instanceId, workingDir, haltReason: `remit-violation in ${node.id}` };
    }

    // Commit emitted events to log
    store.appendEvents(stamped);

    // Apply terminal event payload
    const terminal = stamped.find(e => e.type === "success" || e.type === "failure")!;

    if (terminal.type === "success") {
      if (terminal.writes?.state) {
        const updated = { ...state };
        for (const [key, value] of Object.entries(terminal.writes.state)) {
          setPath(updated, key, value);
        }
        store.writeState(updated);
      }
      if (terminal.writes?.artifact) {
        store.writeArtifact(terminal.writes.artifact.path, terminal.writes.artifact.content);
      }
    }

    store.appendEvents([{
      eventId:    makeEventId(nodeExecId, 999, "node.committed"),
      nodeExecId,
      type:       "node.committed",
      ts:         new Date().toISOString(),
    }]);

    notify(`✓ node ${node.id}${loopCtx ? ` [iter ${loopCtx.iter}]` : ""} — ${terminal.type}`);
    if (terminal.summary) registry?.appendTail(instanceId, role, `✓ ${terminal.summary}`);
    registry?.completePhase(instanceId, role, terminal.type === "success" ? "completed" : "failed");

    // Loop iter advance OR cursor advance — first matching edge wins (conditional edges evaluated in YAML order)
    const onKind: "success" | "failure" = terminal.type === "success" ? "success" : "failure";
    const candidates = wf.edges.filter(e => e.from === node.id && e.on === onKind);
    let edge: EdgeDef | undefined;
    const postState = store.readState();   // reflects state writes just applied
    for (const e of candidates) {
      if (!e.when) { edge = e; break; }
      try {
        if (evalPredicate(e.when, { state: postState, loop: loopCtx ? { item: loopCtx.item } : undefined })) {
          edge = e;
          break;
        }
      } catch (err) {
        const haltReason = `predicate-error in ${node.id} '${e.when}': ${(err as Error).message}`;
        store.appendEvents([{
          eventId:    makeEventId(instanceId, 999, "workflow.halted"),
          nodeExecId: instanceId,
          type:       "workflow.halted",
          ts:         new Date().toISOString(),
          reason:     haltReason,
        }]);
        notify(`× workflow halted: ${haltReason}`);
        registry?.completeSession(instanceId, "failed");
        return { status: "halted", instanceId, workingDir, haltReason };
      }
    }
    if (!edge) {
      throw new Error(`no matching edge from ${node.id} on ${onKind}`);
    }

    if (edge.terminal === "complete") {
      store.appendEvents([{
        eventId:    makeEventId(instanceId, 999, "workflow.completed"),
        nodeExecId: instanceId,
        type:       "workflow.completed",
        ts:         new Date().toISOString(),
      }]);
      notify(`✓ workflow ${wf.id} complete: ${instanceId}`);
      registry?.completeSession(instanceId, "completed");
      return { status: "completed", instanceId, workingDir };
    }

    if (edge.halt) {
      store.appendEvents([{
        eventId:    makeEventId(instanceId, 999, "workflow.halted"),
        nodeExecId: instanceId,
        type:       "workflow.halted",
        ts:         new Date().toISOString(),
        reason:     edge.halt,
      }]);
      notify(`× workflow halted: ${edge.halt}`);
      registry?.completeSession(instanceId, "failed");
      return { status: "halted", instanceId, workingDir, haltReason: edge.halt };
    }

    if (edge.advance === "loop-or-next") {
      const newState = store.readState();
      const cursorKey = loopCtx?.cursorKey ?? node.id;
      newState.loopCursor[cursorKey] = (newState.loopCursor[cursorKey] ?? 0) + 1;
      if (loopCtx?.group) {
        const head = groupHeads.get(loopCtx.group);
        if (!head) throw new Error(`group ${loopCtx.group} has no head`);
        newState.cursor = head;
      }
      store.writeState(newState);
      continue;
    }

    if (edge.to) {
      const newState = store.readState();
      newState.cursor = edge.to;
      store.writeState(newState);
      continue;
    }

    throw new Error(`edge from ${node.id} has no resolvable continuation`);
  }
}

function resolvePath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (Array.isArray(cur)) {
      // Navigate into array by matching item.id — avoids setting named properties
      // on the Array object (which JSON.stringify drops silently, FORGE-BUG-033).
      const arr = cur as Array<Record<string, unknown>>;
      let item = arr.find(el => String(el.id) === p);
      if (!item) {
        item = { id: p };
        arr.push(item);
      }
      cur = item;
    } else if (cur !== null && typeof cur === "object") {
      const rec = cur as Record<string, unknown>;
      if (typeof rec[p] !== "object" || rec[p] === null) rec[p] = {};
      cur = rec[p];
    } else {
      throw new Error(`setPath: cannot traverse into ${typeof cur} at segment '${p}' (path: ${dotted})`);
    }
  }
  if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
    throw new Error(`setPath: terminal position is not an object (path: ${dotted})`);
  }
  (cur as Record<string, unknown>)[parts[parts.length - 1]] = value;
}
