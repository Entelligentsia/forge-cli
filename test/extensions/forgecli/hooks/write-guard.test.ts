// Unit tests for write-guard.ts — FORGE-S23-T02.
//
// Coverage:
//   matchWriteRegistry:
//     1. .forge/store/tasks/<id>.json → matched (task)
//     2. .forge/store/sprints/<id>.json → matched (sprint)
//     3. .forge/store/events/<b>/_<id>_usage.json → matched (event-sidecar, not event)
//     4. .forge/store/events/<b>/<id>.json → matched (event)
//     5. .forge/store/COLLATION_STATE.json → matched (collation-state)
//     6. .forge/config.json → matched (config) — AC#3
//     7. /tmp/unrelated.json → null (non-Forge path)
//     8. .forge/store/tasks/ (no file name) → null
//
//   checkWriteGuard:
//     9.  Missing required field (taskId absent) → block=true, reason contains violation
//    10.  Wrong type (status is integer, not string) → block=true
//    11.  Invalid enum value (status='garbage') → block=true
//    12.  Valid task payload → block=false
//    13.  Non-Forge path → block=false (no registry match)
//    14.  FORGE_SKIP_WRITE_VALIDATION=1 → block=false (bypass)
//    15.  Valid .forge/config.json payload → block=false — AC#3
//    16.  .forge/config.json missing required 'paths' → block=true — AC#3
//
//   applyPiEdits:
//    17.  Single edit applied correctly
//    18.  Multiple edits applied in sequence
//    19.  oldText not found → fail-open (no error, current content returned)

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We need to test against the real validate.js + schemas, so we use the
// actual forgeRoot from the dev tree (available in the forge-engineering repo).
// In CI / isolated environments, tests are skipped if forgeRoot isn't available.

const FORGE_ROOT = path.resolve(process.cwd(), "../forge/forge");
const SCHEMAS_AVAILABLE = (() => {
	try {
		// Quick check: task schema must exist
		const { existsSync } = require("node:fs");
		return existsSync(path.join(FORGE_ROOT, "schemas", "task.schema.json"));
	} catch {
		return false;
	}
})();

import {
	applyPiEdits,
	checkWriteGuard,
	matchWriteRegistry,
} from "../../../../src/extensions/forgecli/hooks/write-guard.js";

// ── matchWriteRegistry tests ──────────────────────────────────────────────────

describe("matchWriteRegistry", () => {
	it("1. matches .forge/store/tasks/<id>.json as task", () => {
		const result = matchWriteRegistry("/home/user/project/.forge/store/tasks/FORGE-S23-T02.json");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("task");
		expect(result?.schema).toBe("task.schema.json");
	});

	it("2. matches .forge/store/sprints/<id>.json as sprint", () => {
		const result = matchWriteRegistry("/project/.forge/store/sprints/FORGE-S23.json");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("sprint");
	});

	it("3. matches event sidecar (_prefix_usage.json) as event-sidecar, not event", () => {
		const result = matchWriteRegistry(
			"/project/.forge/store/events/FORGE-S23/_20260520T000000Z_FORGE-S23-T02_plan_start_usage.json",
		);
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("event-sidecar");
		expect(result?.schema).toBe("event-sidecar.schema.json");
	});

	it("4. matches .forge/store/events/<b>/<id>.json as event", () => {
		const result = matchWriteRegistry(
			"/project/.forge/store/events/FORGE-S23/20260520T000000Z_FORGE-S23-T02_plan_start.json",
		);
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("event");
	});

	it("5. matches .forge/store/COLLATION_STATE.json as collation-state", () => {
		const result = matchWriteRegistry("/project/.forge/store/COLLATION_STATE.json");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("collation-state");
	});

	it("6. matches .forge/config.json as config (AC#3)", () => {
		const result = matchWriteRegistry("/project/.forge/config.json");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("config");
		expect(result?.schema).toBe("config.schema.json");
	});

	it("7. returns null for non-Forge path", () => {
		expect(matchWriteRegistry("/tmp/unrelated.json")).toBeNull();
	});

	it("8. returns null for directory-only path (no filename)", () => {
		// Pattern requires at least one char after last /
		expect(matchWriteRegistry("/project/.forge/store/tasks/")).toBeNull();
	});
});

// ── applyPiEdits tests ────────────────────────────────────────────────────────

describe("applyPiEdits", () => {
	let tmpFile: string;

	beforeEach(() => {
		const { writeFileSync } = require("node:fs");
		tmpFile = path.join(os.tmpdir(), `write-guard-test-${Date.now()}.txt`);
		writeFileSync(tmpFile, "Hello, world!", "utf8");
	});

	afterEach(() => {
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(tmpFile);
		} catch {
			// ignore
		}
	});

	it("17. applies a single edit correctly", () => {
		const result = applyPiEdits(tmpFile, [{ oldText: "world", newText: "Forge" }]);
		expect(result).toBe("Hello, Forge!");
	});

	it("18. applies multiple edits in sequence", () => {
		const result = applyPiEdits(tmpFile, [
			{ oldText: "Hello", newText: "Hi" },
			{ oldText: "world", newText: "Forge" },
		]);
		expect(result).toBe("Hi, Forge!");
	});

	it("19. fails open when oldText not found (returns current content, no error)", () => {
		// Should not throw; returns original content (world not replaced since notfound is absent)
		const result = applyPiEdits(tmpFile, [{ oldText: "notfound", newText: "REPLACED" }]);
		expect(result).toBe("Hello, world!"); // unchanged
	});
});

// ── checkWriteGuard tests ─────────────────────────────────────────────────────

describe("checkWriteGuard", () => {
	const validTask = JSON.stringify({
		taskId: "FORGE-S23-T02",
		sprintId: "FORGE-S23",
		title: "Port validate-write hook",
		status: "draft",
		path: "engineering/sprints/FORGE-S23/FORGE-S23-T02/TASK_PROMPT.md",
	});

	const validConfig = JSON.stringify({
		version: "1.0",
		project: { prefix: "FORGE", name: "Forge" },
		paths: { engineering: "engineering", store: ".forge/store", forgeRoot: "/path/to/forge/forge" },
	});

	it("9. blocks write with missing required field (taskId absent)", () => {
		if (!SCHEMAS_AVAILABLE) return; // skip in isolated CI
		const contents = JSON.stringify({
			// taskId missing
			sprintId: "FORGE-S23",
			title: "Test",
			status: "draft",
			path: "foo",
		});
		const result = checkWriteGuard("/project/.forge/store/tasks/T01.json", contents, FORGE_ROOT);
		expect(result.block).toBe(true);
		expect(result.reason).toContain("taskId");
	});

	it("10. blocks write with wrong type (status is integer, not string)", () => {
		if (!SCHEMAS_AVAILABLE) return;
		const contents = JSON.stringify({
			taskId: "FORGE-S23-T02",
			sprintId: "FORGE-S23",
			title: "Test",
			status: 42, // wrong type
			path: "foo",
		});
		const result = checkWriteGuard("/project/.forge/store/tasks/T02.json", contents, FORGE_ROOT);
		expect(result.block).toBe(true);
		expect(result.reason).toContain("status");
	});

	it("11. blocks write with invalid enum value (status='garbage')", () => {
		if (!SCHEMAS_AVAILABLE) return;
		const contents = JSON.stringify({
			taskId: "FORGE-S23-T02",
			sprintId: "FORGE-S23",
			title: "Test",
			status: "garbage", // not in enum
			path: "foo",
		});
		const result = checkWriteGuard("/project/.forge/store/tasks/T03.json", contents, FORGE_ROOT);
		expect(result.block).toBe(true);
		expect(result.reason).toContain("status");
	});

	it("12. allows valid task payload", () => {
		if (!SCHEMAS_AVAILABLE) return;
		const result = checkWriteGuard("/project/.forge/store/tasks/T04.json", validTask, FORGE_ROOT);
		expect(result.block).toBe(false);
	});

	it("13. allows non-Forge path (no registry match)", () => {
		const result = checkWriteGuard("/tmp/unrelated.json", '{"any":"thing"}', FORGE_ROOT);
		expect(result.block).toBe(false);
	});

	it("14. FORGE_SKIP_WRITE_VALIDATION=1 bypasses validation", () => {
		const orig = process.env.FORGE_SKIP_WRITE_VALIDATION;
		process.env.FORGE_SKIP_WRITE_VALIDATION = "1";
		try {
			// Would normally block (missing required fields)
			const result = checkWriteGuard("/project/.forge/store/tasks/T05.json", '{"bad":"payload"}', FORGE_ROOT);
			expect(result.block).toBe(false);
		} finally {
			if (orig === undefined) {
				delete process.env.FORGE_SKIP_WRITE_VALIDATION;
			} else {
				process.env.FORGE_SKIP_WRITE_VALIDATION = orig;
			}
		}
	});

	it("15. allows valid .forge/config.json payload (AC#3)", () => {
		if (!SCHEMAS_AVAILABLE) return;
		const result = checkWriteGuard("/project/.forge/config.json", validConfig, FORGE_ROOT);
		expect(result.block).toBe(false);
	});

	it("16. blocks .forge/config.json write missing required 'paths' (AC#3)", () => {
		if (!SCHEMAS_AVAILABLE) return;
		const contents = JSON.stringify({
			version: "1.0",
			project: { prefix: "FORGE", name: "Forge" },
			// paths missing
		});
		const result = checkWriteGuard("/project/.forge/config.json", contents, FORGE_ROOT);
		expect(result.block).toBe(true);
		expect(result.reason).toContain("paths");
	});
});
