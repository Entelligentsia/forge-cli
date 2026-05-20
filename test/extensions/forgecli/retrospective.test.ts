// Unit tests for the /forge:retrospective native kickoff handler (FORGE-S23-T06).
//
// Conventions mirror plan.test.ts: tmp-dir fixtures per test via
// fs.mkdtempSync + afterEach cleanup; absolute paths only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	composeKickoff,
	extractPersonaNames,
	parseRetroArgs,
	registerRetrospective,
} from "../../../src/extensions/forgecli/retrospective.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-retro-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Minimal workflow that loadWorkflow() will accept (needs a `---` frontmatter block).
const RETRO_WORKFLOW = [
	"---",
	"requirements:",
	"  reasoning: High",
	"deps:",
	"  personas: [architect]",
	"  skills: [architect, generic]",
	"---",
	"",
	"# Retrospective",
	"",
	"## Algorithm",
	"",
	"1. Load all task manifests for the sprint.",
	"2. Compute cost and bottlenecks.",
	"3. Write RETROSPECTIVE.md.",
].join("\n");

interface ScaffoldOpts {
	workflowMd?: string;
	personaName?: string;
	personaBody?: string;
	omitWorkflow?: boolean;
	omitPersona?: boolean;
}

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
			path.join(proj, ".forge", "workflows", "sprint_retrospective.md"),
			opts.workflowMd ?? RETRO_WORKFLOW,
			"utf8",
		);
	}

	if (!opts.omitPersona) {
		const name = opts.personaName ?? "architect";
		const body =
			opts.personaBody ??
			[
				"🗻 **Forge Architect** — I hold the shape of the whole.",
				"",
				"## Capabilities",
				"",
				"- Plan, design, and approve",
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
			const cmd = registered.find((r) => r.name === "forge:retrospective");
			if (!cmd) throw new Error("forge:retrospective not registered");
			await cmd.handler(args, ctx);
		},
	};
}

// ── Pure-function tests ──────────────────────────────────────────────────

describe("parseRetroArgs", () => {
	it("empty args → empty mode", () => {
		expect(parseRetroArgs("", "/cwd")).toEqual({
			mode: "empty",
			sprintRef: "",
			sourceLabel: expect.stringContaining("no sprint specified"),
		});
		expect(parseRetroArgs("   ", "/cwd").mode).toBe("empty");
	});

	it("FORGE-SNN text → text mode", () => {
		const p = parseRetroArgs("FORGE-S23", "/cwd");
		expect(p.mode).toBe("text");
		expect(p.sprintRef).toBe("FORGE-S23");
		expect(p.sourceLabel).toContain("inline text");
	});

	it("@<path> reads file (relative to cwd)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-arg-"));
		try {
			const seedPath = path.join(dir, "seed.md");
			fs.writeFileSync(seedPath, "sprint seed content", "utf8");
			const p = parseRetroArgs("@seed.md", dir);
			expect(p.mode).toBe("file");
			expect(p.sprintRef).toBe("sprint seed content");
			expect(p.sourceLabel).toContain("seed.md");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("@<absolute path> reads file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-arg-"));
		try {
			const seedPath = path.join(dir, "seed.md");
			fs.writeFileSync(seedPath, "abs body", "utf8");
			const p = parseRetroArgs(`@${seedPath}`, "/some/other/cwd");
			expect(p.mode).toBe("file");
			expect(p.sprintRef).toBe("abs body");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("@<missing> throws", () => {
		expect(() => parseRetroArgs("@/no/such/file/exists.md", "/cwd")).toThrow();
	});

	it("inline text trimmed", () => {
		const p = parseRetroArgs("  FORGE-S22  ", "/cwd");
		expect(p.mode).toBe("text");
		expect(p.sprintRef).toBe("FORGE-S22");
	});
});

describe("extractPersonaNames", () => {
	it("returns names declared in deps.personas:", () => {
		expect(extractPersonaNames(RETRO_WORKFLOW)).toEqual(["architect"]);
	});

	it("returns [] when frontmatter absent", () => {
		expect(extractPersonaNames("just a body, no frontmatter\n")).toEqual([]);
	});

	it("returns [] when personas key absent", () => {
		const md = ["---", "deps:", "  skills: [engineer]", "---", "body"].join("\n");
		expect(extractPersonaNames(md)).toEqual([]);
	});

	it("handles multiple persona names", () => {
		const md = ["---", "deps:", "  personas: [architect, engineer]", "---", "body"].join("\n");
		expect(extractPersonaNames(md)).toEqual(["architect", "engineer"]);
	});
});

describe("composeKickoff", () => {
	it("contains heading, persona identity, dispatch, persona path, workflow path, workflow body, Input section", () => {
		const out = composeKickoff({
			workflowMd: RETRO_WORKFLOW,
			personaIdentity: "🗻 **Forge Architect** — identity line.",
			parsed: { mode: "empty", sprintRef: "", sourceLabel: "(no sprint specified — will prompt)" },
		});
		expect(out).toContain("# /forge:retrospective");
		expect(out).toContain("🗻 **Forge Architect** — identity line.");
		expect(out).toContain("## Dispatch");
		expect(out).toContain(".forge/personas/architect.md");
		expect(out).toContain(".forge/workflows/sprint_retrospective.md");
		expect(out).toContain("## Workflow");
		expect(out).toContain("Retrospective"); // workflow heading
		expect(out).toContain("## Input");
		expect(out).toContain("no sprint specified");
	});

	it("text-mode appends sprint ref under Input — sourceLabel", () => {
		const out = composeKickoff({
			workflowMd: RETRO_WORKFLOW,
			personaIdentity: "x",
			parsed: { mode: "text", sprintRef: "FORGE-S23", sourceLabel: "(seed from inline text)" },
		});
		expect(out).toContain("## Input — (seed from inline text)");
		expect(out).toContain("FORGE-S23");
	});

	it("file-mode appends file body under Input — sourceLabel", () => {
		const out = composeKickoff({
			workflowMd: RETRO_WORKFLOW,
			personaIdentity: "x",
			parsed: { mode: "file", sprintRef: "sprint notes body", sourceLabel: "(seed from file: notes.md)" },
		});
		expect(out).toContain("## Input — (seed from file: notes.md)");
		expect(out).toContain("sprint notes body");
	});

	it("snapshot — kickoff body for empty-arg case matches snapshot", () => {
		const out = composeKickoff({
			workflowMd: RETRO_WORKFLOW,
			personaIdentity: "🗻 **Forge Architect** — I hold the shape of the whole.",
			parsed: { mode: "empty", sprintRef: "", sourceLabel: "(no sprint specified — will prompt)" },
		});
		expect(out).toMatchSnapshot();
	});
});

// ── Handler integration tests ────────────────────────────────────────────

describe("registerRetrospective — handler integration", () => {
	it("kickoff happy path (empty argv): one sendUserMessage with deliverAs:steer", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });

		await stub.invoke("");

		expect(stub.notifications.filter((n) => n.level === "error")).toHaveLength(0);
		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = stub.pi.sendUserMessage.mock.calls[0];
		expect(opts).toEqual({ deliverAs: "steer" });
		expect(typeof msg).toBe("string");
		const text = msg as string;
		expect(text).toContain("# /forge:retrospective");
		expect(text).toContain(".forge/personas/architect.md");
		expect(text).toContain(".forge/workflows/sprint_retrospective.md");
		expect(text).toContain("🗻 **Forge Architect**"); // persona identity
		expect(text).toContain("Retrospective"); // workflow body included
	});

	it("FORGE-SNN argv: kickoff body contains sprint ref under Input", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });

		await stub.invoke("FORGE-S23");

		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [msg] = stub.pi.sendUserMessage.mock.calls[0];
		expect(msg as string).toContain("## Input — (seed from inline text)");
		expect(msg as string).toContain("FORGE-S23");
	});

	it("@<path> argv: kickoff body contains file contents under Input", async () => {
		const proj = scaffoldProject();
		const seedPath = path.join(proj, "seed.md");
		fs.writeFileSync(seedPath, "sprint seed from file", "utf8");
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });

		await stub.invoke("@seed.md");

		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [msg] = stub.pi.sendUserMessage.mock.calls[0];
		expect(msg as string).toContain("## Input — (seed from file: seed.md)");
		expect(msg as string).toContain("sprint seed from file");
	});

	it("deliverAs:'steer' enforcement — opts argument matches exactly", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });

		await stub.invoke("FORGE-S22");

		expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [, opts] = stub.pi.sendUserMessage.mock.calls[0];
		expect(opts).toEqual({ deliverAs: "steer" });
	});

	it("missing workflow file → notify error + abort", async () => {
		const proj = scaffoldProject({ omitWorkflow: true });
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(
			stub.notifications.some(
				(n) =>
					n.level === "error" &&
					n.msg.includes("workflow not found") &&
					n.msg.includes(".forge/workflows/sprint_retrospective.md"),
			),
		).toBe(true);
	});

	it("@<missing> argv → notify error + abort, no dispatch", async () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });

		await stub.invoke("@no-such-file.md");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(stub.notifications.some((n) => n.level === "error" && n.msg.includes("failed to read seed"))).toBe(true);
	});

	it("persona-load failure (declared persona file absent) → notify error + abort", async () => {
		const proj = scaffoldProject({ omitPersona: true });
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });

		await stub.invoke("");

		expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(
			stub.notifications.some(
				(n) => n.level === "error" && n.msg.includes("architect") && n.msg.includes("load failed"),
			),
		).toBe(true);
	});

	it("registers with description string and forge:retrospective name", () => {
		const proj = scaffoldProject();
		const stub = makeStub();
		registerRetrospective(stub.pi as never, { cwd: proj });
		const cmd = stub.registered.find((r) => r.name === "forge:retrospective");
		expect(cmd).toBeDefined();
		expect(cmd!.description).toMatch(/retrospective/i);
	});
});
