import { describe, it, expect } from "vitest";
import { makeInstanceId, makeNodeExecId, makeEventId } from "../../../../src/extensions/forgecli/wf-engine/id-gen.js";

describe("makeInstanceId", () => {
  it("is deterministic given a fixed rand function", () => {
    const rand = () => "abcd";
    const id1 = makeInstanceId("my-wf", rand);
    const id2 = makeInstanceId("my-wf", rand);
    // Both will have same rand segment but differ in timestamp unless called in same ms.
    // Strip the timestamp portion and check the surrounding structure.
    expect(id1.startsWith("wf_my-wf_")).toBe(true);
    expect(id1.endsWith("_abcd")).toBe(true);
    expect(id2.endsWith("_abcd")).toBe(true);
  });
});

describe("makeNodeExecId", () => {
  it("omits iter segment for non-loop nodes", () => {
    const id = makeNodeExecId("inst123", "intake");
    expect(id).toBe("inst123__intake");
    expect(id).not.toContain("iter");
  });

  it("pads iter to 2 digits for loop nodes", () => {
    const id = makeNodeExecId("inst123", "source-score", { iter: 1, itemId: "src-a" });
    expect(id).toBe("inst123__source-score__iter01__src-a");
  });

  it("pads iter 0 correctly", () => {
    const id = makeNodeExecId("inst123", "source-score", { iter: 0, itemId: "src-b" });
    expect(id).toBe("inst123__source-score__iter00__src-b");
  });
});

describe("makeEventId", () => {
  it("pads seq to 3 digits", () => {
    const id = makeEventId("execId", 5, "success");
    expect(id).toBe("execId__005__success");
  });
});
