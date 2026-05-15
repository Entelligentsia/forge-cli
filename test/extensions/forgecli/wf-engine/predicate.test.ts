import { describe, it, expect } from "vitest";
import { evalPredicate } from "../../../../src/extensions/forgecli/wf-engine/predicate.js";

describe("evalPredicate", () => {
  it("evaluates numeric >=", () => {
    expect(evalPredicate("loop.item.score >= 4", { state: {}, loop: { item: { score: 5 } } })).toBe(true);
    expect(evalPredicate("loop.item.score >= 4", { state: {}, loop: { item: { score: 3 } } })).toBe(false);
  });

  it("evaluates string equality", () => {
    expect(evalPredicate('state.mode == "warm"', { state: { mode: "warm" } })).toBe(true);
    expect(evalPredicate('state.mode == "warm"', { state: { mode: "cold" } })).toBe(false);
  });

  it("supports all comparators", () => {
    expect(evalPredicate("loop.item.x < 10", { state: {}, loop: { item: { x: 5 } } })).toBe(true);
    expect(evalPredicate("loop.item.x <= 5", { state: {}, loop: { item: { x: 5 } } })).toBe(true);
    expect(evalPredicate("loop.item.x > 5",  { state: {}, loop: { item: { x: 5 } } })).toBe(false);
    expect(evalPredicate("loop.item.x != 5", { state: {}, loop: { item: { x: 5 } } })).toBe(false);
  });

  it("returns undefined for missing paths (and yields false for comparisons)", () => {
    // undefined === 4 is false; undefined !== 4 is true
    expect(evalPredicate("loop.item.score == 4", { state: {}, loop: { item: {} } })).toBe(false);
    expect(evalPredicate("loop.item.score != 4", { state: {}, loop: { item: {} } })).toBe(true);
  });

  it("throws on malformed expression", () => {
    expect(() => evalPredicate("garbage", { state: {} })).toThrow(/cannot parse/);
  });

  it("throws on invalid JSON rhs", () => {
    expect(() => evalPredicate("state.x == bareword", { state: { x: 1 } })).toThrow(/JSON/);
  });
});
