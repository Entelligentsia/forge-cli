// Tests for the requestedModel seam in forge-subagent.ts (Slice 2 — Plan 16).
//
// Coverage:
//  1. requestedModel set + registry.find returns a Model → setModel called with that Model
//  2. requestedModel undefined → setModel never called
//  3. registry.find returns undefined (model not in registry) → setModel not called, no crash
//  4. setModel rejects → caught, runForgeSubagent still returns exitCode=0
//  5. IL10 invariant (equal case): requestedModel = X, stream returns model = X → result.model = X from stream
//  6. IL10 invariant (substitution): requestedModel = X, stream returns model = Y → result.model = Y (stream wins)
//
// The mock pattern follows run-task.test.ts: mock createAgentSession at module
// load time via vi.hoisted + vi.mock so the spy is available before imports.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

// ── Hoist shared mocks ────────────────────────────────────────────────────

const { mockSession, setModelSpy, findSpy, emitTurnEnd } = vi.hoisted(() => {
  const setModelSpy = vi.fn(() => Promise.resolve());
  const findSpy = vi.fn();

  // Track the subscriber so prompt() can fire events synchronously.
  let capturedSubscriber: ((e: AgentSessionEvent) => void) | null = null;

  function emitTurnEnd(model: string, provider: string): void {
    if (!capturedSubscriber) return;
    const msg: Partial<Message> = {
      role: "assistant",
      model,
      provider: provider as Message["provider"],
      content: [{ type: "text", text: "done" }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      errorMessage: undefined,
      timestamp: Date.now(),
    };
    capturedSubscriber({ type: "turn_end", message: msg as Message } as AgentSessionEvent);
  }

  const mockSession = {
    subscribe: vi.fn((listener: (e: AgentSessionEvent) => void) => {
      capturedSubscriber = listener;
      return () => { capturedSubscriber = null; };
    }),
    prompt: vi.fn(() => Promise.resolve()),
    abort: vi.fn(),
    dispose: vi.fn(),
    // setModel is on AgentSession (not session.agent — that's the inner Agent).
    setModel: setModelSpy,
    agent: {
      sessionId: undefined as string | undefined,
      streamFn: undefined as unknown,
    },
  };
  return { mockSession, setModelSpy, findSpy, emitTurnEnd };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class MockDefaultResourceLoader {
    reload() { return Promise.resolve(); }
  }
  const fakeModel = { id: "claude-opus-4-5", provider: "anthropic" };
  findSpy.mockReturnValue(fakeModel);
  return {
    ...actual,
    createAgentSession: vi.fn(async () => ({ session: mockSession })),
    DefaultResourceLoader: MockDefaultResourceLoader,
    AuthStorage: { create: vi.fn(() => ({})) },
    ModelRegistry: { create: vi.fn(() => ({ find: findSpy })) },
    SessionManager: { inMemory: vi.fn(() => ({})) },
    parseFrontmatter: vi.fn((raw: string) => ({ frontmatter: {}, body: raw })),
    getAgentDir: vi.fn(() => "/fake/agent-dir"),
  };
});

import { runForgeSubagent, type ForgePersona } from "../../../src/extensions/forgecli/forge-subagent.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

let tmpRoot: string;

const persona: ForgePersona = {
  name: "engineer",
  description: "Test engineer",
  systemPrompt: "You are an engineer.",
  filePath: "/fake/engineer.md",
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-routing-dispatch-"));
  fs.mkdirSync(path.join(tmpRoot, ".forge", "personas"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, ".forge", "personas", "engineer.md"), "system prompt", "utf-8");
  setModelSpy.mockClear();
  findSpy.mockClear();
  mockSession.subscribe.mockClear();
  mockSession.prompt.mockClear();
  mockSession.dispose.mockClear();
  // Default: find returns a fake Model
  const fakeModel = { id: "claude-opus-4-5", provider: "anthropic" };
  findSpy.mockReturnValue(fakeModel);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("runForgeSubagent requestedModel seam", () => {
  // 1. requestedModel set + find returns a Model → setModel called
  it("calls setModel with the Model returned by registry.find when requestedModel is provided", async () => {
    const fakeModel = { id: "claude-opus-4-5", provider: "anthropic" };
    findSpy.mockReturnValue(fakeModel);

    await runForgeSubagent({
      persona,
      task: "do work",
      cwd: tmpRoot,
      requestedModel: { provider: "anthropic", model: "claude-opus-4-5" },
    });

    expect(findSpy).toHaveBeenCalledWith("anthropic", "claude-opus-4-5");
    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(setModelSpy).toHaveBeenCalledWith(fakeModel);
  });

  // 2. requestedModel undefined → setModel never called
  it("does not call setModel when requestedModel is not provided", async () => {
    await runForgeSubagent({
      persona,
      task: "do work",
      cwd: tmpRoot,
    });

    expect(setModelSpy).not.toHaveBeenCalled();
  });

  // 3. find returns undefined → setModel not called, no crash, exitCode=0
  it("skips setModel gracefully when registry.find returns undefined (model not available)", async () => {
    findSpy.mockReturnValue(undefined);

    const result = await runForgeSubagent({
      persona,
      task: "do work",
      cwd: tmpRoot,
      requestedModel: { provider: "ollama", model: "nonexistent-model" },
    });

    expect(findSpy).toHaveBeenCalledWith("ollama", "nonexistent-model");
    expect(setModelSpy).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  // 4. setModel rejects → caught, runForgeSubagent still returns exitCode=0
  it("catches setModel rejection and falls through to inherit (exitCode=0)", async () => {
    findSpy.mockReturnValue({ id: "some-model", provider: "anthropic" });
    setModelSpy.mockRejectedValueOnce(new Error("auth not configured"));

    const result = await runForgeSubagent({
      persona,
      task: "do work",
      cwd: tmpRoot,
      requestedModel: { provider: "anthropic", model: "some-model" },
    });

    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  // 5. IL10 invariant (equal case): stream returns same model as requestedModel
  //    → result.model comes from stream, not from requestedModel string
  it("IL10: result.model reflects stream-observed model even when it equals requestedModel", async () => {
    findSpy.mockReturnValue({ id: "claude-opus-4-5", provider: "anthropic" });

    // Make prompt() fire a turn_end event with the same model
    mockSession.prompt.mockImplementationOnce(async () => {
      emitTurnEnd("claude-opus-4-5", "anthropic");
    });

    const result = await runForgeSubagent({
      persona,
      task: "do work",
      cwd: tmpRoot,
      requestedModel: { provider: "anthropic", model: "claude-opus-4-5" },
    });

    // The model comes from the stream (msg.model), not from requestedModel
    expect(result.model).toBe("claude-opus-4-5");
    expect(result.provider).toBe("anthropic");
  });

  // 6. IL10 invariant (substitution): pi auto-substitutes a different model
  //    → result.model carries the substituted model, not the requested one
  it("IL10: result.model reflects substituted stream model when pi auto-substitutes", async () => {
    findSpy.mockReturnValue({ id: "claude-opus-4-5", provider: "anthropic" });

    // Simulate pi returning a different (cheaper) model than requested
    mockSession.prompt.mockImplementationOnce(async () => {
      emitTurnEnd("claude-sonnet-4-6", "anthropic");
    });

    const result = await runForgeSubagent({
      persona,
      task: "do work",
      cwd: tmpRoot,
      requestedModel: { provider: "anthropic", model: "claude-opus-4-5" },
    });

    // result.model must be what the STREAM returned, not what was requested
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.provider).toBe("anthropic");
    // setModel was still called with the requested model
    expect(setModelSpy).toHaveBeenCalledTimes(1);
  });
});
