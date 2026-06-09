// Unit tests for store-resolver.ts — the REAL resolution cascade.
//
// Unlike store-resolver.test.ts (which mocks the whole module to test handler
// wiring), this file mocks only the `execFileAsync` boundary and drives the
// genuine `resolveEntityRef` / `resolveToCanonicalId` logic against an
// in-memory store.
//
// Regression cover for the run-task locate semantics bug (CART-S01):
//   - `S01`   (sprint fragment, kind=task) must NOT resolve to the sprint and
//     run it as a task — it must expand the sprint into its tasks and pick.
//   - `S01-T01` (unprefixed canonical task) must normalize to `CART-S01-T01`
//     instead of erroring on the fully-qualified-ID guard.
//   - `S01` (kind=sprint) must still resolve to the sprint (no regression).

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFileAsync } = vi.hoisted(() => ({ mockExecFileAsync: vi.fn() }));

vi.mock("../../../src/extensions/forgecli/lib/exec-helpers.js", () => ({
	execFileAsync: mockExecFileAsync,
}));

import { resolveToCanonicalId } from "../../../src/extensions/forgecli/store/store-resolver.js";

// ── In-memory store + store-cli emulation ───────────────────────────────────

interface Task {
	id: string;
	sprintId: string;
	title: string;
	status?: string;
}
interface Sprint {
	id: string;
	title: string;
}

function makeHandler(sprints: Sprint[], tasks: Task[]) {
	const taskRec = (t: Task) => ({
		id: t.id,
		type: "task",
		title: t.title,
		status: t.status ?? "planned",
		relationships: { sprintId: t.sprintId },
	});
	const sprintRec = (s: Sprint) => ({ id: s.id, type: "sprint", title: s.title });

	return (argv: string[]): string => {
		const [cmd, sub, a] = argv;
		if (cmd === "query") {
			if (sub === "--task") {
				const v = String(a).toUpperCase();
				return JSON.stringify({ results: tasks.filter((t) => t.id.toUpperCase() === v).map(taskRec) });
			}
			if (sub === "--sprint") {
				const v = String(a).toUpperCase();
				return JSON.stringify({ results: sprints.filter((s) => s.id.toUpperCase() === v).map(sprintRec) });
			}
			if (sub === "--task-suffix") {
				const suf = String(a).toUpperCase();
				return JSON.stringify({
					path: "suffix",
					results: tasks
						.filter((t) => {
							const id = t.id.toUpperCase();
							return id === suf || id.endsWith(`-${suf}`);
						})
						.map(taskRec),
				});
			}
			if (sub === "--sprint-suffix") {
				const suf = String(a).toUpperCase();
				return JSON.stringify({
					path: "suffix",
					results: sprints
						.filter((s) => {
							const id = s.id.toUpperCase();
							return id === suf || id.endsWith(`-${suf}`);
						})
						.map(sprintRec),
				});
			}
			if (sub === "--list-sprints") return JSON.stringify({ results: sprints.map(sprintRec) });
			if (sub === "--keyword") return JSON.stringify({ results: [] });
		}
		if (cmd === "list" && sub === "task") {
			const m = String(a).match(/^sprintId=(.+)$/);
			const sid = m?.[1];
			return JSON.stringify(
				tasks
					.filter((t) => t.sprintId === sid)
					.map((t) => ({ taskId: t.id, sprintId: t.sprintId, title: t.title, status: t.status ?? "planned" })),
			);
		}
		if (cmd === "nlp") return JSON.stringify({ results: [] });
		return JSON.stringify({ results: [] });
	};
}

function install(sprints: Sprint[], tasks: Task[]) {
	const handler = makeHandler(sprints, tasks);
	mockExecFileAsync.mockImplementation(async (_node: string, argvFull: string[]) => ({
		stdout: handler(argvFull.slice(1)),
		stderr: "",
	}));
}

type TestCtx = ExtensionCommandContext & {
	notifications: { msg: string; level: string }[];
	select: ReturnType<typeof vi.fn>;
};

function makeCtx(selectReturn?: (options: string[]) => string | null): TestCtx {
	const notifications: { msg: string; level: string }[] = [];
	const select = vi.fn((_prompt: string, options: string[]) =>
		Promise.resolve(selectReturn ? selectReturn(options) : null),
	);
	return {
		ui: {
			notify: vi.fn((msg: string, level: string) => {
				notifications.push({ msg, level });
			}),
			confirm: vi.fn(() => Promise.resolve(true)),
			select,
			setStatus: vi.fn(),
		},
		hasUI: true,
		notifications,
		select,
	} as unknown as TestCtx;
}

const SPRINTS: Sprint[] = [
	{ id: "CART-S01", title: "First sprint" },
	{ id: "CART-S02", title: "Second sprint" },
	{ id: "CART-S03", title: "Solo sprint" },
];
const TASKS: Task[] = [
	{ id: "CART-S01-T01", sprintId: "CART-S01", title: "Task one" },
	{ id: "CART-S01-T02", sprintId: "CART-S01", title: "Task two" },
	{ id: "CART-S02-T01", sprintId: "CART-S02", title: "Other task one" },
	{ id: "CART-S03-T01", sprintId: "CART-S03", title: "Lonely task" },
];

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.FORGE_YES;
	delete process.env.FORGE_NON_INTERACTIVE;
});
afterEach(() => {
	vi.restoreAllMocks();
});

// ── Bug: `S01-T01` (unprefixed canonical task) must normalize ────────────────

describe("resolveToCanonicalId — unprefixed canonical task", () => {
	it("resolves 'S01-T01' to 'CART-S01-T01' instead of erroring", async () => {
		install(SPRINTS, TASKS);
		const ctx = makeCtx();
		const result = await resolveToCanonicalId("S01-T01", "/tools", "/cwd", "task", {
			ctx,
			commandLabel: "forge:run-task",
		});
		expect(result).toBe("CART-S01-T01");
	});
});

// ── Bug: `S01` (sprint fragment) must NOT run as a task ──────────────────────

describe("resolveToCanonicalId — sprint fragment with kind=task", () => {
	it("never returns the sprint id when a task was requested", async () => {
		install(SPRINTS, TASKS);
		// Pick the second task so we also prove the picker selection is honored.
		const ctx = makeCtx((options) => options.find((o) => o.includes("CART-S01-T02")) ?? null);
		const result = await resolveToCanonicalId("S01", "/tools", "/cwd", "task", {
			ctx,
			commandLabel: "forge:run-task",
		});
		expect(result).not.toBe("CART-S01");
		expect(result).toBe("CART-S01-T02");
	});

	it("surfaces a task picker (ctx.ui.select) for a multi-task sprint", async () => {
		install(SPRINTS, TASKS);
		const ctx = makeCtx((options) => options[0]);
		const result = await resolveToCanonicalId("S01", "/tools", "/cwd", "task", {
			ctx,
			commandLabel: "forge:run-task",
		});
		expect(ctx.select).toHaveBeenCalledTimes(1);
		const [, options] = ctx.select.mock.calls[0];
		expect(options.every((o: string) => /CART-S01-T0\d \(task\)/.test(o))).toBe(true);
		expect(result).toBe("CART-S01-T01");
	});

	it("resolves directly without a picker when the sprint has a single task", async () => {
		install(SPRINTS, TASKS);
		const ctx = makeCtx();
		const result = await resolveToCanonicalId("S03", "/tools", "/cwd", "task", {
			ctx,
			commandLabel: "forge:run-task",
		});
		expect(ctx.select).not.toHaveBeenCalled();
		expect(result).toBe("CART-S03-T01");
	});

	it("expands a fully-qualified sprint id (CART-S01) to its tasks", async () => {
		install(SPRINTS, TASKS);
		const ctx = makeCtx((options) => options[0]);
		const result = await resolveToCanonicalId("CART-S01", "/tools", "/cwd", "task", {
			ctx,
			commandLabel: "forge:run-task",
		});
		expect(result).toBe("CART-S01-T01");
		expect(result).not.toBe("CART-S01");
	});
});

// ── Regression: sprint kind still resolves to the sprint ─────────────────────

describe("resolveToCanonicalId — sprint kind (regression)", () => {
	it("resolves 'S01' to 'CART-S01' when a sprint is requested", async () => {
		install(SPRINTS, TASKS);
		const ctx = makeCtx();
		const result = await resolveToCanonicalId("S01", "/tools", "/cwd", "sprint", {
			ctx,
			commandLabel: "forge:run-sprint",
		});
		expect(result).toBe("CART-S01");
	});
});

// ── Regression: fully-qualified task + unknown id ────────────────────────────

describe("resolveToCanonicalId — fully-qualified ids (regression)", () => {
	it("resolves a fully-qualified task id directly", async () => {
		install(SPRINTS, TASKS);
		const ctx = makeCtx();
		const result = await resolveToCanonicalId("CART-S02-T01", "/tools", "/cwd", "task", {
			ctx,
			commandLabel: "forge:run-task",
		});
		expect(result).toBe("CART-S02-T01");
	});

	it("returns null for an unknown fully-qualified task id", async () => {
		install(SPRINTS, TASKS);
		const ctx = makeCtx();
		const result = await resolveToCanonicalId("CART-S99-T99", "/tools", "/cwd", "task", {
			ctx,
			commandLabel: "forge:run-task",
		});
		expect(result).toBeNull();
	});
});
