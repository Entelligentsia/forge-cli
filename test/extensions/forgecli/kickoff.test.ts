// Unit tests for kickoff.ts — sendKickoff slash-command guard.
//
// Kickoff-dispatch fix: pi's `sendUserMessage` routes through
// `prompt(text, { expandPromptTemplates: false })`, which skips
// extension-command dispatch entirely. A steered "/forge:..." string lands
// as literal prose the model cannot execute. sendKickoff therefore rejects
// slash-command strings at the call site so the bug class cannot recur
// (the original instances were post-init-hook.ts and post-sprint-hook.ts
// steering "/forge:rebuild --enrich").

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { sendKickoff } from "../../../src/extensions/forgecli/kickoff.js";

function makeFakePi() {
	const sendUserMessage = vi.fn<(text: string, opts?: unknown) => void>();
	return { pi: { sendUserMessage } as unknown as ExtensionAPI, sendUserMessage };
}

describe("sendKickoff", () => {
	it("steers workflow prose with deliverAs: 'steer'", () => {
		const { pi, sendUserMessage } = makeFakePi();

		sendKickoff(pi, "# /forge:enhance --phase 2\n\nRun the workflow below.");

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const [text, opts] = sendUserMessage.mock.calls[0] as [string, unknown];
		expect(text).toContain("Run the workflow below.");
		expect(opts).toEqual({ deliverAs: "steer" });
	});

	it("throws on a slash-command string instead of steering it", () => {
		const { pi, sendUserMessage } = makeFakePi();

		expect(() => sendKickoff(pi, "/forge:rebuild --enrich")).toThrow(/slash-command string/);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("throws on any leading /command, including multi-line text", () => {
		const { pi, sendUserMessage } = makeFakePi();

		expect(() => sendKickoff(pi, "/forge:plan FORGE-S30-T01\nextra context")).toThrow(/slash-command string/);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not reject prose that merely mentions a slash command mid-text", () => {
		const { pi, sendUserMessage } = makeFakePi();

		sendKickoff(pi, "Run the enhance flow (formerly /forge:rebuild --enrich).");

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("does not reject a lone '/' or '/ ' (not a command shape)", () => {
		const { pi, sendUserMessage } = makeFakePi();

		sendKickoff(pi, "/");
		sendKickoff(pi, "/ followed by prose");

		expect(sendUserMessage).toHaveBeenCalledTimes(2);
	});
});
