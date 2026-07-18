// demo-ask.test.ts — the dev-only demo command is gated on FORGE_DEMO=1.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDemoEnabled, registerDemoAsk } from "../../../../src/extensions/forgecli/commands/demo-ask.js";

function stubApi(): { pi: ExtensionAPI; registered: string[] } {
	const registered: string[] = [];
	const pi = { registerCommand: (name: string) => registered.push(name) } as unknown as ExtensionAPI;
	return { pi, registered };
}

describe("registerDemoAsk gating", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.FORGE_DEMO;
	});
	afterEach(() => {
		if (saved !== undefined) process.env.FORGE_DEMO = saved;
		else delete process.env.FORGE_DEMO;
		vi.restoreAllMocks();
	});

	it("isDemoEnabled true only for FORGE_DEMO=1", () => {
		expect(isDemoEnabled({})).toBe(false);
		expect(isDemoEnabled({ FORGE_DEMO: "0" })).toBe(false);
		expect(isDemoEnabled({ FORGE_DEMO: "true" })).toBe(false);
		expect(isDemoEnabled({ FORGE_DEMO: "1" })).toBe(true);
	});

	it("does NOT register the command in production (FORGE_DEMO unset)", () => {
		delete process.env.FORGE_DEMO;
		const { pi, registered } = stubApi();
		registerDemoAsk(pi);
		expect(registered).toEqual([]);
	});

	it("registers forge:demo-ask when FORGE_DEMO=1", () => {
		process.env.FORGE_DEMO = "1";
		const { pi, registered } = stubApi();
		registerDemoAsk(pi);
		expect(registered).toEqual(["forge:demo-ask"]);
	});
});
