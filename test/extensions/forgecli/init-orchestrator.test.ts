// init-orchestrator.test.ts — shape + constant integrity tests for the
// /forge:init orchestrator scaffolding (FORGE-S33-T01).
//
// These tests are intentionally assertion-heavy rather than logic-heavy:
// the module under test is pure data declarations. A failing assertion here
// signals either an unintentional edit to a constant or a divergence from the
// meta source (wfl-init.js). No subagents are invoked.

import { describe, expect, it } from "vitest";

import {
	DOMAINS,
	KB_DOC_IDS,
	ROLE_TIER,
} from "../../../src/extensions/forgecli/orchestrators/init/init-phases.js";

import {
	DISCOVERY_SCHEMA,
	KB_DOC_SCHEMA,
	OK_SCHEMA,
	PHASE_RESULT_SCHEMA,
} from "../../../src/extensions/forgecli/orchestrators/init/run-init-types.js";

// ── DOMAINS constant ──────────────────────────────────────────────────────────

describe("DOMAINS", () => {
	it("has exactly 5 entries", () => {
		expect(DOMAINS).toHaveLength(5);
	});

	it("matches meta verbatim (wfl-init.js line ~159)", () => {
		expect(Array.from(DOMAINS)).toEqual([
			"stack",
			"routing",
			"processes",
			"database",
			"testing",
		]);
	});
});

// ── KB_DOC_IDS constant ───────────────────────────────────────────────────────

describe("KB_DOC_IDS", () => {
	it("has exactly 10 entries (shared 10-doc contract, FORGE-S35-T01)", () => {
		expect(KB_DOC_IDS).toHaveLength(10);
	});

	it("matches the shared 10-doc contract verbatim (wfl-init.js + verify-phase.cjs)", () => {
		expect(Array.from(KB_DOC_IDS)).toEqual([
			"architecture/stack",
			"architecture/processes",
			"architecture/routing",
			"architecture/database",
			"architecture/testing",
			"architecture/deployment",
			"architecture/entity-model",
			"architecture/stack-checklist",
			"business-domain/domain-model",
			"business-domain/domain-concepts",
		]);
	});
});

// ── ROLE_TIER constant ────────────────────────────────────────────────────────

describe("ROLE_TIER", () => {
	it("has exactly 7 keys (the Phase-2 'gate' role was deleted in Slice 1)", () => {
		expect(Object.keys(ROLE_TIER)).toHaveLength(7);
	});

	it("has no 'gate' key (gate subagent deleted; readiness is now a step precondition)", () => {
		expect(ROLE_TIER["gate"]).toBeUndefined();
	});

	it("LLM-generation roles map to 'sonnet'", () => {
		expect(ROLE_TIER["discovery"]).toBe("sonnet");
		expect(ROLE_TIER["config"]).toBe("sonnet");
		expect(ROLE_TIER["kb-doc"]).toBe("sonnet");
		expect(ROLE_TIER["index"]).toBe("sonnet");
		expect(ROLE_TIER["context"]).toBe("sonnet");
	});

	it("deterministic roles map to 'haiku'", () => {
		expect(ROLE_TIER["materialize"]).toBe("haiku");
		expect(ROLE_TIER["register"]).toBe("haiku");
	});
});

// ── Schema shape integrity ────────────────────────────────────────────────────
//
// Tests check structural integrity (non-null, has expected top-level keys)
// without deep-equality coupling to the meta source. Deep equality would make
// the test brittle to description-string tweaks in the meta.

describe("DISCOVERY_SCHEMA", () => {
	it("is a non-null object", () => {
		expect(DISCOVERY_SCHEMA).toBeTruthy();
		expect(typeof DISCOVERY_SCHEMA).toBe("object");
	});

	it("has type 'object'", () => {
		expect((DISCOVERY_SCHEMA as { type: string }).type).toBe("object");
	});

	it("has required array including 'domain', 'findings', 'confidence'", () => {
		const req = (DISCOVERY_SCHEMA as { required: string[] }).required;
		expect(req).toContain("domain");
		expect(req).toContain("findings");
		expect(req).toContain("confidence");
	});

	it("has properties key", () => {
		expect((DISCOVERY_SCHEMA as { properties: object }).properties).toBeTruthy();
	});
});

describe("KB_DOC_SCHEMA", () => {
	it("is a non-null object", () => {
		expect(KB_DOC_SCHEMA).toBeTruthy();
		expect(typeof KB_DOC_SCHEMA).toBe("object");
	});

	it("has type 'object'", () => {
		expect((KB_DOC_SCHEMA as { type: string }).type).toBe("object");
	});

	it("has required array including 'id', 'ok', 'confidence'", () => {
		const req = (KB_DOC_SCHEMA as { required: string[] }).required;
		expect(req).toContain("id");
		expect(req).toContain("ok");
		expect(req).toContain("confidence");
	});

	it("has properties key", () => {
		expect((KB_DOC_SCHEMA as { properties: object }).properties).toBeTruthy();
	});
});

describe("PHASE_RESULT_SCHEMA", () => {
	it("is a non-null object", () => {
		expect(PHASE_RESULT_SCHEMA).toBeTruthy();
		expect(typeof PHASE_RESULT_SCHEMA).toBe("object");
	});

	it("has type 'object'", () => {
		expect((PHASE_RESULT_SCHEMA as { type: string }).type).toBe("object");
	});

	it("has required array including 'verifyExit' and 'ok'", () => {
		const req = (PHASE_RESULT_SCHEMA as { required: string[] }).required;
		expect(req).toContain("verifyExit");
		expect(req).toContain("ok");
	});

	it("has properties key", () => {
		expect((PHASE_RESULT_SCHEMA as { properties: object }).properties).toBeTruthy();
	});
});

describe("OK_SCHEMA", () => {
	it("is a non-null object", () => {
		expect(OK_SCHEMA).toBeTruthy();
		expect(typeof OK_SCHEMA).toBe("object");
	});

	it("has type 'object'", () => {
		expect((OK_SCHEMA as { type: string }).type).toBe("object");
	});

	it("has required array including 'ok'", () => {
		const req = (OK_SCHEMA as { required: string[] }).required;
		expect(req).toContain("ok");
	});

	it("has properties key", () => {
		expect((OK_SCHEMA as { properties: object }).properties).toBeTruthy();
	});
});
