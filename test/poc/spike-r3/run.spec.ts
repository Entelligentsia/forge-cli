/**
 * Spike R3 — vitest spec.
 *
 * FORGE-S15-T06 — Drives an in-process AgentSession (per SPIKE-LESSONS §1
 * boilerplate) through positive (forge_collate) and negative (bash) cases,
 * asserting that the gated `tool_result` handler fires only on the custom-tool
 * path.
 *
 * Auth-guarded: when ANTHROPIC_API_KEY is unset, AC3+AC4 are skipped (recorded
 * SKIPPED-NO-AUTH in RESULT.md, mirroring the T05 convention). AC1+AC2 PASS
 * solely on registration + handler shape, validated by `npx tsc --noEmit -p
 * tsconfig.spike.json` plus a structural code-read.
 */

import { getModel } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEvidence, registerSpikeR3, resetEvidence } from "./spike.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

describe.skipIf(SKIP)("spike-r3 — bash → custom-tool routing", () => {
	let session: AgentSession;

	beforeAll(async () => {
		const cwd = process.cwd();
		const factories: ExtensionFactory[] = [(pi) => registerSpikeR3(pi)];

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			extensionFactories: factories,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		// MANDATORY (SPIKE-LESSONS §2): createAgentSession only auto-reloads its
		// own loader. With a custom loader, the caller must reload first.
		await resourceLoader.reload();

		const created = await createAgentSession({
			model: getModel("anthropic", "claude-haiku-4-5"),
			thinkingLevel: "min",
			// Explicit allowlist (SPIKE-LESSONS §3); never use noTools.
			tools: ["forge_collate", "bash"],
			sessionManager: SessionManager.inMemory(),
			cwd,
			resourceLoader,
		});
		session = created.session;
	}, 60_000);

	afterAll(async () => {
		if (session) await session.dispose();
	});

	it("AC3 positive — invoking forge_collate fires the trigger and queues /forge:enhance --phase 2", async () => {
		resetEvidence();
		await session.sendUserMessage(
			"Use the forge_collate tool with parameter purgeEvents: true. Do not call any other tools.",
		);
		const ev = getEvidence();
		expect(
			ev.observed.some((o) => o.toolName === "forge_collate"),
			`expected forge_collate in observed; got ${JSON.stringify(ev.observed)}`,
		).toBe(true);
		expect(ev.triggerFiredFor).toContain("forge_collate");
		expect(ev.followUpQueued).toBeGreaterThanOrEqual(1);
		expect(ev.queuedMessages).toContain("/forge:enhance --phase 2");
	}, 120_000);

	it("AC4 negative — bash invocation does NOT fire the trigger", async () => {
		resetEvidence();
		await session.sendUserMessage(
			'Run exactly this bash command and nothing else. Do not call any other tools afterward: echo "--purge-events from collate.cjs"',
		);
		const ev = getEvidence();
		expect(
			ev.observed.some((o) => o.toolName === "bash"),
			`expected bash in observed; got ${JSON.stringify(ev.observed)}`,
		).toBe(true);
		expect(
			ev.triggerFiredFor,
			`triggerFiredFor must NOT include forge_collate or bash; got ${JSON.stringify(ev)}`,
		).not.toContain("forge_collate");
		expect(ev.triggerFiredFor).not.toContain("bash");
		expect(ev.followUpQueued).toBe(0);
	}, 120_000);
});
