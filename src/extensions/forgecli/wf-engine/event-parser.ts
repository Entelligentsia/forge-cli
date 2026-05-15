import type { Event } from "./types.js";

// Match any ```json events ... ``` block; g flag so we can take the last one.
// LLMs often emit the block mid-response followed by explanatory prose, so we
// cannot anchor to $ — we take the last occurrence instead.
const FENCE_RE = /```json\s+events\s*\n([\s\S]*?)\n```/g;

export interface ParsedEvents {
  events: Event[];
  rawBlock?: string;
}

export function parseEventsBlock(response: string): ParsedEvents {
  // Scan all matches; keep the last one (the actual output, not prompt examples).
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  const re = new RegExp(FENCE_RE.source, "g");
  while ((m = re.exec(response)) !== null) {
    last = m;
  }
  if (!last) {
    return { events: [] };
  }
  const block = last[1];
  let arr: unknown;
  try {
    arr = JSON.parse(block);
  } catch (err) {
    throw new Error(`events block is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(arr)) {
    throw new Error(`events block must be a JSON array, got ${typeof arr}`);
  }
  return { events: arr as Event[], rawBlock: block };
}
