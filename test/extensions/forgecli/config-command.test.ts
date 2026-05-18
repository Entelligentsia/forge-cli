// Tests for registerConfigCommand. Slice 4a — Plan 16.
//
// Confirms that calling registerConfigCommand registers `forge:config` against
// the supplied ExtensionAPI mock.

import { describe, expect, it, vi } from "vitest";
import { registerConfigCommand } from "../../../src/extensions/forgecli/config-command.js";

describe("registerConfigCommand", () => {
  it("registers /forge:config on the supplied pi extension api", () => {
    const registerCommand = vi.fn();
    const pi = { registerCommand } as unknown as Parameters<typeof registerConfigCommand>[0];

    registerConfigCommand(pi, { forgeRoot: null });

    expect(registerCommand).toHaveBeenCalledOnce();
    const [name, descriptor] = registerCommand.mock.calls[0];
    expect(name).toBe("forge:config");
    expect(descriptor).toHaveProperty("description");
    expect(descriptor).toHaveProperty("handler");
    expect(typeof descriptor.handler).toBe("function");
  });

  it("registers with a description that mentions routing config", () => {
    const registerCommand = vi.fn();
    const pi = { registerCommand } as unknown as Parameters<typeof registerConfigCommand>[0];

    registerConfigCommand(pi, { forgeRoot: "/tmp/x" });

    const [, descriptor] = registerCommand.mock.calls[0];
    expect(descriptor.description).toMatch(/routing|persona|pipeline/i);
  });
});
