// Tier ↔ persona ↔ emoji ↔ role mapping — single source of truth.
// Phase A: hardcoded tables. Personas are stable; new personas require a
// one-line change here. Tier strings never enter the config JSON (Plan 16 IL3).

export type Tier = "heavy" | "standard" | "light";

export const TIERS: readonly Tier[] = ["heavy", "standard", "light"] as const;

export interface PersonaMeta {
	name: string;
	emoji: string;
	/** Short user-facing role description shown in parentheses on tier rows. */
	role: string;
	tier: Tier;
}

// ── Persona metadata (9 personas) ────────────────────────────────────────────

export const PERSONA_META: Record<string, PersonaMeta> = {
	architect: { name: "architect", emoji: "🗻", role: "plan review, sign-off", tier: "heavy" },
	supervisor: { name: "supervisor", emoji: "🌿", role: "code review, approval", tier: "heavy" },
	engineer: { name: "engineer", emoji: "🌱", role: "planning, implementation", tier: "standard" },
	"bug-fixer": { name: "bug-fixer", emoji: "🐛", role: "bug triage, fix", tier: "standard" },
	"qa-engineer": { name: "qa-engineer", emoji: "🍵", role: "validation, testing", tier: "standard" },
	"product-manager": { name: "product-manager", emoji: "📋", role: "sprint intake, stories", tier: "standard" },
	collator: { name: "collator", emoji: "🍃", role: "KB regeneration, writeback", tier: "light" },
	librarian: { name: "librarian", emoji: "📚", role: "indexing, cataloguing", tier: "light" },
	orchestrator: { name: "orchestrator", emoji: "🌊", role: "task flow, coordination", tier: "light" },
};

// ── Tier → persona membership ────────────────────────────────────────────────

export const TIER_PERSONAS: Record<Tier, readonly string[]> = {
	heavy: ["architect", "supervisor"],
	standard: ["engineer", "bug-fixer", "qa-engineer", "product-manager"],
	light: ["collator", "librarian", "orchestrator"],
};

// ── Tier display labels (user-facing) ───────────────────────────────────────

export const TIER_LABELS: Record<Tier, string> = {
	heavy: "Heavy",
	standard: "Standard",
	light: "Light",
};

/** Short sub-copy shown after each tier row in parentheses. */
export const TIER_SUB_LABELS: Record<Tier, string> = {
	heavy: "review, sign-off",
	standard: "planning, implementation",
	light: "writeback, indexing",
};

// ── Phase ↔ persona binding ─────────────────────────────────────────────────
// Mirrored from state/constants.ts CANONICAL_PHASES. Kept here so tier-meta
// is self-contained (the config-tui module doesn't import the orchestrator).

export const PHASE_PERSONA_TABLE: ReadonlyArray<{
	role: string;
	personaNoun: string;
	tier: Tier;
}> = [
	{ role: "plan", personaNoun: "engineer", tier: "standard" },
	{ role: "review-plan", personaNoun: "supervisor", tier: "heavy" },
	{ role: "implement", personaNoun: "engineer", tier: "standard" },
	{ role: "review-code", personaNoun: "supervisor", tier: "heavy" },
	{ role: "validate", personaNoun: "qa-engineer", tier: "standard" },
	{ role: "approve", personaNoun: "architect", tier: "heavy" },
	{ role: "writeback", personaNoun: "collator", tier: "light" },
	{ role: "commit", personaNoun: "engineer", tier: "standard" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Look up which tier a persona belongs to. Returns undefined for unknown names. */
export function getTierForPersona(persona: string): Tier | undefined {
	return PERSONA_META[persona]?.tier;
}

/** Return persona names in the given tier. */
export function getPersonasInTier(tier: Tier): readonly string[] {
	return TIER_PERSONAS[tier];
}

/**
 * Build a one-line emoji summary for the personas in a tier.
 * E.g. "🗻 architect, 🌿 supervisor"
 */
export function tierPersonaLine(tier: Tier): string {
	return TIER_PERSONAS[tier]
		.map((p) => {
			const meta = PERSONA_META[p];
			return meta ? `${meta.emoji} ${meta.name}` : p;
		})
		.join(", ");
}
