// Unit tests for store-resolver.ts — resolveToCanonicalId
//
// Issue #20: unprefixed task/sprint/bug IDs silently poisoned substitutions.
// These tests verify that resolveToCanonicalId correctly normalizes IDs and
// provides actionable errors when resolution fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock for the module under test ──────────────────────────────────
// We mock our own module so we can control what resolveToCanonicalId returns
// in each test case, exercising the handler wiring rather than the resolver
// internals (those are tested separately via store-query.test.ts).

const { mockResolveToCanonicalId } = vi.hoisted(() => ({
	mockResolveToCanonicalId: vi.fn(),
}));

vi.mock("../../../src/extensions/forgecli/store-resolver.js", () => ({
	resolveToCanonicalId: mockResolveToCanonicalId,
	resolveEntityRef: vi.fn(),
	resolveToolDir: vi.fn(() => "/fake/tools"),
	ENTITY_TYPES: new Set(["task", "sprint", "bug", "feature"]),
	ID_PATTERNS: {},
	isDebug: vi.fn(() => false),
	runStoreCli: vi.fn(),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveToCanonicalId } from "../../../src/extensions/forgecli/store-resolver.js";

function makeCtx() {
	const notifications: { msg: string; level: string }[] = [];
	return {
		ui: {
			notify: vi.fn((msg: string, level: string) => {
				notifications.push({ msg, level });
			}),
			confirm: vi.fn(() => Promise.resolve(true)),
			select: vi.fn(() => Promise.resolve(null)),
			setStatus: vi.fn(),
		},
		hasUI: true,
		notifications,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── Test 1: Exact canonical ID resolves directly ───────────────────────────

describe("resolveToCanonicalId — exact canonical ID", () => {
	it("returns the canonical ID when resolver finds a task", async () => {
		mockResolveToCanonicalId.mockResolvedValue("FORGE-S22-T03");

		const ctx = makeCtx();
		const result = await resolveToCanonicalId(
			"FORGE-S22-T03",
			"/fake/tools",
			"/fake/cwd",
			"task",
			{ ctx, commandLabel: "forge:run-task" },
		);

		expect(result).toBe("FORGE-S22-T03");
	});
});

// ── Test 2: Unprefixed task ID normalizes to canonical form ─────────────────

describe("resolveToCanonicalId — unprefixed ID normalization", () => {
	it("resolves 'S22-T03' to 'FORGE-S22-T03'", async () => {
		mockResolveToCanonicalId.mockResolvedValue("FORGE-S22-T03");

		const ctx = makeCtx();
		const result = await resolveToCanonicalId(
			"S22-T03",
			"/fake/tools",
			"/fake/cwd",
			"task",
			{ ctx, commandLabel: "forge:run-task" },
		);

		expect(result).toBe("FORGE-S22-T03");
	});
});

// ── Test 3: Unknown ID returns null with actionable error ───────────────────

describe("resolveToCanonicalId — unknown ID", () => {
	it("returns null and emits actionable error for completely unknown ID", async () => {
		mockResolveToCanonicalId.mockImplementation(
			async (_arg, _toolDir, _cwd, kind, opts) => {
				opts?.ctx?.ui.notify(
					`× ${opts?.commandLabel ?? `forge:${kind}`} — could not resolve "${_arg}". ` +
					`No matching ${kind} found. Try a canonical ID like <PREFIX>-S<N>-T<N> or use /forge:read for search.`,
					"error",
				);
				return null;
			},
		);

		const ctx = makeCtx();
		const result = await resolveToCanonicalId(
			"xyz-bogus",
			"/fake/tools",
			"/fake/cwd",
			"task",
			{ ctx, commandLabel: "forge:run-task" },
		);

		expect(result).toBeNull();
		const errorNotify = ctx.notifications.find((n) => n.level === "error" && n.msg.includes("could not resolve"));
		expect(errorNotify).toBeDefined();
	});
});

// ── Test 4: @path resolution returns null for canonical ID ──────────────────

describe("resolveToCanonicalId — @path rejection", () => {
	it("returns null and emits error when arg resolves to a directory path", async () => {
		mockResolveToCanonicalId.mockImplementation(
			async (_arg, _toolDir, _cwd, _kind, opts) => {
				opts?.ctx?.ui.notify(
					`× ${opts?.commandLabel ?? "forge"} — "@/engineering/sprints" resolved to a directory path, not a task ID. Provide a canonical task ID instead.`,
					"error",
				);
				return null;
			},
		);

		const ctx = makeCtx();
		const result = await resolveToCanonicalId(
			"@engineering/sprints",
			"/fake/tools",
			"/fake/cwd",
			"task",
			{ ctx, commandLabel: "forge:run-task" },
		);

		expect(result).toBeNull();
		const errorNotify = ctx.notifications.find((n) => n.level === "error" && n.msg.includes("directory path"));
		expect(errorNotify).toBeDefined();
	});
});

// ── Test 5: Sprint ID resolution ────────────────────────────────────────────

describe("resolveToCanonicalId — sprint kind", () => {
	it("resolves 'S22' to 'FORGE-S22'", async () => {
		mockResolveToCanonicalId.mockResolvedValue("FORGE-S22");

		const ctx = makeCtx();
		const result = await resolveToCanonicalId(
			"S22",
			"/fake/tools",
			"/fake/cwd",
			"sprint",
			{ ctx, commandLabel: "forge:run-sprint" },
		);

		expect(result).toBe("FORGE-S22");
	});
});

// ── Test 6: Bug ID resolution ──────────────────────────────────────────────

describe("resolveToCanonicalId — bug kind", () => {
	it("resolves 'BUG-042' to 'FORGE-BUG-042'", async () => {
		mockResolveToCanonicalId.mockResolvedValue("FORGE-BUG-042");

		const ctx = makeCtx();
		const result = await resolveToCanonicalId(
			"BUG-042",
			"/fake/tools",
			"/fake/cwd",
			"bug",
			{ ctx, commandLabel: "forge:fix-bug" },
		);

		expect(result).toBe("FORGE-BUG-042");
	});
});