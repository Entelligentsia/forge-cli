// init-orchestrator.test.ts — shape + constant integrity tests for the
// /forge:init orchestrator scaffolding (FORGE-S33-T01).
//
// These tests are intentionally assertion-heavy rather than logic-heavy:
// the module under test is pure data declarations. A failing assertion here
// signals either an unintentional edit to a constant or a divergence from the
// meta source (wfl-init.js). No subagents are invoked.

import { describe, expect, it } from "vitest";

import {
	INIT_PHASES,
	DOMAINS,
	KB_DOC_IDS,
	ROLE_TIER,
	initPhaseByName,
	initPhaseIndexByName,
} from "../../../src/extensions/forgecli/orchestrators/init/init-phases.js";

import {
	DISCOVERY_SCHEMA,
	KB_DOC_SCHEMA,
	OK_SCHEMA,
	PHASE_RESULT_SCHEMA,
} from "../../../src/extensions/forgecli/orchestrators/init/run-init-types.js";

// ── INIT_PHASES table ─────────────────────────────────────────────────────────

describe("INIT_PHASES", () => {
	it("has exactly 4 entries", () => {
		expect(INIT_PHASES).toHaveLength(4);
	});

	it('phase[0] is "collect" with kind subagent_fanout', () => {
		expect(INIT_PHASES[0].name).toBe("collect");
		expect(INIT_PHASES[0].kind).toBe("subagent_fanout");
	});

	it('phase[1] is "discover" with kind subagent_fanout', () => {
		expect(INIT_PHASES[1].name).toBe("discover");
		expect(INIT_PHASES[1].kind).toBe("subagent_fanout");
	});

	it('phase[2] is "materialize" with kind deterministic', () => {
		expect(INIT_PHASES[2].name).toBe("materialize");
		expect(INIT_PHASES[2].kind).toBe("deterministic");
	});

	it('phase[3] is "register" with kind deterministic', () => {
		expect(INIT_PHASES[3].name).toBe("register");
		expect(INIT_PHASES[3].kind).toBe("deterministic");
	});

	it("collect phase has domains set and no docIds", () => {
		const collect = INIT_PHASES[0];
		expect(collect.domains).toBeDefined();
		expect(collect.docIds).toBeUndefined();
	});

	it("discover phase has docIds set and no domains", () => {
		const discover = INIT_PHASES[1];
		expect(discover.docIds).toBeDefined();
		expect(discover.domains).toBeUndefined();
	});

	it("collect and discover phases have retryCap 1", () => {
		expect(INIT_PHASES[0].retryCap).toBe(1);
		expect(INIT_PHASES[1].retryCap).toBe(1);
	});

	it("materialize and register phases have retryCap 0 (hard-halt)", () => {
		expect(INIT_PHASES[2].retryCap).toBe(0);
		expect(INIT_PHASES[3].retryCap).toBe(0);
	});

	it("collect phase references verifyPhase1", () => {
		expect(INIT_PHASES[0].verifyFn).toBe("verifyPhase1");
	});

	it("discover phase references verifyPhase2", () => {
		expect(INIT_PHASES[1].verifyFn).toBe("verifyPhase2");
	});

	it("materialize phase references verifyPhase3", () => {
		expect(INIT_PHASES[2].verifyFn).toBe("verifyPhase3");
	});

	it("register phase has no verifyFn", () => {
		expect(INIT_PHASES[3].verifyFn).toBeUndefined();
	});

	it("collect phase modelRole is 'discovery'", () => {
		expect(INIT_PHASES[0].modelRole).toBe("discovery");
	});

	it("discover phase modelRole is 'kb-doc'", () => {
		expect(INIT_PHASES[1].modelRole).toBe("kb-doc");
	});
});

// ── initPhaseByName / initPhaseIndexByName helpers ────────────────────────────

describe("initPhaseByName", () => {
	it("finds 'collect'", () => {
		expect(initPhaseByName("collect")?.name).toBe("collect");
	});

	it("returns undefined for unknown phase", () => {
		expect(initPhaseByName("nonexistent")).toBeUndefined();
	});
});

describe("initPhaseIndexByName", () => {
	it("returns 0 for 'collect'", () => {
		expect(initPhaseIndexByName("collect")).toBe(0);
	});

	it("returns 3 for 'register'", () => {
		expect(initPhaseIndexByName("register")).toBe(3);
	});

	it("returns -1 for unknown phase", () => {
		expect(initPhaseIndexByName("nonexistent")).toBe(-1);
	});
});

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
	it("has exactly 7 entries", () => {
		expect(KB_DOC_IDS).toHaveLength(7);
	});

	it("matches meta verbatim (wfl-init.js lines ~236–244)", () => {
		expect(Array.from(KB_DOC_IDS)).toEqual([
			"architecture/stack",
			"architecture/processes",
			"architecture/routing",
			"architecture/database",
			"architecture/testing",
			"business-domain/domain-model",
			"business-domain/domain-concepts",
		]);
	});
});

// ── ROLE_TIER constant ────────────────────────────────────────────────────────

describe("ROLE_TIER", () => {
	it("has exactly 8 keys", () => {
		expect(Object.keys(ROLE_TIER)).toHaveLength(8);
	});

	it("LLM-generation roles map to 'sonnet'", () => {
		expect(ROLE_TIER["discovery"]).toBe("sonnet");
		expect(ROLE_TIER["config"]).toBe("sonnet");
		expect(ROLE_TIER["kb-doc"]).toBe("sonnet");
		expect(ROLE_TIER["index"]).toBe("sonnet");
		expect(ROLE_TIER["context"]).toBe("sonnet");
	});

	it("deterministic roles map to 'haiku'", () => {
		expect(ROLE_TIER["gate"]).toBe("haiku");
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
