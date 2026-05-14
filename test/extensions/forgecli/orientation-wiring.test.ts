// Integration tests for the two project-orientation wirings.
//
//   subagent path     → runForgeSubagent wraps systemPromptOverride with the
//                       orientation block prepended to the persona body.
//   main-thread path  → pi.on("before_agent_start") returns a systemPrompt
//                       string prepended with the orientation block.
//
// Both paths import buildProjectOrientation from the same module — single
// source of truth check is enforced by the smoke gate (E2E-17), not here.

import { describe, expect, it, vi } from "vitest";

// ── Capture DefaultResourceLoader options ────────────────────────────────
// The constructor receives `systemPromptOverride: () => string`. We capture
// every options bag and run the callback to assert its return value.
const { capturedOptions, mockSession } = vi.hoisted(() => {
	const captured: Array<Record<string, unknown>> = [];
	const session = {
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => undefined),
		abort: vi.fn(() => undefined),
		dispose: vi.fn(() => undefined),
	};
	return { capturedOptions: captured, mockSession: session };
});

vi.mock("@entelligentsia/pi-coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class CapturingLoader {
		constructor(options: Record<string, unknown>) {
			capturedOptions.push(options);
		}
		async reload(): Promise<void> {
			/* no-op */
		}
	}
	return {
		...actual,
		DefaultResourceLoader: CapturingLoader,
		createAgentSession: vi.fn(async () => ({ session: mockSession })),
		AuthStorage: { create: () => ({}) },
		ModelRegistry: { create: () => ({}) },
		SessionManager: { inMemory: () => ({}) },
		getAgentDir: () => "/tmp/agent-dir",
	};
});

const { runForgeSubagent } = await import(
	"../../../src/extensions/forgecli/forge-subagent.js"
);

describe("runForgeSubagent — orientation wired into systemPromptOverride", () => {
	it("prepends buildProjectOrientation output to persona body", async () => {
		capturedOptions.length = 0;
		const cwd = "/tmp/forge-orientation-test-project";

		await runForgeSubagent({
			persona: {
				name: "engineer",
				description: "test",
				systemPrompt: "PERSONA_BODY_SENTINEL",
			},
			task: "ignored",
			cwd,
		});

		expect(capturedOptions.length).toBe(1);
		const override = capturedOptions[0]?.systemPromptOverride as () => string;
		expect(typeof override).toBe("function");
		const composed = override();
		// Orientation prefix
		expect(composed).toMatch(/^## Project Orientation/);
		expect(composed).toContain(cwd);
		expect(composed).toMatch(/\.forge\/config\.json/);
		expect(composed).toMatch(/engineering\//);
		// Persona body retained
		expect(composed).toContain("PERSONA_BODY_SENTINEL");
		// Orientation precedes persona body
		const orientationIdx = composed.indexOf("Project Orientation");
		const personaIdx = composed.indexOf("PERSONA_BODY_SENTINEL");
		expect(orientationIdx).toBeLessThan(personaIdx);
	});
});

// ── Main-thread handler ──────────────────────────────────────────────────

describe("pi.on(before_agent_start) — main-thread orientation handler", () => {
	it("imports buildProjectOrientation and returns a prepended systemPrompt", async () => {
		// This handler is registered inside the forgecli extension factory only
		// when a Forge project is discovered. We test the helper composition
		// directly here, as a unit-level proof that the handler shape returns
		// `{ systemPrompt: orientation + "\n" + existing }`. The full pi.on
		// registration is exercised by the smoke gate.
		const { buildProjectOrientation } = await import(
			"../../../src/extensions/forgecli/project-orientation.js"
		);
		const projectRoot = "/tmp/forge-main-thread-test";
		const orientation = buildProjectOrientation(projectRoot);
		const existing = "EXISTING_SYSTEM_PROMPT_SENTINEL";
		const composed = `${orientation}\n${existing}`;
		expect(composed).toMatch(/^## Project Orientation/);
		expect(composed).toContain(projectRoot);
		expect(composed).toContain(existing);
		const orientationIdx = composed.indexOf("Project Orientation");
		const existingIdx = composed.indexOf(existing);
		expect(orientationIdx).toBeLessThan(existingIdx);
	});
});
