import { describe, it, expect } from "vitest";
import { parseEventsBlock } from "../../../../src/extensions/forgecli/wf-engine/event-parser.js";

describe("parseEventsBlock", () => {
  it("parses a valid block and returns events array", () => {
    const response = `Some prose here.

\`\`\`json events
[
  { "type": "started" },
  { "type": "success", "summary": "done" }
]
\`\`\``;
    const result = parseEventsBlock(response);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("started");
    expect(result.events[1].type).toBe("success");
    expect(result.rawBlock).toBeDefined();
  });

  it("returns empty events when no fenced block present", () => {
    const response = "Just some prose with no events block.";
    const result = parseEventsBlock(response);
    expect(result.events).toHaveLength(0);
    expect(result.rawBlock).toBeUndefined();
  });

  it("throws on malformed JSON inside a block", () => {
    const response = `\`\`\`json events
{ not valid json
\`\`\``;
    expect(() => parseEventsBlock(response)).toThrow("events block is not valid JSON");
  });

  it("throws when block is not an array", () => {
    const response = `\`\`\`json events
{ "type": "started" }
\`\`\``;
    expect(() => parseEventsBlock(response)).toThrow("events block must be a JSON array");
  });
});
