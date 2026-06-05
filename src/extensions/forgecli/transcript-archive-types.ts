// transcript-archive-types.ts — schemas for the central transcript archive.
//
// The archive lives under `~/.pi/forge-cli/transcripts/` (see paths/paths.ts)
// and mirrors every orchestrator run (run-task / fix-bug / run-sprint task)
// from project-local `.forge/transcripts/` into a permanent, compressed,
// cross-project store:
//
//   transcripts/
//     index.jsonl                     ← one IndexEntry line per archived run
//     projects.json                   ← ProjectsRegistry (projectKey → identity)
//     <projectKey>/<entityId>/<runId>/
//         manifest.json               ← RunManifest
//         orchestrator.jsonl          ← copied as-is (greppable)
//         <ISO>__<entityId>__<phase>.json.gz
//
// Everything read back from disk is untrusted (crash-truncated writes,
// hand-edits): readers Value.Check before use and return null on mismatch —
// they never throw on malformed input.

import { type Static, Type } from "typebox";

/** Per-phase token usage, captured from the subagent transcript header. */
export const PhaseUsageSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cost: Type.Number(),
	contextTokens: Type.Optional(Type.Number()),
	turns: Type.Optional(Type.Number()),
});
export type PhaseUsage = Static<typeof PhaseUsageSchema>;

/** One pipeline phase within an archived run. */
export const PhaseRecordSchema = Type.Object({
	role: Type.String(),
	attempt: Type.Number(),
	/** Verdict from the orchestrator phase-end event; "n/a" when none applies. */
	verdict: Type.String(),
	model: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	usage: Type.Optional(PhaseUsageSchema),
	/** Archived phase-transcript filename (without the .gz suffix). */
	file: Type.Optional(Type.String()),
	/**
	 * Archived live tail-log filename (without the .gz suffix) — the exact
	 * lines the dashboard rendered during the run (`*.tail.jsonl`). Replay
	 * prefers this over reconstructing a digest from the transcript.
	 */
	tailFile: Type.Optional(Type.String()),
	startedAt: Type.Optional(Type.String()),
	elapsedMs: Type.Optional(Type.Number()),
});
export type PhaseRecord = Static<typeof PhaseRecordSchema>;

/** Aggregate bucket used for both byModel and byProvider rollups. */
export const UsageAggregateSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cost: Type.Number(),
	phases: Type.Number(),
});
export type UsageAggregate = Static<typeof UsageAggregateSchema>;

export const RunTotalsSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cost: Type.Number(),
	byModel: Type.Record(Type.String(), UsageAggregateSchema),
	byProvider: Type.Record(Type.String(), UsageAggregateSchema),
	/** Count of phase-loopback events (revision loops) in the run. */
	revisionLoops: Type.Number(),
});
export type RunTotals = Static<typeof RunTotalsSchema>;

export const RunOutcomeSchema = Type.Union([
	Type.Literal("complete"),
	Type.Literal("halted"),
	Type.Literal("cancelled"),
	Type.Literal("error"),
	/** No pipeline-end event found — crash- or in-flight-truncated run. */
	Type.Literal("incomplete"),
]);
export type RunOutcome = Static<typeof RunOutcomeSchema>;

export const EntityKindSchema = Type.Union([
	Type.Literal("task"),
	Type.Literal("bug"),
	Type.Literal("sprint"),
	Type.Literal("unknown"),
]);
export type EntityKind = Static<typeof EntityKindSchema>;

/** manifest.json — full metadata for one archived run. */
export const RunManifestSchema = Type.Object({
	schema: Type.Literal("forge-run-manifest/v1"),
	runId: Type.String(),
	projectKey: Type.String(),
	projectPath: Type.String(),
	projectName: Type.String(),
	projectPrefix: Type.String(),
	entityId: Type.String(),
	entityKind: EntityKindSchema,
	/** Back-reference for sprint-nested task runs — no synthetic sprint container. */
	sprintId: Type.Optional(Type.String()),
	startedAt: Type.String(),
	finishedAt: Type.Optional(Type.String()),
	durationMs: Type.Optional(Type.Number()),
	outcome: RunOutcomeSchema,
	phases: Type.Array(PhaseRecordSchema),
	totals: RunTotalsSchema,
	archivedAt: Type.String(),
});
export type RunManifest = Static<typeof RunManifestSchema>;

/** One line of index.jsonl — the append-only global run timeline. */
export const IndexEntrySchema = Type.Object({
	runId: Type.String(),
	projectKey: Type.String(),
	entityId: Type.String(),
	entityKind: EntityKindSchema,
	sprintId: Type.Optional(Type.String()),
	startedAt: Type.String(),
	outcome: RunOutcomeSchema,
	input: Type.Number(),
	output: Type.Number(),
	cost: Type.Number(),
	durationMs: Type.Optional(Type.Number()),
	archivedAt: Type.String(),
});
export type IndexEntry = Static<typeof IndexEntrySchema>;

export const ProjectEntrySchema = Type.Object({
	path: Type.String(),
	prefix: Type.String(),
	name: Type.String(),
	firstSeen: Type.String(),
	lastSeen: Type.String(),
	runCount: Type.Number(),
});
export type ProjectEntry = Static<typeof ProjectEntrySchema>;

/** projects.json — projectKey → identity registry. */
export const ProjectsRegistrySchema = Type.Object({
	version: Type.Literal(1),
	projects: Type.Record(Type.String(), ProjectEntrySchema),
});
export type ProjectsRegistry = Static<typeof ProjectsRegistrySchema>;
