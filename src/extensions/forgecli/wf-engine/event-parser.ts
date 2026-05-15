import type { Event } from "./types.js";

const FENCE_RE = /```json\s+events\s*\n([\s\S]*?)\n```\s*$/;

export interface ParsedEvents {
  events: Event[];
  rawBlock?: string;
}

export function parseEventsBlock(response: string): ParsedEvents {
  const match = response.match(FENCE_RE);
  if (!match) {
    return { events: [] };
  }
  const block = match[1];
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
