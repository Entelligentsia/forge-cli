import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowDef } from "./types.js";

import * as yaml from "js-yaml";

export function loadWorkflow(workflowDir: string): WorkflowDef {
  const yamlPath = path.join(workflowDir, "workflow.yaml");
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`workflow.yaml not found at ${yamlPath}`);
  }
  const raw = fs.readFileSync(yamlPath, "utf8");
  const parsed = yaml.load(raw) as WorkflowDef;
  validateWorkflow(parsed, workflowDir);
  return parsed;
}

function validateWorkflow(wf: WorkflowDef, workflowDir: string): void {
  if (!wf.id || typeof wf.id !== "string") throw new Error("workflow.id required (string)");
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) throw new Error("workflow.nodes required (non-empty array)");
  if (!Array.isArray(wf.edges) || wf.edges.length === 0) throw new Error("workflow.edges required (non-empty array)");

  const nodeIds = new Set(wf.nodes.map(n => n.id));

  for (const n of wf.nodes) {
    if (!n.id) throw new Error(`node missing id`);
    if (!n.prompt) throw new Error(`node ${n.id} missing prompt`);
    const promptPath = path.join(workflowDir, n.prompt);
    if (!fs.existsSync(promptPath)) throw new Error(`node ${n.id} prompt file not found: ${promptPath}`);
    if (!n.expects?.success) throw new Error(`node ${n.id} missing expects.success`);
    if (!n.expects?.failure) throw new Error(`node ${n.id} missing expects.failure`);
  }

  for (const e of wf.edges) {
    if (!nodeIds.has(e.from)) throw new Error(`edge.from references unknown node: ${e.from}`);
    if (e.to && !nodeIds.has(e.to)) throw new Error(`edge.to references unknown node: ${e.to}`);
    if (e.next && !nodeIds.has(e.next)) throw new Error(`edge.next references unknown node: ${e.next}`);
    if (!e.on || (e.on !== "success" && e.on !== "failure" && e.on !== "exhausted")) {
      throw new Error(`edge.on must be 'success' | 'failure' | 'exhausted' (from ${e.from})`);
    }
    const hasOne = [e.to, e.halt, e.terminal, e.advance].filter(Boolean).length;
    if (hasOne === 0) throw new Error(`edge from ${e.from} has no continuation (to/halt/terminal/advance)`);
    if (e.when && typeof e.when !== "string") {
      throw new Error(`edge.when must be a string predicate (from ${e.from})`);
    }
    if (e.when && e.on !== "success") {
      throw new Error(`edge.when only valid on success edges (from ${e.from})`);
    }
  }

  // Group validation: collect groups, enforce single head, consistent loop.over
  const groupMembers = new Map<string, string[]>();
  for (const n of wf.nodes) {
    if (n.loop?.group) {
      const arr = groupMembers.get(n.loop.group) ?? [];
      arr.push(n.id);
      groupMembers.set(n.loop.group, arr);
    }
  }
  for (const [group, members] of groupMembers) {
    const heads = members.filter(id => wf.nodes.find(n => n.id === id)!.loop?.head === true);
    if (heads.length !== 1) {
      throw new Error(`loop group '${group}' must have exactly one head node, found ${heads.length}`);
    }
    const overs = new Set(members.map(id => wf.nodes.find(n => n.id === id)!.loop!.over));
    if (overs.size !== 1) {
      throw new Error(`loop group '${group}' members must share the same loop.over (found: ${[...overs].join(", ")})`);
    }
  }

  // Exhausted edges only valid from loop head (or non-grouped loop node)
  for (const e of wf.edges) {
    if (e.on === "exhausted") {
      const fromNode = wf.nodes.find(n => n.id === e.from)!;
      if (!fromNode.loop) throw new Error(`edge.on='exhausted' requires from node to have a loop (from ${e.from})`);
      if (fromNode.loop.group && fromNode.loop.head !== true) {
        throw new Error(`edge.on='exhausted' must originate from group head (from ${e.from})`);
      }
    }
  }

  // Every node must have a success and failure edge; loop heads in groups must also have an exhausted edge
  for (const n of wf.nodes) {
    const hasSuccess = wf.edges.some(e => e.from === n.id && e.on === "success");
    const hasFailure = wf.edges.some(e => e.from === n.id && e.on === "failure");
    if (!hasSuccess) throw new Error(`node ${n.id} missing success edge`);
    if (!hasFailure) throw new Error(`node ${n.id} missing failure edge`);
    if (n.loop?.group && n.loop?.head) {
      const hasExhausted = wf.edges.some(e => e.from === n.id && e.on === "exhausted");
      if (!hasExhausted) throw new Error(`group-head node ${n.id} missing exhausted edge`);
    }
  }
}
