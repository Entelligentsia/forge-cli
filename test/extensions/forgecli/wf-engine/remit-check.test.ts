import { describe, it, expect } from "vitest";
import { checkRemit } from "../../../../src/extensions/forgecli/wf-engine/remit-check.js";
import type { Event, NodeDef } from "../../../../src/extensions/forgecli/wf-engine/types.js";

function makeNode(overrides: Partial<NodeDef> = {}): NodeDef {
  return {
    id: "test-node",
    prompt: "prompts/test.md",
    expects: {
      success: {
        writes: {
          state: ["result"],
          artifact: { pattern: "artifacts/{loop.item.id}.md" },
        },
      },
      failure: {},
    },
    ...overrides,
  };
}

function makeEvent(type: Event["type"], extra: Partial<Event> = {}): Event {
  return {
    eventId: `exec__001__${type}`,
    nodeExecId: "exec",
    type,
    ts: new Date().toISOString(),
    ...extra,
  };
}

describe("checkRemit", () => {
  it("accepts started + success with declared artifact and state writes", () => {
    const events: Event[] = [
      makeEvent("started"),
      makeEvent("success", {
        writes: {
          artifact: { path: "artifacts/src-a.md", content: "# hi" },
          state: { result: true },
        },
      }),
    ];
    const result = checkRemit(events, makeNode(), "src-a");
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("rejects two terminal events", () => {
    const events: Event[] = [
      makeEvent("started"),
      makeEvent("success"),
      makeEvent("failure", { reason: "oops" }),
    ];
    const result = checkRemit(events, makeNode());
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.includes("terminal event"))).toBe(true);
  });

  it("rejects state write to undeclared key", () => {
    const events: Event[] = [
      makeEvent("started"),
      makeEvent("success", {
        writes: { state: { "undeclared.key": "value" } },
      }),
    ];
    const result = checkRemit(events, makeNode(), "src-a");
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.includes("undeclared.key"))).toBe(true);
  });

  it("rejects artifact path that does not match declared pattern after substitution", () => {
    const events: Event[] = [
      makeEvent("started"),
      makeEvent("success", {
        writes: {
          artifact: { path: "artifacts/wrong-name.md", content: "# hi" },
        },
      }),
    ];
    const result = checkRemit(events, makeNode(), "src-a");
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.includes("artifact path"))).toBe(true);
  });

  it("accepts a failure with reason", () => {
    const events: Event[] = [
      makeEvent("started"),
      makeEvent("failure", { reason: "cannot-process" }),
    ];
    const result = checkRemit(events, makeNode());
    expect(result.ok).toBe(true);
  });

  it("rejects failure without reason", () => {
    const events: Event[] = [
      makeEvent("started"),
      makeEvent("failure"),
    ];
    const result = checkRemit(events, makeNode());
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.includes("reason"))).toBe(true);
  });
});
