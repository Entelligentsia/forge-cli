import * as crypto from "node:crypto";

export function makeInstanceId(workflowId: string, rand?: () => string): string {
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const r = rand ? rand() : crypto.randomBytes(2).toString("hex");
  return `wf_${workflowId}_${iso}_${r}`;
}

export function makeNodeExecId(
  instanceId: string,
  nodeId: string,
  loop?: { iter: number; itemId: string }
): string {
  if (!loop) return `${instanceId}__${nodeId}`;
  const iterPad = String(loop.iter).padStart(2, "0");
  return `${instanceId}__${nodeId}__iter${iterPad}__${loop.itemId}`;
}

export function makeEventId(nodeExecId: string, seq: number, type: string): string {
  const seqPad = String(seq).padStart(3, "0");
  return `${nodeExecId}__${seqPad}__${type}`;
}
