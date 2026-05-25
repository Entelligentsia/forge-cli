// lib/catalog-types.ts — FORGE-S25-T27
//
// Authoritative compile-time TS const tuples for domain-specific union types
// in forge-cli. Zero IO — no fs reads, no subprocess calls.
//
// Sources of truth for each const tuple:
//   - TASK/SPRINT/BUG_STATUS_VALUES: forge/forge/schemas/{task,sprint,bug}.schema.json
//     status enums (same source as build-enum-catalog.cjs in FORGE-S25-T26).
//     Verified at runtime by catalog-loader.test.ts (every catalog key appears here).
//   - SYNTHETIC_EVENT_TYPES: forge-cli internal (hook-dispatcher.ts event taxonomy).
//   - FRICTION_SUBKINDS: forge/forge/schemas/event.schema.json subkind pattern values
//     (pattern: ^(skill_unused|skill_failed|skill_missing|skill_stale|skill_redundant|x_[a-z_]+)$).
//   - ROLE_KINDS: orchestrate_task.md ROLE_TO_NOUN mapping + orchestrator role.
//   - ACTION_KINDS: event.schema.json action usage + orchestrate_task.md event emission.
//
// Design: single file for all compile-time domain constants. When a new state,
// event type, or role is added, edit this file and the corresponding source of
// truth (plugin schema or orchestrate_task.md). Regression tests verify alignment.
//
// Iron Laws: IL1 (code only in forge-cli/), IL2 (TypeScript + no new deps), IL7 (no silent failures).

// ── Task status ───────────────────────────────────────────────────────────────
//
// Source: forge/forge/schemas/task.schema.json properties.status.enum
// Last verified: FORGE-S25-T26 (enum-catalog.json generated from this enum)

export const TASK_STATUS_VALUES = [
	"draft",
	"planned",
	"plan-approved",
	"implementing",
	"implemented",
	"review-approved",
	"approved",
	"committed",
	"plan-revision-required",
	"code-revision-required",
	"blocked",
	"escalated",
	"abandoned",
] as const satisfies string[];

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

// ── Sprint status ─────────────────────────────────────────────────────────────
//
// Source: forge/forge/schemas/sprint.schema.json properties.status.enum

export const SPRINT_STATUS_VALUES = [
	"planning",
	"active",
	"completed",
	"retrospective-done",
	"blocked",
	"partially-completed",
	"abandoned",
] as const satisfies string[];

export type SprintStatus = (typeof SPRINT_STATUS_VALUES)[number];

// ── Bug status ────────────────────────────────────────────────────────────────
//
// Source: forge/forge/schemas/bug.schema.json properties.status.enum

export const BUG_STATUS_VALUES = ["reported", "triaged", "in-progress", "fixed"] as const satisfies string[];

export type BugStatus = (typeof BUG_STATUS_VALUES)[number];

// ── Command name ──────────────────────────────────────────────────────────────
//
// Source: forge/forge/tools/build-enum-catalog.cjs COMMAND_NAMES
// (subset of forge:* slash commands registered in the plugin)

export const COMMAND_NAME_VALUES = [
	"forge:sprint-intake",
	"forge:plan",
	"forge:review-plan",
	"forge:implement",
	"forge:review-code",
	"forge:fix-bug",
	"forge:sprint-plan",
	"forge:run-task",
	"forge:run-sprint",
	"forge:collate",
	"forge:retrospective",
	"forge:approve",
	"forge:commit",
	"forge:enhance",
	"forge:quiz-agent",
	"forge:validate",
	"forge:init",
	"forge:health",
	"forge:regenerate",
	"forge:update",
	"forge:add-task",
	"forge:add-pipeline",
	"forge:calibrate",
	"forge:materialize",
	"forge:remove",
	"forge:report-bug",
	"forge:store-query",
	"forge:store-repair",
	"forge:config",
	"forge:ask",
	"forge:store-custodian",
	"forge:refresh-kb-links",
] as const satisfies string[];

export type CommandName = (typeof COMMAND_NAME_VALUES)[number];

// ── Synthetic event type (forge-cli domain) ───────────────────────────────────
//
// Source: forge-cli hook-dispatcher.ts synthetic event taxonomy.
// Discriminants of the SyntheticEvent union (InitCompleteEvent, etc.).
// Verified by hook-dispatcher.test.ts.

export const SYNTHETIC_EVENT_TYPES = [
	"init-complete",
	"sprint-collate-complete",
	"migration-applied",
] as const satisfies string[];

export type SyntheticEventType = (typeof SYNTHETIC_EVENT_TYPES)[number];

// ── Friction subkind ──────────────────────────────────────────────────────────
//
// Source: forge/forge/schemas/event.schema.json subkind pattern:
//   ^(skill_unused|skill_failed|skill_missing|skill_stale|skill_redundant|x_[a-z_]+)$
// The x_ prefix is for experimental subkinds (not listed here as compile-time values;
// they are validated via the pattern at runtime by store-cli).
// Verified by catalog-types.test.ts against the event schema regex.

export const FRICTION_SUBKINDS = [
	"skill_unused",
	"skill_failed",
	"skill_missing",
	"skill_stale",
	"skill_redundant",
] as const satisfies string[];

export type FrictionSubkind = (typeof FRICTION_SUBKINDS)[number];

// ── Role kind ─────────────────────────────────────────────────────────────────
//
// Source: forge/forge/.forge/workflows/orchestrate_task.md ROLE_TO_NOUN mapping
// + orchestrator self-identification.
// Used in: session-registry.ts (PhaseSummary.role), friction-emit.ts (FrictionEmitRuntime.role).

export const ROLE_KINDS = [
	"plan",
	"implement",
	"update-plan",
	"update-impl",
	"commit",
	"review-plan",
	"review-code",
	"validate",
	"approve",
	"writeback",
	"orchestrator",
] as const satisfies string[];

export type RoleKind = (typeof ROLE_KINDS)[number];

// ── Action kind ───────────────────────────────────────────────────────────────
//
// Source: event.schema.json action field usage + orchestrate_task.md event emission.
// Used in: friction-emit.ts (FrictionEmitRuntime.action), run-task.ts event emission.

export const ACTION_KINDS = [
	"start",
	"complete",
	"plan",
	"implement",
	"review",
	"approve",
	"commit",
	"escalated",
	"gate_failed",
	"friction_drain",
	"task_skipped",
	"subagent_retry",
	"subagent_escalated",
	"verdict_malformed",
] as const satisfies string[];

export type ActionKind = (typeof ACTION_KINDS)[number];
