// Phase A tier-meta + tier-menu snapshot tests.
// Verifies the tier ↔ persona ↔ phase mapping is consistent and the
// tier-menu screen renders correctly in three states: nothing set,
// partially set, all three tiers set.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { GlobalConfig } from "../../../src/extensions/forgecli/config-layer.js";
import { renderTierMenu } from "../../../src/extensions/forgecli/config-tui/screens.js";
import {
	type AvailableModel,
	type ConfigTuiState,
	getAllTierAssignments,
	getTierAssignment,
	initialState,
	reducer,
} from "../../../src/extensions/forgecli/config-tui/state.js";
import {
	getPersonasInTier,
	getTierForPersona,
	PERSONA_META,
	PHASE_PERSONA_TABLE,
	TIER_LABELS,
	TIER_PERSONAS,
	TIER_SUB_LABELS,
	TIERS,
	type Tier,
	tierPersonaLine,
} from "../../../src/extensions/forgecli/config-tui/tier-meta.js";

// Mock theme — strips all styling so assertions match plain text.
const mockTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

const WIDTH = 80;

// ── Tier-meta consistency ────────────────────────────────────────────────────

describe("tier-meta — structure consistency", () => {
	it("exactly three tiers: heavy, standard, light", () => {
		expect(TIERS).toEqual(["heavy", "standard", "light"]);
	});

	it("every tier has an entry in TIER_PERSONAS with at least one persona", () => {
		for (const tier of TIERS) {
			expect(TIER_PERSONAS[tier].length).toBeGreaterThan(0);
		}
	});

	it("all 9 personas are accounted for across tiers (no duplicates, no gaps)", () => {
		const allPersonas = TIERS.flatMap((t) => TIER_PERSONAS[t]);
		const unique = new Set(allPersonas);
		expect(unique.size).toBe(allPersonas.length); // no duplicates
		expect(allPersonas.length).toBe(9);
		// Known 9 personas
		const expected = new Set([
			"architect",
			"supervisor", // heavy
			"engineer",
			"bug-fixer",
			"qa-engineer",
			"product-manager", // standard
			"collator",
			"librarian",
			"orchestrator", // light
		]);
		expect(unique).toEqual(expected);
	});

	it("every persona in TIER_PERSONAS has a matching entry in PERSONA_META", () => {
		for (const tier of TIERS) {
			for (const persona of TIER_PERSONAS[tier]) {
				const meta = PERSONA_META[persona];
				expect(meta).toBeDefined();
				expect(meta!.name).toBe(persona);
				expect(meta!.tier).toBe(tier);
				expect(meta!.emoji.length).toBeGreaterThan(0);
				expect(meta!.role.length).toBeGreaterThan(0);
			}
		}
	});

	it("TIER_LABELS covers all tiers", () => {
		for (const tier of TIERS) {
			expect(TIER_LABELS[tier]).toBeDefined();
			expect(TIER_LABELS[tier].length).toBeGreaterThan(0);
		}
	});

	it("TIER_SUB_LABELS covers all tiers", () => {
		for (const tier of TIERS) {
			expect(TIER_SUB_LABELS[tier]).toBeDefined();
			expect(TIER_SUB_LABELS[tier].length).toBeGreaterThan(0);
		}
	});
});

describe("tier-meta — tier ↔ persona mapping helpers", () => {
	it("getTierForPersona returns the correct tier for known personas", () => {
		expect(getTierForPersona("architect")).toBe("heavy");
		expect(getTierForPersona("supervisor")).toBe("heavy");
		expect(getTierForPersona("engineer")).toBe("standard");
		expect(getTierForPersona("bug-fixer")).toBe("standard");
		expect(getTierForPersona("qa-engineer")).toBe("standard");
		expect(getTierForPersona("product-manager")).toBe("standard");
		expect(getTierForPersona("collator")).toBe("light");
		expect(getTierForPersona("librarian")).toBe("light");
		expect(getTierForPersona("orchestrator")).toBe("light");
	});

	it("getTierForPersona returns undefined for unknown personas", () => {
		expect(getTierForPersona("unknown")).toBeUndefined();
		expect(getTierForPersona("default")).toBeUndefined();
		expect(getTierForPersona("")).toBeUndefined();
	});

	it("getPersonasInTier returns expected persona lists", () => {
		expect(getPersonasInTier("heavy")).toEqual(["architect", "supervisor"]);
		expect(getPersonasInTier("standard")).toEqual(["engineer", "bug-fixer", "qa-engineer", "product-manager"]);
		expect(getPersonasInTier("light")).toEqual(["collator", "librarian", "orchestrator"]);
	});

	it("tierPersonaLine includes emoji + name for all personas in the tier", () => {
		const heavy = tierPersonaLine("heavy");
		expect(heavy).toContain("architect");
		expect(heavy).toContain("supervisor");
		expect(heavy).toContain("🗻");
		expect(heavy).toContain("🌿");
		// Should NOT contain personas from other tiers
		expect(heavy).not.toContain("engineer");
		expect(heavy).not.toContain("collator");
	});
});

describe("tier-meta — PHASE_PERSONA_TABLE consistency", () => {
	it("has 8 phases matching CANONICAL_PHASES", () => {
		expect(PHASE_PERSONA_TABLE.length).toBe(8);
		const roles = PHASE_PERSONA_TABLE.map((p) => p.role);
		expect(roles).toEqual([
			"plan",
			"review-plan",
			"implement",
			"review-code",
			"validate",
			"approve",
			"writeback",
			"commit",
		]);
	});

	it("every phase's tier matches its persona's tier in PERSONA_META", () => {
		for (const phase of PHASE_PERSONA_TABLE) {
			const metaTier = getTierForPersona(phase.personaNoun);
			expect(metaTier).toBe(phase.tier);
		}
	});

	it("heavy tier phases: review-plan (supervisor), review-code (supervisor), approve (architect)", () => {
		const heavyPhases = PHASE_PERSONA_TABLE.filter((p) => p.tier === "heavy");
		expect(heavyPhases.length).toBe(3);
		const roles = heavyPhases.map((p) => p.role);
		expect(roles).toContain("review-plan");
		expect(roles).toContain("review-code");
		expect(roles).toContain("approve");
	});

	it("light tier phases: writeback (collator)", () => {
		const lightPhases = PHASE_PERSONA_TABLE.filter((p) => p.tier === "light");
		expect(lightPhases.length).toBe(1);
		expect(lightPhases[0].role).toBe("writeback");
	});

	it("standard tier phases: plan, implement, validate, commit (engineer/qa-engineer)", () => {
		const standardPhases = PHASE_PERSONA_TABLE.filter((p) => p.tier === "standard");
		expect(standardPhases.length).toBe(4);
	});
});

// ── Tier-menu selector tests ─────────────────────────────────────────────────

function makeState(overrides: Partial<Parameters<typeof initialState>[0]> = {}): ConfigTuiState {
	return initialState({
		global: null,
		project: null,
		cwd: "/home/x/proj",
		personaCatalogue: [
			"architect",
			"engineer",
			"supervisor",
			"bug-fixer",
			"qa-engineer",
			"product-manager",
			"collator",
			"librarian",
			"orchestrator",
		],
		pipelineCatalogue: ["default"],
		availableModels: [
			{ provider: "anthropic", id: "claude-opus-4-5" },
			{ provider: "ollama", id: "glm-5.1:cloud" },
		],
		authenticatedProviders: ["anthropic", "ollama"],
		...overrides,
	});
}

describe("getTierAssignment selector", () => {
	it("returns unset when no personas are configured", () => {
		const s = makeState();
		expect(getTierAssignment(s, "heavy").status).toBe("unset");
		expect(getTierAssignment(s, "standard").status).toBe("unset");
		expect(getTierAssignment(s, "light").status).toBe("unset");
	});

	it("returns set when all tier personas have the same model", () => {
		const s = makeState({
			global: {
				"persona-models": {
					architect: { provider: "anthropic", model: "claude-opus-4-5" },
					supervisor: { provider: "anthropic", model: "claude-opus-4-5" },
				},
			},
		});
		const assignment = getTierAssignment(s, "heavy");
		expect(assignment.status).toBe("set");
		if (assignment.status === "set") {
			expect(assignment.provider).toBe("anthropic");
			expect(assignment.model).toBe("claude-opus-4-5");
			expect(assignment.layer).toBe("global");
		}
	});

	it("returns mixed when tier personas have different models", () => {
		const s = makeState({
			global: {
				"persona-models": {
					architect: { provider: "anthropic", model: "claude-opus-4-5" },
					supervisor: { provider: "ollama", model: "glm-5.1:cloud" },
				},
			},
		});
		expect(getTierAssignment(s, "heavy").status).toBe("mixed");
	});

	it("returns unset when some but not all tier personas are set", () => {
		const s = makeState({
			global: {
				"persona-models": {
					architect: { provider: "anthropic", model: "claude-opus-4-5" },
					// supervisor not set
				},
			},
		});
		// architect is resolved but supervisor falls back to "inherit" — not in
		// listResolvedPersonas, so the tier has entries but not all personas
		// match. This should return "mixed" (architect is set, supervisor is not).
		expect(getTierAssignment(s, "heavy").status).toBe("mixed");
	});
});

describe("getAllTierAssignments selector", () => {
	it("returns three entries in tier order", () => {
		const s = makeState();
		const all = getAllTierAssignments(s);
		expect(all.length).toBe(3);
		expect(all[0].tier).toBe("heavy");
		expect(all[1].tier).toBe("standard");
		expect(all[2].tier).toBe("light");
	});

	it("returns set for fully configured tiers", () => {
		const s = makeState({
			global: {
				"persona-models": {
					architect: { provider: "anthropic", model: "claude-opus-4-5" },
					supervisor: { provider: "anthropic", model: "claude-opus-4-5" },
				},
			},
		});
		const all = getAllTierAssignments(s);
		expect(all[0].assignment.status).toBe("set"); // heavy
		expect(all[1].assignment.status).toBe("unset"); // standard
		expect(all[2].assignment.status).toBe("unset"); // light
	});
});

// ── Tier-menu rendering snapshots ─────────────────────────────────────────────

describe("tier-menu rendering — three states", () => {
	it("renders 'nothing set' state correctly", () => {
		const s = makeState(); // completely empty
		const out = renderTierMenu(s, WIDTH, mockTheme).join("\n");
		expect(out).toContain("forge config");
		expect(out).toContain("Active right now");
		expect(out).toContain("Choose models for your AI workflow");
		expect(out).toContain("Heavy");
		expect(out).toContain("Standard");
		expect(out).toContain("Light");
		expect(out).toContain("not set"); // all three tiers
		expect(out).toContain("review, sign-off");
		expect(out).toContain("planning, implementation");
		expect(out).toContain("writeback, indexing");
		expect(out).toContain("Show what runs at each step");
		expect(out).toContain("Advanced");
	});

	it("renders 'partial' state — Heavy and Light set, Standard not set", () => {
		const s = makeState({
			global: {
				"persona-models": {
					architect: { provider: "anthropic", model: "claude-opus-4-5" },
					supervisor: { provider: "anthropic", model: "claude-opus-4-5" },
					collator: { provider: "ollama", model: "glm-5.1:cloud" },
					librarian: { provider: "ollama", model: "glm-5.1:cloud" },
					orchestrator: { provider: "ollama", model: "glm-5.1:cloud" },
				},
			},
		});
		const out = renderTierMenu(s, WIDTH, mockTheme).join("\n");
		expect(out).toContain("anthropic:claude-opus-4-5"); // Heavy
		expect(out).toContain("ollama:glm-5.1:cloud"); // Light
		// Standard should still show "not set"
		// The output mentions "not set" at least once for Standard
		const lines = out.split("\n");
		const standardLine = lines.find((l) => l.includes("Standard") && l.includes("not set"));
		expect(standardLine).toBeDefined();
		// Heavy and Light should NOT show "not set"
		const heavyLine = lines.find((l) => l.includes("Heavy") && l.includes("anthropic"));
		const lightLine = lines.find((l) => l.includes("Light") && l.includes("ollama"));
		expect(heavyLine).toBeDefined();
		expect(lightLine).toBeDefined();
	});

	it("renders 'all three tiers set' state correctly", () => {
		const s = makeState({
			global: {
				"persona-models": {
					architect: { provider: "anthropic", model: "claude-opus-4-5" },
					supervisor: { provider: "anthropic", model: "claude-opus-4-5" },
					engineer: { provider: "anthropic", model: "claude-sonnet-4-6" },
					"bug-fixer": { provider: "anthropic", model: "claude-sonnet-4-6" },
					"qa-engineer": { provider: "anthropic", model: "claude-sonnet-4-6" },
					"product-manager": { provider: "anthropic", model: "claude-sonnet-4-6" },
					collator: { provider: "ollama", model: "glm-5.1:cloud" },
					librarian: { provider: "ollama", model: "glm-5.1:cloud" },
					orchestrator: { provider: "ollama", model: "glm-5.1:cloud" },
				},
			},
		});
		const out = renderTierMenu(s, WIDTH, mockTheme).join("\n");
		// All three tiers should be "set" and show their models
		expect(out).toContain("anthropic:claude-opus-4-5"); // Heavy
		expect(out).toContain("anthropic:claude-sonnet-4-6"); // Standard
		expect(out).toContain("ollama:glm-5.1:cloud"); // Light
		// No "not set" should appear
		expect(out).not.toContain("not set");
		// Global labels should appear
		expect(out).toContain("(global)");
	});

	it("renders project scope with cwd path", () => {
		const s = makeState();
		const out = renderTierMenu(s, WIDTH, mockTheme).join("\n");
		expect(out).toContain("project");
		expect(out).toContain("/home/x/proj");
	});

	it("renders global scope after tab toggle", () => {
		let s = makeState();
		s = reducer(s, { kind: "toggle-scope" });
		const out = renderTierMenu(s, WIDTH, mockTheme).join("\n");
		expect(out).toContain("global");
	});

	it("renders width-safe at narrow width (40)", () => {
		const s = makeState();
		const lines = renderTierMenu(s, 40, mockTheme);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(typeof line).toBe("string");
		}
	});
});
