// Unit tests for the /forge:implement native kickoff handler (FORGE-S20-T06).
//
// Conventions mirror plan.test.ts: tmp-dir fixtures per test via
// fs.mkdtempSync + afterEach cleanup; absolute paths only. Persona used here
// is `engineer` (per implement_plan.md frontmatter `deps.personas: [engineer]`).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	checkMaterialization,
	composeKickoff,
	extractPersonaNames,
	parseImplementArgs,
	registerImplement,
} from "../../../src/extensions/forgecli/implement.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-implement-"));
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
	"  reasoning: Medium",
	"deps:",
	"  personas: [engineer]",
	"  skills: [engineer, generic]",
	"---",
	"",
	"# Implement Plan",
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
	"## Algorithm",
	"",
	"1. Load PLAN.md.",
	"2. Implement, verify, write PROGRESS.md.",
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
		fs.writeFileSync(
			path.join(proj, ".forge", "workflows", "implement_plan.md"),
			opts.workflowMd ?? FULL_WORKFLOW,
			"utf8",
		);
	}

	if (!opts.omitPersona) {
		const name = opts.personaName ?? "engineer";
		const body =
			opts.personaBody ??
			[
				"🌱 **Forge Engineer** — I build what was planned.",
				"",
				"## Capabilities",
				"",
				"- Implement, test, document",
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
			const cmd = registered.find((r) => r.name === "forge:implement");
			if (!cmd) throw new Error("forge:implement not registered");
			await cmd.handler(args, ctx);
		},
	};
}

// ── Pure-function tests ──────────────────────────────────────────────────

describe("parseImplementArgs", () => {
	it("empty args → empty mode", () => {
		expect(parseImplementArgs("", "/cwd")).toEqual({
			mode: "empty",
			taskRef: "",
			sourceLabel: expect.stringContaining("no input"),
		});
		expect(parseImplementArgs("   ", "/cwd").mode).toBe("empty");
	});

	it("@<path> reads file (relative to cwd)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "implement-arg-"));
		try {
			const seedPath = path.join(dir, "seed.md");
			fs.writeFileSync(seedPath, "task body content", "utf8");
			const p = parseImplementArgs("@seed.md", dir);
			expect(p.mode).toBe("file");
			expect(p.taskRef).toBe("task body content");
			expect(p.sourceLabel).toContain("seed.md");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("@<absolute path> reads file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "implement-arg-"));
		try {
			const seedPath = path.join(dir, "seed.md");
			fs.writeFileSync(seedPath, "abs body", "utf8");
			const p = parseImplementArgs(`@${seedPath}`, "/some/other/cwd");
			expect(p.mode).toBe("file");
			expect(p.taskRef).toBe("abs body");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("inline text → text mode, trimmed", () => {
		const p = parseImplementArgs("  FORGE-S20-T06  ", "/cwd");
		expect(p.mode).toBe("text");
		expect(p.taskRef).toBe("FORGE-S20-T06");
	});

	it("@<missing> throws", () => {
		expect(() => parseImplementArgs("@/no/such/file/exists.md", "/cwd")).toThrow();
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
		const md = ["---", "deps:", "  personas: [engineer, supervisor]", "---", "body"].join("\n");
		expect(extractPersonaNames(md)).toEqual(["engineer", "supervisor"]);
	});
});

describe("checkMaterialization", () => {
	it("happy path: all four markers present", () => {
		const res = checkMaterialization("/tmp/implement_plan.md", FULL_WORKFLOW);
		expect(res.ok).toBe(true);
		expect(res.missing).toEqual([]);
	});

	it("missing Store-Write Verification → reported", () => {
		const md = FULL_WORKFLOW.replace(/Store-Write Verification/g, "Store-Write XXX");
		const res = checkMaterialization("/tmp/implement_plan.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing).toContain("Store-Write Verification");
	});

	it("missing Iron Laws → reported", () => {
		const md = FULL_WORKFLOW.replace(/Iron Laws/g, "Iron Rules");
		const res = checkMaterialization("/tmp/implement_plan.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing).toContain("Iron Laws");
	});

	it("missing forge_store → reported", () => {
		const md = FULL_WORKFLOW.replace(/forge_store/g, "store_query_thing");
		const res = checkMaterialization("/tmp/implement_plan.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing).toContain("forge_store");
	});

	it("persona declared but not referenced in body → reported", () => {
		const fmEnd = FULL_WORKFLOW.indexOf("\n---\n", 4);
		const fm = FULL_WORKFLOW.slice(0, fmEnd + 5);
		const body = FULL_WORKFLOW.slice(fmEnd + 5).replace(/engineer/g, "worker");
		const md = fm + body;
		const res = checkMaterialization("/tmp/implement_plan.md", md);
		expect(res.ok).toBe(false);
		expect(res.missing.some((m) => m.includes("persona file path"))).toBe(true);
	});
});

describe("composeKickoff", () => {
	it("contains heading, persona identity, dispatch, workflow body, and Input section", () => {
		const out = composeKickoff({
			workflowMd: FULL_WORKFLOW,
			personaIdentity: "🌱 **Forge Engineer** — identity line.",
			parsed: { mode: "empty", taskRef: "", sourceLabel: "(no input — engineer infers)" },
		});
		expect(out).toContain("# /forge:implement");
		expect(out).toContain("🌱 **Forge Engineer** — identity line.");
		expect(out).toContain("## Dispatch");
		expect(out).toContain("forge_store_query");
		expect(out).toContain("PROGRESS.md");
		expect(out).toContain("Implement Plan"); // workflow heading
		expect(out).toContain("## Input");
	});

	it("text-mode appends task ref under Input — sourceLabel", () => {
		const out = composeKickoff({
			workflowMd: FULL_WORKFLOW,
			personaIdentity: "x",
			parsed: { mode: "text", taskRef: "FORGE-S20-T06", sourceLabel: "(seed from inline text)" },
		});
		expect(out).toContain("## Input — (seed from inline text)");
		expect(out).toContain("FORGE-S20-T06");
	});

	it("file-mode appends file body under Input — sourceLabel", () => {
		const out = composeKickoff({
			workflowMd: FULL_WORKFLOW,
			personaIdentity: "x",
			parsed: { mode: "file", taskRef: "file body content here", sourceLabel: "(seed from file: seed.md)" },
		});
		expect(out).toContain("## Input — (seed from file: seed.md)");
		expect(out).toContain("file body content here");
	});
});

// ── Handler integration tests ────────────────────────────────────────────

describe("registerImplement — handler integration", () => {
	it("kickoff happy path (empty argv): one sendUserMessage with deliverAs:steer", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("");

		expect(stub.notifications.filter((n) => n.level === "error")).toHaveLength(0);
		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = stub.pi.sendUserMessage.mock.calls[0];
		expect(opts).toEqual({ deliverAs: "steer" });
		expect(typeof msg).toBe("string");
		const text = msg as string;
		expect(text).toContain("# /forge:implement");
		expect(text).toContain("forge_store_query");
		expect(text).toContain("🌱 **Forge Engineer**"); // persona identity
		expect(text).toContain("Implement Plan"); // workflow body included
	});

	it("@<path> argv: kickoff body contains file contents under Input", async () => {
		const proj = scaffoldProject();
		const seedPath = path.join(proj, "seed.md");
		fs.writeFileSync(seedPath, "task seed from file", "utf8");
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("@seed.md");

		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [msg] = stub.pi.sendUserMessage.mock.calls[0];
		expect(msg as string).toContain("## Input — (seed from file: seed.md)");
		expect(msg as string).toContain("task seed from file");
	});

	it("free-form text argv: kickoff body contains the inline text under Input", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("Implement task FORGE-S20-T06 quickly");

		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [msg] = stub.pi.sendUserMessage.mock.calls[0];
		expect(msg as string).toContain("## Input — (seed from inline text)");
		expect(msg as string).toContain("Implement task FORGE-S20-T06 quickly");
	});

	it("missing marker (Store-Write Verification) → notify error + abort", async () => {
		const proj = scaffoldProject({
			workflowMd: FULL_WORKFLOW.replace(/Store-Write Verification/g, "Store-Write XXX"),
		});
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("Store-Write Verification"))).toBe(
			true,
		);
	});

	it("deliverAs:'steer' enforcement — opts argument matches exactly", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("any text");

		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [, opts] = stub.pi.sendUserMessage.mock.calls[0];
		expect(opts).toEqual({ deliverAs: "steer" });
	});

	it("missing workflow file → notify error + abort", async () => {
		const proj = scaffoldProject({ omitWorkflow: true });
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(
			stub.notifications.some(
				(n) =>
					n.level === "error" &&
					n.msg.includes("workflow not found") &&
					n.msg.includes(".forge/workflows/implement_plan.md"),
			),
		).toBe(true);
	});

	it("@<missing> argv → notify error + abort, no dispatch", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("@no-such-file.md");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("failed to read seed"))).toBe(true);
	});

	it("persona-load failure (declared persona file absent) → notify error + abort", async () => {
		const proj = scaffoldProject({ omitPersona: true });
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(
			stub.notifications.some(
				(n) => n.level === "error" && n.msg.includes("engineer") && n.msg.includes("load failed"),
			),
		).toBe(true);
	});

	it("registers with description string and forge:implement name", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerImplement(stub.pi as never, { cwd: proj });
		const cmd = stub.registered.find((r) => r.name === "forge:implement");
		expect(cmd).toBeDefined();
		expect(cmd!.description).toMatch(/implement-plan workflow/i);
	});
});
