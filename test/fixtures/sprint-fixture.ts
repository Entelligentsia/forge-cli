// test/fixtures/sprint-fixture.ts — disposable real-store fixture for sprint tests.
//
// Builds a writable .forge/ tree in tmpdir with real personas, workflows, schemas,
// and store records (pre-populated via real `store-cli.cjs write`). Tests use this
// fixture together with the streamFn helpers (helpers/scripted-subagent.ts) to
// exercise the orchestrator end-to-end against real schema validation and real
// event emission — without mocking spawnSync / store-cli / forge-subagent.
//
// Discovery: the test must point `forgeRoot` at this fixture's bundled forge
// payload (which symlinks back to the real forge/forge/ tools + schemas in the
// outer monorepo). Tests pass `cwd: fixture.projDir` to `registerRunSprint`.
//
// See forge-cli#17.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Resolve real forge payload (forge/forge/ in the outer monorepo) ──────

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// forge-cli/test/fixtures/sprint-fixture.ts → forge-cli/../forge/forge/
const REAL_FORGE_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "forge", "forge");

// Pre-flight: verify the real forge payload exists; tests that depend on this
// fixture cannot run if the outer-monorepo forge clone is missing.
export function realForgeRoot(): string {
	const storeCli = path.join(REAL_FORGE_ROOT, "tools", "store-cli.cjs");
	if (!fs.existsSync(storeCli)) {
		throw new Error(
			`buildSprintFixture: real forge tools not found at ${storeCli}. ` +
				`This fixture requires the forge/ clone in the outer monorepo (CLAUDE.md §Four-Repo Layout).`,
		);
	}
	return REAL_FORGE_ROOT;
}

// ── Templates ────────────────────────────────────────────────────────────

// Workflow markdown with all materialization markers checkMaterialization() looks for.
const ORCHESTRATOR_WORKFLOW_MD = [
	"---",
	"deps:",
	"  personas: [engineer]",
	"audience: orchestrator-only",
	"---",
	"",
	"# Workflow",
	"",
	"## Iron Laws",
	"",
	"See .forge/personas/engineer.md.",
	"",
	"## Store-Write Verification",
	"",
	"After every write, verify via forge_store.",
	"",
	"## Algorithm",
	"",
	"1. Run forge_store_query to load context.",
].join("\n");

const SUBAGENT_WORKFLOW_MD = [
	"---",
	"deps:",
	"  personas: [engineer]",
	"audience: subagent",
	"---",
	"",
	"# Workflow",
	"",
	"## Iron Laws",
	"",
	"See .forge/personas/engineer.md.",
	"",
	"## Store-Write Verification",
	"",
	"After every write, verify via forge_store.",
	"",
	"## Algorithm",
	"",
	"1. Run forge_store_query to load context.",
].join("\n");

const SUB_WORKFLOW_NAMES = [
	"plan_task",
	"review_plan",
	"implement_plan",
	"review_code",
	"validate_task",
	"architect_approve",
	"architect_review_sprint_completion",
	"collator_agent",
	"commit_task",
];

const PERSONA_NAMES = ["engineer", "supervisor", "qa-engineer", "architect", "collator"];

// ── Public API ───────────────────────────────────────────────────────────

export interface FixtureTaskSpec {
	id: string;
	/** Default "plan-approved". Use "committed" to mark task as already done. */
	status?: string;
	title?: string;
}

export interface SprintFixtureOptions {
	/** Optional parent tmp dir; defaults to mkdtempSync in os.tmpdir(). */
	tmpRoot?: string;
	sprintId: string;
	tasks: FixtureTaskSpec[];
	/** Default "active". Use "completed" / "partially-completed" to drive ceremony verdict. */
	sprintStatus?: string;
	sprintTitle?: string;
}

export interface SprintFixture {
	/** Project directory (the test cwd). */
	projDir: string;
	/** Forge root containing tools/, schemas/. Real forge payload. */
	forgeRoot: string;
	/** Absolute path to store-cli.cjs (real). */
	storeCli: string;
	/** Absolute path to event.schema.json (real). */
	eventSchemaPath: string;
	sprintId: string;
	taskIds: string[];
	/** Update sprint status via real store-cli (used to drive ceremony verdict). */
	updateSprintStatus(status: string): void;
	/** Read the latest sprint-* event written to .forge/store/events/<sprintId>/. */
	readEmittedEvents(): Array<Record<string, unknown>>;
	/** Recursive remove of projDir. */
	cleanup(): void;
}

export function buildSprintFixture(opts: SprintFixtureOptions): SprintFixture {
	const forgeRoot = realForgeRoot();
	const tmpRoot = opts.tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "forge-sprint-fixture-"));
	const projDir = path.join(tmpRoot, "proj");

	// ── Build .forge/ tree ─────────────────────────────────────────────
	fs.mkdirSync(path.join(projDir, ".forge", "workflows"), { recursive: true });
	fs.mkdirSync(path.join(projDir, ".forge", "personas"), { recursive: true });
	fs.mkdirSync(path.join(projDir, ".forge", "cache"), { recursive: true });
	fs.mkdirSync(path.join(projDir, ".forge", "store"), { recursive: true });
	fs.mkdirSync(path.join(projDir, ".forge", "schemas"), { recursive: true });

	// Symlink real schemas into the project (for store-cli's project-first lookup).
	const realSchemasDir = path.join(forgeRoot, "schemas");
	for (const entry of fs.readdirSync(realSchemasDir)) {
		const src = path.join(realSchemasDir, entry);
		const dst = path.join(projDir, ".forge", "schemas", entry);
		try {
			fs.symlinkSync(src, dst);
		} catch {
			// Fallback: copy if symlink unsupported (e.g., Windows without admin).
			const stat = fs.statSync(src);
			if (stat.isFile()) fs.copyFileSync(src, dst);
		}
	}

	// .forge/config.json — points forgeRoot at the real outer forge payload.
	fs.writeFileSync(
		path.join(projDir, ".forge", "config.json"),
		JSON.stringify({ paths: { forgeRoot, store: ".forge/store" } }, null, 2),
		"utf8",
	);

	// .forge/workflows/run_sprint.md (orchestrator-only audience)
	fs.writeFileSync(path.join(projDir, ".forge", "workflows", "run_sprint.md"), ORCHESTRATOR_WORKFLOW_MD, "utf8");

	// All sub-workflows (subagent audience, with materialization markers)
	for (const w of SUB_WORKFLOW_NAMES) {
		fs.writeFileSync(path.join(projDir, ".forge", "workflows", `${w}.md`), SUBAGENT_WORKFLOW_MD, "utf8");
	}

	// Persona files (minimal frontmatter)
	for (const p of PERSONA_NAMES) {
		fs.writeFileSync(
			path.join(projDir, ".forge", "personas", `${p}.md`),
			`---\nname: ${p}\ndescription: Forge ${p} persona\n---\n\nYou are the ${p}. See .forge/personas/${p}.md.`,
			"utf8",
		);
	}

	const storeCli = path.join(forgeRoot, "tools", "store-cli.cjs");
	const eventSchemaPath = path.join(realSchemasDir, "event.schema.json");

	// ── Write sprint + task records via real store-cli ─────────────────
	const taskIds = opts.tasks.map((t) => t.id);
	const sprintRecord = {
		sprintId: opts.sprintId,
		title: opts.sprintTitle ?? `Test sprint ${opts.sprintId}`,
		status: opts.sprintStatus ?? "active",
		taskIds,
		createdAt: new Date().toISOString(),
	};
	storeWrite(storeCli, projDir, "sprint", sprintRecord);

	for (const t of opts.tasks) {
		const taskRecord = {
			taskId: t.id,
			sprintId: opts.sprintId,
			title: t.title ?? `Task ${t.id}`,
			status: t.status ?? "plan-approved",
			path: `engineering/sprints/${opts.sprintId}/${t.id}`,
		};
		storeWrite(storeCli, projDir, "task", taskRecord);
	}

	function readEmittedEvents(): Array<Record<string, unknown>> {
		const eventsDir = path.join(projDir, ".forge", "store", "events", opts.sprintId);
		if (!fs.existsSync(eventsDir)) return [];
		const out: Array<Record<string, unknown>> = [];
		for (const entry of fs.readdirSync(eventsDir)) {
			if (!entry.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(fs.readFileSync(path.join(eventsDir, entry), "utf8")));
			} catch {
				// skip malformed
			}
		}
		return out;
	}

	function updateSprintStatus(status: string): void {
		const r = spawnSync("node", [storeCli, "update-status", "sprint", opts.sprintId, "status", status], {
			cwd: projDir,
			encoding: "utf8",
		});
		if (r.status !== 0) {
			throw new Error(`store-cli update-status failed: ${r.stderr}`);
		}
	}

	return {
		projDir,
		forgeRoot,
		storeCli,
		eventSchemaPath,
		sprintId: opts.sprintId,
		taskIds,
		updateSprintStatus,
		readEmittedEvents,
		cleanup() {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		},
	};
}

// ── Internals ────────────────────────────────────────────────────────────

function storeWrite(storeCli: string, cwd: string, entity: string, data: Record<string, unknown>): void {
	const r = spawnSync("node", [storeCli, "write", entity, JSON.stringify(data)], {
		cwd,
		encoding: "utf8",
	});
	if (r.status !== 0) {
		throw new Error(
			`store-cli write ${entity} failed (status=${r.status}): ${r.stderr || r.stdout || "no output"}`,
		);
	}
}
