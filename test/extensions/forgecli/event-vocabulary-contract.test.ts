// event-vocabulary-contract.test.ts — forge-engineering#39
//
// Contract: every event `type` token that forge-cli STORE-emits (via
// store-cli emit) must be a member of the vendored plugin schema enum
// (dist/forge-payload/schemas/event.schema.json, mirror of the canonical
// _fragments/event-vocabulary.md tables).
//
// This is the recurrence guard for the drift class that shipped
// `fix-revision-requested` / `bug-commit-failed` (invented in forge-cli
// e625374, rejected by the schema, events + token telemetry silently
// dropped — observed live on testbench CART-BUG-001).
//
// Scope: STORE-emitted tokens only. Synthetic in-process hook events
// (emitSyntheticEvent — init-complete, sprint-collate-complete,
// migration-applied) never reach store-cli and are excluded.
//
// Requires dist/forge-payload to be built (scripts/build-payload.cjs) —
// CI's tests.yml builds the payload from the forge clone pinned at
// package.json forge.bundledVersion before running vitest.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "../../..");
const schemaPath = path.join(repoRoot, "dist", "forge-payload", "schemas", "event.schema.json");
const orchestratorsDir = path.join(repoRoot, "src", "extensions", "forgecli", "orchestrators");

// Synthetic in-process hook event types (hook-dispatcher.ts) — never store-emitted.
const SYNTHETIC_TYPES = new Set(["init-complete", "sprint-collate-complete", "migration-applied"]);

function loadEnum(): Set<string> {
	const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
		properties?: { type?: { enum?: string[] } };
	};
	const tokens = schema.properties?.type?.enum;
	expect(Array.isArray(tokens), "vendored event.schema.json must declare properties.type.enum").toBe(true);
	return new Set(tokens as string[]);
}

function literalTypeTokens(source: string): string[] {
	// Matches object-literal `type: "token"` assignments (store event payloads).
	const out: string[] = [];
	for (const m of source.matchAll(/\btype:\s*"([a-z][a-z0-9_-]*)"/g)) {
		const tok = m[1];
		if (tok !== undefined && !SYNTHETIC_TYPES.has(tok)) out.push(tok);
	}
	return out;
}

describe("event vocabulary contract — emitted tokens ⊆ vendored schema enum (forge-engineering#39)", () => {
	it("vendored schema enum exists and carries the bug-pipeline fail tokens (plugin >= 1.2.18)", () => {
		const enumSet = loadEnum();
		// Sentinels for a stale payload: these landed in forge v1.2.18. If this
		// fails, re-vendor (scripts/build-payload.cjs) and/or bump
		// package.json forge.bundledVersion.
		for (const tok of ["fix-revision-requested", "bug-commit-failed", "bug-skipped"]) {
			expect(enumSet.has(tok), `vendored enum missing "${tok}" — payload predates forge v1.2.18`).toBe(true);
		}
		// Retired in v1.2.18 (defined, emitted by nothing).
		expect(enumSet.has("bug-fixed"), 'vendored enum still carries retired token "bug-fixed"').toBe(false);
	});

	it("every BUG_TYPE_TOKENS pass/fail token is in the schema enum", () => {
		const enumSet = loadEnum();
		const src = fs.readFileSync(path.join(orchestratorsDir, "fix-bug.ts"), "utf8");
		// Extract the BUG_TYPE_TOKENS literal block.
		const blockStart = src.indexOf("export const BUG_TYPE_TOKENS");
		expect(blockStart, "BUG_TYPE_TOKENS not found in fix-bug.ts").toBeGreaterThan(-1);
		const block = src.slice(blockStart, src.indexOf("};", blockStart));
		const tokens = [...block.matchAll(/(?:pass|fail):\s*"([a-z-]+)"/g)].map((m) => m[1]);
		expect(tokens.length, "expected pass/fail tokens inside BUG_TYPE_TOKENS").toBeGreaterThanOrEqual(14);
		for (const tok of tokens) {
			expect(enumSet.has(tok as string), `BUG_TYPE_TOKENS emits "${tok}" — not in vendored schema enum`).toBe(true);
		}
	});

	it("every literal store-emitted type token in the orchestrators is in the schema enum", () => {
		const enumSet = loadEnum();
		for (const file of ["run-task.ts", "run-sprint.ts", "fix-bug.ts"]) {
			const src = fs.readFileSync(path.join(orchestratorsDir, file), "utf8");
			for (const tok of literalTypeTokens(src)) {
				expect(enumSet.has(tok), `${file} emits type "${tok}" — not in vendored schema enum`).toBe(true);
			}
		}
	});

	it("skill-curation emitters use schema-valid tokens (friction, skill_usage)", () => {
		const enumSet = loadEnum();
		const dir = path.join(repoRoot, "src", "extensions", "forgecli", "skill-curation");
		for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
			const src = fs.readFileSync(path.join(dir, file), "utf8");
			for (const tok of literalTypeTokens(src)) {
				expect(enumSet.has(tok), `skill-curation/${file} emits type "${tok}" — not in vendored schema enum`).toBe(
					true,
				);
			}
		}
	});

	it("run-sprint emits the sprint-grain lifecycle tokens sprint-start and task-dispatch (#39 step 3)", () => {
		const src = fs.readFileSync(path.join(orchestratorsDir, "run-sprint.ts"), "utf8");
		expect(src.includes('type: "sprint-start"'), "run-sprint.ts must store-emit sprint-start before the task loop").toBe(
			true,
		);
		expect(
			src.includes('type: "task-dispatch"'),
			"run-sprint.ts must store-emit task-dispatch before each task dispatch",
		).toBe(true);
	});
});
