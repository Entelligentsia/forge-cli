// Unit tests for the /forge:enhance Phase-2 native kickoff handler
// (FORGE-S20-T04).
//
// Conventions mirror loaders/persona-skill-loader.test.ts: tmp-dir fixtures
// per test via fs.mkdtempSync + afterEach cleanup; absolute paths only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	checkMaterialization,
	composeKickoff,
	extractPersonaNames,
	parseEnhanceArgs,
	registerEnhance,
} from "../../../src/extensions/forgecli/enhance.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-enhance-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface ScaffoldOpts {
	workflowMd?: string;
	personaName?: string;
	personaBody?: string;
	omitWorkflow?: boolean;
	omitPersona?: boolean;
}

const FULL_WORKFLOW = [
	"---",
	"requirements:",
	"  reasoning: High",
	"deps:",
	"  personas: [engineer]",
	"  skills: [engineer]",
	"---",
	"",
	"# Meta-Workflow: Enhancement Agent",
	"",
	"## Iron Laws",
	"",
	"- IL1: dispatch via forge_store only.",
	"",
	"## Store-Write Verification",
	"",
	"After every store write, re-read via forge_store_query to verify.",
	"",
	"## Persona reference",
	"",
	"You are the engineer. See .forge/personas/engineer.md for full identity.",
	"",
	"## Phase 2 algorithm",
	"",
	"1. Collect friction events via forge_store_query.",
	"2. Synthesize proposals.",
].join("\n");

function scaffoldProject(opts: ScaffoldOpts = {}): string {
	const proj = path.join(tmpRoot, "proj");
	fs.mkdirSync(path.join(proj, ".forge", "workflows"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "personas"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "skills"), { recursive: true });

	fs.writeFileSync(
		path.join(proj, ".forge", "config.json"),
		JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }),
		"utf8",
	);

	if (!opts.omitWorkflow) {
		fs.writeFileSync(path.join(proj, ".forge", "workflows", "enhance.md"), opts.workflowMd ?? FULL_WORKFLOW, "utf8");
	}

	if (!opts.omitPersona) {
		const name = opts.personaName ?? "engineer";
		const body =
			opts.personaBody ??
			[
				"🌱 **Forge Engineer** — I plan what will be built.",
				"",
				"## Capabilities",
				"",
				"- Read and write code",
			].join("\n");
		fs.writeFileSync(path.join(proj, ".forge", "personas", `${name}.md`), body, "utf8");
	}

	return proj;
}

// ── Stub `pi` ───────────────────────────────────────────────────────────

interface RegisteredCommand {
	name: string;
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface StubResult {
	pi: { sendUserMessage: ReturnType<typeof vi.fn>; registerCommand: ReturnType<typeof vi.fn> };
	registered: RegisteredCommand[];
	notifications: { msg: string; level: string }[];
	ctx: { ui: { notify: ReturnType<typeof vi.fn> } };
	invoke: (args: string) => Promise<void>;
}

function makeStub(): StubResult {
	const registered: RegisteredCommand[] = [];
	const sendUserMessage = vi.fn<(c: unknown, opts?: unknown) => void>();
	const registerCommand = vi.fn(
		(name: string, def: { description: string; handler: RegisteredCommand["handler"] }) => {
			registered.push({ name, description: def.description, handler: def.handler });
		},
	);
	const notifications: { msg: string; level: string }[] = [];
	const notify = vi.fn((msg: string, level: string) => {
		notifications.push({ msg, level });
	});
	const ctx = { ui: { notify } };
	const pi = { sendUserMessage, registerCommand };
	return {
		pi,
		registered,
		notifications,
		ctx,
		invoke: async (args: string) => {
			const cmd = registered.find((r) => r.name === "forge:enhance");
			if (!cmd) throw new Error("forge:enhance not registered");
			await cmd.handler(args, ctx);
		},
	};
}

// ── Pure-function tests ──────────────────────────────────────────────────

describe("parseEnhanceArgs", () => {
	it("empty args defaults to phase 2", () => {
		expect(parseEnhanceArgs("")).toEqual({ phase: 2, extra: "", rawPhaseFlag: "" });
		expect(parseEnhanceArgs("   ")).toEqual({ phase: 2, extra: "", rawPhaseFlag: "" });
	});

	it("--phase 1, --phase 2, --phase 3 each map correctly", () => {
		expect(parseEnhanceArgs("--phase 1").phase).toBe(1);
		expect(parseEnhanceArgs("--phase 2").phase).toBe(2);
		expect(parseEnhanceArgs("--phase 3").phase).toBe(3);
	});

	it("--phase=N form is also accepted", () => {
		expect(parseEnhanceArgs("--phase=3").phase).toBe(3);
	});

	it("--auto maps to phase 1", () => {
		expect(parseEnhanceArgs("--auto").phase).toBe(1);
	});

	it("invalid --phase value throws", () => {
		expect(() => parseEnhanceArgs("--phase 4")).toThrow(/invalid --phase value/);
		expect(() => parseEnhanceArgs("--phase abc")).toThrow(/invalid --phase value/);
		expect(() => parseEnhanceArgs("--phase=9")).toThrow(/invalid --phase value/);
	});

	it("free-form tail collected as extra", () => {
		const p = parseEnhanceArgs("--phase 2 some extra context here");
		expect(p.phase).toBe(2);
		expect(p.extra).toBe("some extra context here");
	});
});

describe("extractPersonaNames", () => {
	it("returns names declared in deps.personas:", () => {
		expect(extractPersonaNames(FULL_WORKFLOW)).toEqual(["engineer"]);
	});

	it("returns [] when frontmatter absent", () => {
		expect(extractPersonaNames("just a body, no frontmatter\n")).toEqual([]);
	});

	it("returns [] when personas key absent", () => {
		const md = ["---", "deps:", "  skills: [engineer]", "---", "body"].join("\n");
		expect(extractPersonaNames(md)).toEqual([]);
	});

	it("handles multiple persona names", () => {
		const md = ["---", "deps:", "  personas: [engineer, architect]", "---", "body"].join("\n");
		expect(extractPersonaNames(md)).toEqual(["engineer", "architect"]);
	});
});

describe("checkMaterialization", () => {
	it("happy path: all four markers present", () => {
		const res = checkMaterialization("/tmp/enhance.md", FULL_WORKFLOW);
		expect(res.ok).toBe(true);
		expect(res.missing).toEqual([]);
	});

	it("missing Store-Write Verification → reported", () => {
		const md = FULL_WORKFLOW.replace(/Store-Write Verification/g, "Store-Write XXX");
		const res = checkMaterialization("/tmp/enhance.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing).toContain("Store-Write Verification");
	});

	it("missing Iron Laws → reported", () => {
		const md = FULL_WORKFLOW.replace(/Iron Laws/g, "Iron Rules");
		const res = checkMaterialization("/tmp/enhance.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing).toContain("Iron Laws");
	});

	it("missing forge_store → reported", () => {
		const md = FULL_WORKFLOW.replace(/forge_store/g, "store_query_thing");
		const res = checkMaterialization("/tmp/enhance.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing).toContain("forge_store");
	});

	it("persona declared but not referenced in body → reported", () => {
		// Replace every `engineer` token in the BODY (after frontmatter) with `worker`.
		const fmEnd = FULL_WORKFLOW.indexOf("\n---\n", 4);
		const fm = FULL_WORKFLOW.slice(0, fmEnd + 5);
		const body = FULL_WORKFLOW.slice(fmEnd + 5).replace(/engineer/g, "worker");
		const md = fm + body;
		const res = checkMaterialization("/tmp/enhance.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing.some((m) => m.includes("persona file path"))).toBe(true);
	});
});

describe("composeKickoff", () => {
	it("Phase 2 body contains forge_store_query directive and engineering/enhancement-proposals/phase2- path", () => {
		const out = composeKickoff({
			workflowMd: FULL_WORKFLOW,
			personaIdentity: "🌱 **Forge Engineer** — identity line.",
			parsed: { phase: 2, extra: "", rawPhaseFlag: "" },
			cwd: "/proj",
			timestamp: "20260510T120000Z",
		});
		expect(out).toContain("# /forge:enhance --phase 2");
		expect(out).toContain("🌱 **Forge Engineer** — identity line.");
		expect(out).toContain("forge_store_query");
		expect(out).toContain("engineering/enhancement-proposals/phase2-20260510T120000Z.md");
		expect(out).toContain("〇 no friction events present");
	});

	it("Phase 1 body excludes Phase-2-specific directives", () => {
		const out = composeKickoff({
			workflowMd: FULL_WORKFLOW,
			personaIdentity: "x",
			parsed: { phase: 1, extra: "", rawPhaseFlag: "--auto" },
			cwd: "/proj",
			timestamp: "20260510T120000Z",
		});
		expect(out).toContain("# /forge:enhance --phase 1");
		expect(out).not.toContain("engineering/enhancement-proposals/phase2-");
		expect(out).toContain("Phase 1 algorithm");
	});

	it("appends extra context section when parsed.extra is non-empty", () => {
		const out = composeKickoff({
			workflowMd: FULL_WORKFLOW,
			personaIdentity: "id",
			parsed: { phase: 2, extra: "user note here", rawPhaseFlag: "" },
			cwd: "/proj",
			timestamp: "20260510T120000Z",
		});
		expect(out).toContain("## Additional context");
		expect(out).toContain("user note here");
	});
});

// ── Handler integration tests ────────────────────────────────────────────

const FIXED_NOW = () => new Date(Date.UTC(2026, 4, 10, 12, 0, 0));

describe("registerEnhance — handler integration", () => {
	it("kickoff happy path (Phase 2 default): one sendUserMessage with deliverAs:steer", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("");

		expect(stub.notifications.filter((n) => n.level === "error")).toHaveLength(0);
		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = stub.pi.sendUserMessage.mock.calls[0];
		expect(opts).toEqual({ deliverAs: "steer" });
		expect(typeof msg).toBe("string");
		const text = msg as string;
		expect(text).toContain("# /forge:enhance --phase 2");
		expect(text).toContain("forge_store_query");
		expect(text).toContain("engineering/enhancement-proposals/phase2-20260510T120000Z.md");
		// Persona identity from scaffolded persona file:
		expect(text).toContain("🌱 **Forge Engineer**");
		// Workflow body is included:
		expect(text).toContain("Meta-Workflow: Enhancement Agent");
	});

	it("missing marker: Store-Write Verification → notify error + abort", async () => {
		const proj = scaffoldProject({
			workflowMd: FULL_WORKFLOW.replace(/Store-Write Verification/g, "Store-Write XXX"),
		});
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("Store-Write Verification"))).toBe(
			true,
		);
	});

	it("missing marker: Iron Laws → notify error + abort", async () => {
		const proj = scaffoldProject({
			workflowMd: FULL_WORKFLOW.replace(/Iron Laws/g, "Iron Rules"),
		});
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("Iron Laws"))).toBe(true);
	});

	it("missing marker: forge_store → notify error + abort", async () => {
		const proj = scaffoldProject({
			workflowMd: FULL_WORKFLOW.replace(/forge_store/g, "store_query_thing"),
		});
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("forge_store"))).toBe(true);
	});

	it("missing marker: persona file path → notify error + abort", async () => {
		const fmEnd = FULL_WORKFLOW.indexOf("\n---\n", 4);
		const fm = FULL_WORKFLOW.slice(0, fmEnd + 5);
		const body = FULL_WORKFLOW.slice(fmEnd + 5).replace(/engineer/g, "worker");
		const proj = scaffoldProject({ workflowMd: fm + body });
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("persona file path"))).toBe(true);
	});

	it("missing meta workflow file → notify error + abort", async () => {
		const proj = scaffoldProject({ omitWorkflow: true });
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(
			stub.notifications.some(
				(n) =>
					n.level === "error" &&
					n.msg.includes("workflow not found") &&
					n.msg.includes(".forge/workflows/enhance.md"),
			),
		).toBe(true);
	});

	it("persona-load failure (declared persona file absent) → notify error + abort", async () => {
		// Workflow declares personas: [enhance-agent], persona file is omitted.
		const wf = FULL_WORKFLOW.replace("personas: [engineer]", "personas: [enhance-agent]");
		// The body still references `engineer` so the persona-marker check
		// could fail. Inject an `enhance-agent.md` literal into the body so
		// the marker check passes but the actual file load still fails.
		const wfWithMarker =
			wf.slice(0, wf.indexOf("\n---\n", 4) + 5) +
			"See .forge/personas/enhance-agent.md.\n" +
			wf.slice(wf.indexOf("\n---\n", 4) + 5);
		const proj = scaffoldProject({ workflowMd: wfWithMarker, omitPersona: true });
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(
			stub.notifications.some(
				(n) => n.level === "error" && n.msg.includes("enhance-agent") && n.msg.includes("load failed"),
			),
		).toBe(true);
	});

	it("invalid --phase value → notify error + abort", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("--phase 4");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("invalid --phase value"))).toBe(true);
	});

	it("deliverAs:'steer' enforcement — second arg matches exactly", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerEnhance(stub.pi as never, { cwd: proj, now: FIXED_NOW });

		await stub.invoke("--phase 1");

		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [, opts] = stub.pi.sendUserMessage.mock.calls[0];
		expect(opts).toEqual({ deliverAs: "steer" });
	});
});
