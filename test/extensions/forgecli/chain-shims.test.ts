// chain-shims.test.ts — Unit tests for the 6 chain sub-workflow Kickoff Shim
// handlers (FORGE-S21-T10).
//
// Covers: review-plan, review-code, approve, commit, validate, collate.
//
// For each command the test matrix verifies (≥4 per command, ≥24 total):
//   1. Kickoff happy-path: sendUserMessage called with deliverAs:steer, message
//      contains command heading, dispatch section, and workflow body.
//   2. Argv handling: empty / text / @<path> / @<missing>.
//   3. Materialization-marker missing → refusal, no sendUserMessage.
//   4. Audience behaviour:
//      - Subagent-audience commands (review-plan, review-code, approve, commit,
//        validate): standalone invocation with default CallerContext="orchestrator"
//        → assertAudience refuses → no sendUserMessage.
//      - collate (no audience → "any"): standalone invocation succeeds.
//
// Conventions mirror plan.test.ts: tmp-dir fixtures per test via
// fs.mkdtempSync + afterEach cleanup; absolute paths only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerReviewPlan } from "../../../src/extensions/forgecli/review-plan.js";
import { registerReviewCode } from "../../../src/extensions/forgecli/review-code.js";
import { registerApprove } from "../../../src/extensions/forgecli/approve.js";
import { registerCommit } from "../../../src/extensions/forgecli/commit.js";
import { registerValidate } from "../../../src/extensions/forgecli/validate.js";
import { registerCollate } from "../../../src/extensions/forgecli/collate.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-chain-shims-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Command configuration table ──────────────────────────────────────────────

interface CommandSpec {
	/** Forge command name (without "forge:" prefix). */
	name: string;
	/** Registration function. */
	register: (pi: unknown, opts?: { cwd?: string }) => void;
	/** Relative path to the workflow file under .forge/workflows/. */
	workflowFile: string;
	/** Whether this command's workflow declares audience: subagent. */
	isSubagentAudience: boolean;
	/** Persona name declared in deps.personas: for the fixture. */
	personaName: string;
	/** Expected heading in the composed kickoff message. */
	expectedHeading: string;
	/** Unique dispatch keyword expected in the composed kickoff. */
	dispatchKeyword: string;
}

const COMMANDS: CommandSpec[] = [
	{
		name: "review-plan",
		register: (pi, opts) => registerReviewPlan(pi as Parameters<typeof registerReviewPlan>[0], opts),
		workflowFile: "review_plan.md",
		isSubagentAudience: true,
		personaName: "supervisor",
		expectedHeading: "# /forge:review-plan",
		dispatchKeyword: "PLAN_REVIEW",
	},
	{
		name: "review-code",
		register: (pi, opts) => registerReviewCode(pi as Parameters<typeof registerReviewCode>[0], opts),
		workflowFile: "review_code.md",
		isSubagentAudience: true,
		personaName: "supervisor",
		expectedHeading: "# /forge:review-code",
		dispatchKeyword: "CODE_REVIEW",
	},
	{
		name: "approve",
		register: (pi, opts) => registerApprove(pi as Parameters<typeof registerApprove>[0], opts),
		workflowFile: "architect_approve.md",
		isSubagentAudience: true,
		personaName: "architect",
		expectedHeading: "# /forge:approve",
		dispatchKeyword: "ARCHITECT_APPROVAL",
	},
	{
		name: "commit",
		register: (pi, opts) => registerCommit(pi as Parameters<typeof registerCommit>[0], opts),
		workflowFile: "commit_task.md",
		isSubagentAudience: true,
		personaName: "engineer",
		expectedHeading: "# /forge:commit",
		dispatchKeyword: "COMMIT-SUMMARY",
	},
	{
		name: "validate",
		register: (pi, opts) => registerValidate(pi as Parameters<typeof registerValidate>[0], opts),
		workflowFile: "validate_task.md",
		isSubagentAudience: true,
		personaName: "qa-engineer",
		expectedHeading: "# /forge:validate",
		dispatchKeyword: "VALIDATION_REPORT",
	},
	{
		name: "collate",
		register: (pi, opts) => registerCollate(pi as Parameters<typeof registerCollate>[0], opts),
		workflowFile: "collator_agent.md",
		isSubagentAudience: false, // no audience field → "any" → standalone allowed
		personaName: "collator",
		expectedHeading: "# /forge:collate",
		dispatchKeyword: "forge_store_query",
	},
];

// ── Fixture builders ─────────────────────────────────────────────────────────

/** Build a full workflow fixture for the given persona and audience. */
function makeWorkflow(personaName: string, audience?: string): string {
	const audienceLine = audience ? `audience: ${audience}\n` : "";
	return [
		"---",
		"requirements:",
		"  reasoning: High",
		audienceLine.trim() ? audienceLine.trim() : null,
		"deps:",
		`  personas: [${personaName}]`,
		"  skills: [generic]",
		"---",
		"",
		`# Workflow for ${personaName}`,
		"",
		"## Iron Laws",
		"",
		`- Always use ${personaName}.md persona.`,
		"",
		"## Store-Write Verification",
		"",
		"Re-read via forge_store_query after every write.",
		"",
		"## Algorithm",
		"",
		`1. Load context via forge_store.`,
		`2. Act as ${personaName}.`,
	]
		.filter((l) => l !== null)
		.join("\n");
}

interface ScaffoldOpts {
	workflowFile: string;
	workflowContent?: string;
	personaName?: string;
	personaBody?: string;
	omitWorkflow?: boolean;
	omitPersona?: boolean;
}

function scaffoldProject(opts: ScaffoldOpts): string {
	const proj = path.join(tmpRoot, `proj-${opts.workflowFile.replace(/[^a-z0-9]/gi, "-")}`);
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
			path.join(proj, ".forge", "workflows", opts.workflowFile),
			opts.workflowContent ?? makeWorkflow(opts.personaName ?? "engineer"),
			"utf8",
		);
	}

	if (!opts.omitPersona) {
		const name = opts.personaName ?? "engineer";
		const body =
			opts.personaBody ??
			[
				`🌱 **Forge ${name.charAt(0).toUpperCase() + name.slice(1)}** — I do the work.`,
				"",
				"## Capabilities",
				"",
				"- Plan, execute, and verify",
			].join("\n");
		fs.writeFileSync(path.join(proj, ".forge", "personas", `${name}.md`), body, "utf8");
	}

	return proj;
}

// ── Stub `pi` factory ────────────────────────────────────────────────────────

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
	invoke: (commandName: string, args: string) => Promise<void>;
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
		invoke: async (commandName: string, args: string) => {
			const cmd = registered.find((r) => r.name === commandName);
			if (!cmd) throw new Error(`${commandName} not registered`);
			await cmd.handler(args, ctx);
		},
	};
}

// ── Parametrized test suite ──────────────────────────────────────────────────

for (const spec of COMMANDS) {
	const cmdName = `forge:${spec.name}`;
	const audience = spec.isSubagentAudience ? "subagent" : undefined;

	describe(`/${cmdName} — Kickoff Shim (FORGE-S21-T10)`, () => {
		// ── AC7.1: Kickoff happy-path ───────────────────────────────────────────

		it("kickoff happy-path (empty argv): sendUserMessage called with deliverAs:steer", async () => {
			const workflowContent = makeWorkflow(spec.personaName, audience);
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent,
				personaName: spec.personaName,
			});
			const stub = makeStub();

			// For subagent-audience commands, assertAudience refuses in default "orchestrator" context.
			// To test the happy-path we need to either:
			// (a) use collate (no audience restriction), or
			// (b) set audience to "any" in the fixture.
			// We use (b) for the non-collate commands to keep the happy-path test orthogonal
			// from the audience-refusal test.
			const happyWorkflow = makeWorkflow(spec.personaName, "any");
			fs.writeFileSync(path.join(proj, ".forge", "workflows", spec.workflowFile), happyWorkflow, "utf8");

			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, "");

			expect(stub.notifications.filter((n) => n.level === "error")).toHaveLength(0);
			expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const [msg, opts] = stub.pi.sendUserMessage.mock.calls[0] as [string, unknown];
			expect(opts).toEqual({ deliverAs: "steer" });
			expect(msg).toContain(spec.expectedHeading);
			expect(msg).toContain("## Dispatch");
			expect(msg).toContain("## Workflow");
		});

		// ── AC7.2: Argv: empty ──────────────────────────────────────────────────

		it("empty argv → kickoff dispatched (no-seed label in message)", async () => {
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent: makeWorkflow(spec.personaName, "any"),
				personaName: spec.personaName,
			});
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, "");

			expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const [msg] = stub.pi.sendUserMessage.mock.calls[0] as [string, unknown];
			expect(msg).toContain("## Input");
		});

		// ── AC7.2: Argv: @<path> ────────────────────────────────────────────────

		it("@<path> argv: kickoff message contains file contents", async () => {
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent: makeWorkflow(spec.personaName, "any"),
				personaName: spec.personaName,
			});
			const seedFile = path.join(proj, "seed.md");
			fs.writeFileSync(seedFile, "task seed content from file", "utf8");
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, "@seed.md");

			expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const [msg] = stub.pi.sendUserMessage.mock.calls[0] as [string, unknown];
			expect(msg).toContain("task seed content from file");
			expect(msg).toContain("seed.md");
		});

		// ── AC7.2: Argv: free-form text ─────────────────────────────────────────

		it("free-form text argv: kickoff message contains the inline text", async () => {
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent: makeWorkflow(spec.personaName, "any"),
				personaName: spec.personaName,
			});
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, `FORGE-S21-T10 ${spec.name} seed`);

			expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const [msg] = stub.pi.sendUserMessage.mock.calls[0] as [string, unknown];
			expect(msg).toContain(`FORGE-S21-T10 ${spec.name} seed`);
		});

		// ── AC7.3: Materialization-marker missing → refusal ─────────────────────

		it("missing Store-Write Verification → notify error + abort (no dispatch)", async () => {
			const broken = makeWorkflow(spec.personaName, "any").replace(
				/Store-Write Verification/g,
				"Store-Write XXX",
			);
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent: broken,
				personaName: spec.personaName,
			});
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, "");

			expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
			expect(
				stub.notifications.some(
					(n) => n.level === "error" && n.msg.includes("Store-Write Verification"),
				),
			).toBe(true);
		});

		// ── AC7.4: Audience behaviour ────────────────────────────────────────────

		if (spec.isSubagentAudience) {
			it(`audience:subagent → standalone invocation succeeds (advisory only)`, async () => {
				// Real audience from workflow frontmatter (not overridden to "any").
				// Post-T10 relaxation: subagent audience is advisory; users may
				// invoke any chain step manually from the orchestrator (CLI) context.
				const proj = scaffoldProject({
					workflowFile: spec.workflowFile,
					workflowContent: makeWorkflow(spec.personaName, "subagent"),
					personaName: spec.personaName,
				});
				const stub = makeStub();
				spec.register(stub.pi, { cwd: proj });
				await stub.invoke(cmdName, "");

				// assertAudience returns true for subagent audience from any caller.
				expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
				expect(stub.notifications.filter((n) => n.level === "error")).toHaveLength(0);
			});
		} else {
			it(`audience:any → standalone invocation succeeds`, async () => {
				const proj = scaffoldProject({
					workflowFile: spec.workflowFile,
					workflowContent: makeWorkflow(spec.personaName, undefined),
					personaName: spec.personaName,
				});
				const stub = makeStub();
				spec.register(stub.pi, { cwd: proj });
				await stub.invoke(cmdName, "");

				expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
				expect(stub.notifications.filter((n) => n.level === "error")).toHaveLength(0);
			});
		}

		// ── Registration sanity ──────────────────────────────────────────────────

		it(`registers with correct name ${cmdName} and non-empty description`, () => {
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent: makeWorkflow(spec.personaName, audience),
				personaName: spec.personaName,
			});
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			const cmd = stub.registered.find((r) => r.name === cmdName);
			expect(cmd).toBeDefined();
			expect(cmd!.description.length).toBeGreaterThan(10);
		});

		// ── Missing workflow file ────────────────────────────────────────────────

		it("missing workflow file → notify error + abort", async () => {
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				personaName: spec.personaName,
				omitWorkflow: true,
			});
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, "");

			expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
			expect(
				stub.notifications.some(
					(n) => n.level === "error" && n.msg.includes("workflow not found"),
				),
			).toBe(true);
		});

		// ── @<missing> argv → error ──────────────────────────────────────────────

		it("@<missing> argv → notify error + abort, no dispatch", async () => {
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent: makeWorkflow(spec.personaName, "any"),
				personaName: spec.personaName,
			});
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, "@/no/such/file/exists.md");

			expect(stub.pi.sendUserMessage).not.toHaveBeenCalled();
			expect(
				stub.notifications.some((n) => n.level === "error" && n.msg.includes("failed to read seed")),
			).toBe(true);
		});

		// ── deliverAs:'steer' enforcement ───────────────────────────────────────

		it("deliverAs:'steer' is always enforced on sendUserMessage", async () => {
			const proj = scaffoldProject({
				workflowFile: spec.workflowFile,
				workflowContent: makeWorkflow(spec.personaName, "any"),
				personaName: spec.personaName,
			});
			const stub = makeStub();
			spec.register(stub.pi, { cwd: proj });
			await stub.invoke(cmdName, "some-task-id");

			expect(stub.pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const [, opts] = stub.pi.sendUserMessage.mock.calls[0] as [unknown, unknown];
			expect(opts).toEqual({ deliverAs: "steer" });
		});
	});
}
