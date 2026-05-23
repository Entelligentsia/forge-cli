// Store-error remediation — forge-cli#24
// Moved from lib/store-error-remediation.ts to root by FORGE-S25-T22 (S-7: single-file lib/ dir).
//
// Shared remediation-hint surface for store validation errors.
// Consumed by:
//   - health-check.ts (per-error row in store-integrity output)
//   - hooks/write-guard.ts (block-message body for schema violations)
//   - hook-dispatcher.ts (store-cli intercept block messages)
//   - store-validator.ts (structured result for hook callers)
//
// Error sources:
//   1. validate.js (in-process via write-guard) — produces error strings like:
//        "status: value "verified" not in [reported, triaged, in-progress, fixed]"
//        "taskId: missing required field"
//        "xyz: undeclared field"
//   2. store-cli.cjs validate (subprocess via store-validator.ts) — same format,
//      piped through stderr.
//   3. validate-store.cjs --dry-run (subprocess via health-check.ts) — lines like:
//        "ERROR  FORGE-S18-T02: status: value "verified" not in [reported, triaged, ...]"
//        "WARN   FORGE-S18-T02: ..."
//
// This module parses those formats and returns a one-line user-facing hint
// plus an optional copy-pasteable store-cli command.

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RemediationResult {
	/** One-line user-facing hint explaining the error and the fix. */
	hint: string;
	/** Optional copy-pasteable store-cli command. Empty string if N/A. */
	command: string;
}

// ── Entity-type inference from entity name / ID ────────────────────────────────

/** Map entity type to the corresponding schema's status enum values. */
const STATUS_ENUMS: Record<string, readonly string[]> = {
	task: [
		"draft", "planned", "plan-approved", "implementing", "implemented",
		"review-approved", "approved", "committed", "plan-revision-required",
		"code-revision-required", "blocked", "escalated", "abandoned",
	],
	sprint: [
		"planning", "active", "completed", "retrospective-done",
		"partially-completed", "blocked", "abandoned",
	],
	bug: ["reported", "triaged", "in-progress", "fixed"],
	feature: ["proposed", "accepted", "in-progress", "delivered", "declined"],
	event: [], // no status field
};

/** Known entity types that support write via store-cli. */
const ENTITY_TYPES = new Set(["task", "sprint", "bug", "feature", "event"]);

/**
 * Infer the entity type from an entity name/ID string.
 * Returns "task" as default if no match.
 */
export function inferEntityType(entity: string): string {
	const lower = entity.toLowerCase();

	// Bug patterns: BUG-015, FORGE-BUG-015, bug-031
	if (/\bbug/i.test(entity)) return "bug";
	// Sprint patterns: S18 (standalone), sprint-01 — but NOT inside task IDs like FORGE-S18-T02
	if (/^[A-Z]+-S\d+$/i.test(entity) || /\bsprint/i.test(entity)) return "sprint";
	// Feature patterns: FORGE-F01
	if (/\bf\d+\b/i.test(entity) || lower.includes("feat")) return "feature";
	// Event patterns
	if (lower.includes("event")) return "event";
	// Task IDs: FORGE-S18-T02, PROJECT-T01
	if (/\bt\d+\b/i.test(entity)) return "task";
	// Default
	return "task";
}

// ── Known-field remediation map ────────────────────────────────────────────────

interface FieldRemediation {
	hint: string;
	command: (entityType: string, entityId: string) => string;
}

const STATUS_REMEDIATION: FieldRemediation = {
	hint: "Set status to one of the legal values for this entity type.",
	command: (entityType, entityId) =>
		`node "$FORGE_ROOT/tools/store-cli.cjs" update-status ${entityType} ${entityId} status <legal-value>`,
};

const REQUIRED_FIELD_REMEDIATION: FieldRemediation = {
	hint: "Add the missing field with a valid value. Use the template command to see the canonical shape.",
	command: (entityType, _entityId) =>
		`node "$FORGE_ROOT/tools/store-cli.cjs" template ${entityType}`,
};

const UNDECLARED_FIELD_REMEDIATION: FieldRemediation = {
	hint: "Remove the undeclared field, or check the schema for the correct property name.",
	command: (entityType, _entityId) =>
		`node "$FORGE_ROOT/tools/store-cli.cjs" describe ${entityType}`,
};

const TYPE_MISMATCH_REMEDIATION: FieldRemediation = {
	hint: "Use the correct type for this field. Use the describe command to see the expected type.",
	command: (entityType, _entityId) =>
		`node "$FORGE_ROOT/tools/store-cli.cjs" describe ${entityType}`,
};

const PATTERN_REMEDIATION: FieldRemediation = {
	hint: "The value must match the expected pattern (e.g. a date-time or ID format).",
	command: (entityType, _entityId) =>
		`node "$FORGE_ROOT/tools/store-cli.cjs" describe ${entityType}`,
};

const DATE_TIME_REMEDIATION: FieldRemediation = {
	hint: "Use an ISO 8601 date-time string (e.g. 2026-05-21T12:00:00Z).",
	command: (entityType, _entityId) =>
		`node "$FORGE_ROOT/tools/store-cli.cjs" describe ${entityType}`,
};

const LENGTH_REMEDIATION: FieldRemediation = {
	hint: "Adjust the value length to satisfy the schema constraint.",
	command: (entityType, _entityId) =>
		`node "$FORGE_ROOT/tools/store-cli.cjs" describe ${entityType}`,
};

// ── Error-string parsers ────────────────────────────────────────────────────────

/** Parsed breakdown of a validation error string. */
interface ParsedError {
	field: string;
	errorKind: "enum" | "required" | "undeclared" | "type" | "pattern" | "datetime" | "length" | "other";
	observed?: string;
	enumValues?: string[];
}

/**
 * Parse a single validation error line from validate.js / store-cli.
 *
 * Examples:
 *   'status: value "verified" not in [reported, triaged, in-progress, fixed]'
 *   'taskId: missing required field'
 *   'xyz: undeclared field'
 *   'sprintId: expected string, got number'
 *   'title: value length 0 is below minLength 1'
 *   'createdAt: value "today" is not a valid date-time'
 *   'prefix: value "AB" does not match pattern ^[A-Z]+-[A-Z]$'
 */
export function parseValidationError(line: string): ParsedError {
	// Enum violation: 'field: value "X" not in [a, b, c]'
	const enumMatch = line.match(/^(\w+):\s+value\s+"([^"]+)"\s+not in \[([^\]]+)\]/);
	if (enumMatch) {
		return {
			field: enumMatch[1],
			errorKind: "enum",
			observed: enumMatch[2],
			enumValues: enumMatch[3].split(",").map((s) => s.trim()),
		};
	}

	// Required field: 'field: missing required field'
	if (/\bmissing required field\b/.test(line)) {
		const fieldMatch = line.match(/^(\w+):/);
		return { field: fieldMatch?.[1] ?? "unknown", errorKind: "required" };
	}

	// Undeclared field: 'xyz: undeclared field'
	if (/\bundeclared field\b/.test(line)) {
		const fieldMatch = line.match(/^(\w+):/);
		return { field: fieldMatch?.[1] ?? "unknown", errorKind: "undeclared" };
	}

	// Type mismatch: 'field: expected string, got number'
	const typeMatch = line.match(/^(\w+):\s+expected\s+\S+,?\s+got\s+\S+/);
	if (typeMatch) {
		return { field: typeMatch[1], errorKind: "type" };
	}

	// Date-time format: 'field: value "..." is not a valid date-time'
	if (/\bis not a valid date-time\b/.test(line)) {
		const fieldMatch = line.match(/^(\w+):/);
		return { field: fieldMatch?.[1] ?? "unknown", errorKind: "datetime" };
	}

	// Pattern mismatch: 'field: value "..." does not match pattern ...'
	if (/\bdoes not match pattern\b/.test(line)) {
		const fieldMatch = line.match(/^(\w+):/);
		return { field: fieldMatch?.[1] ?? "unknown", errorKind: "pattern" };
	}

	// Length violations
	if (/\blength\b.*\b(exceeds|below)\b/.test(line) || /\b(exceeds|below)\b.*\blength\b/.test(line)) {
		const fieldMatch = line.match(/^(\w+):/);
		return { field: fieldMatch?.[1] ?? "unknown", errorKind: "length" };
	}

	// Generic: capture leading field name if present
	const genericMatch = line.match(/^(\w+):/);
	return { field: genericMatch?.[1] ?? "unknown", errorKind: "other" };
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Given a single validation error line (from validate.js or store-cli),
 * return a user-facing remediation hint and optional copy-pasteable command.
 *
 * @param errorLine  A single error line from validate.js / store-cli output.
 * @param entityType  The entity type (task, sprint, bug, feature, event).
 * @param entityId   The entity ID (e.g. "FORGE-S18-T02") — used for commands.
 * @returns          RemediationResult with hint and command.
 */
export function remediateError(
	errorLine: string,
	entityType: string,
	entityId: string,
): RemediationResult {
	const parsed = parseValidationError(errorLine);

	switch (parsed.errorKind) {
		case "enum": {
			const legalValues = STATUS_ENUMS[entityType] ?? parsed.enumValues ?? [];
			const isStatusField = parsed.field === "status" || parsed.field.toLowerCase().includes("status");
			if (isStatusField && legalValues.length > 0) {
				return {
					hint: `"${parsed.observed}" is not a legal ${entityType} status. Legal values: ${legalValues.join(", ")}.`,
					command: `node "$FORGE_ROOT/tools/store-cli.cjs" update-status ${entityType} ${entityId} status <${legalValues.join("|")}>`,
				};
			}
			if (legalValues.length > 0) {
				return {
					hint: `Invalid value for "${parsed.field}". Allowed: ${legalValues.join(", ")}.`,
					command: `node "$FORGE_ROOT/tools/store-cli.cjs" template ${entityType}`,
				};
			}
			return {
				hint: STATUS_REMEDIATION.hint,
				command: STATUS_REMEDIATION.command(entityType, entityId),
			};
		}
		case "required":
			return {
				hint: REQUIRED_FIELD_REMEDIATION.hint,
				command: REQUIRED_FIELD_REMEDIATION.command(entityType, entityId),
			};
		case "undeclared":
			return {
				hint: UNDECLARED_FIELD_REMEDIATION.hint,
				command: UNDECLARED_FIELD_REMEDIATION.command(entityType, entityId),
			};
		case "type":
			return {
				hint: TYPE_MISMATCH_REMEDIATION.hint,
				command: TYPE_MISMATCH_REMEDIATION.command(entityType, entityId),
			};
		case "datetime":
			return {
				hint: DATE_TIME_REMEDIATION.hint,
				command: DATE_TIME_REMEDIATION.command(entityType, entityId),
			};
		case "pattern":
			return {
				hint: PATTERN_REMEDIATION.hint,
				command: PATTERN_REMEDIATION.command(entityType, entityId),
			};
		case "length":
			return {
				hint: LENGTH_REMEDIATION.hint,
				command: LENGTH_REMEDIATION.command(entityType, entityId),
			};
		case "other":
		default:
			return {
				hint: "Check the schema for the expected shape.",
				command: `node "$FORGE_ROOT/tools/store-cli.cjs" template ${entityType}`,
			};
	}
}

/**
 * Parse a multi-line validation output (e.g. from store-cli validate or
 * validate-store --dry-run) into individual error lines and return
 * remediation for each.
 *
 * @param output    Raw multi-line output from validation tool.
 * @param entityType Override entity type (inferred from output if not provided).
 * @returns         Array of { errorLine, remediation } objects.
 */
export function remediateValidationOutput(
	output: string,
	entityType?: string,
): Array<{ errorLine: string; remediation: RemediationResult }> {
	const lines = output
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	const results: Array<{ errorLine: string; remediation: RemediationResult }> = [];

	for (const line of lines) {
		// Strip "ERROR" / "WARN" prefix from validate-store --dry-run output
		const cleaned = line.replace(/^(ERROR|WARN)\s+/, "");
		if (!cleaned) continue;

		// Extract entity ID from lines like "FORGE-S18-T02: status: ..."
		const entityIdMatch = cleaned.match(/^([A-Z]+-S?\d+-T?\d+|[A-Z]+-BUG-\d+|[A-Z]+-F\d+):/);
		const entityId = entityIdMatch?.[1] ?? "unknown";

		// If entity type not overridden, try to infer
		const inferredType = entityType ?? inferEntityType(entityId);

		// Skip non-error lines (hint lines from validate.js, blank lines, etc.)
		if (cleaned.startsWith("(") || cleaned.startsWith("hint:") || cleaned.startsWith("#")) {
			continue;
		}

		// Skip lines that are just an entity name without an error field
		// (the real error is on the same line after the entity prefix)
		const errorPart = entityIdMatch ? cleaned.slice(entityIdMatch[0].length).trim() : cleaned;
		if (!errorPart || errorPart.length < 3) continue;

		results.push({
			errorLine: cleaned,
			remediation: remediateError(errorPart, inferredType, entityId),
		});
	}

	return results;
}

/**
 * Format a block message for a write-guard violation, appending remediation hints.
 * Used by hook-dispatcher.ts for store-cli intercept blocks.
 *
 * @param rawReason  The raw reason string from validateStoreCLIPayload or checkWriteGuard.
 * @param entityType  The entity type if known.
 * @param entityId   The entity ID if known.
 * @returns          Enhanced reason string with remediation hints appended.
 */
export function enhanceBlockMessage(
	rawReason: string,
	entityType?: string,
	entityId?: string,
): string {
	// Parse the raw reason into lines and try to add remediation to each error line.
	const lines = rawReason.split("\n");
	const enhanced: string[] = [];

	for (const line of lines) {
		// Strip leading list markers and bullet points
		const stripped = line.replace(/^\s*[-•]\s*/, "").trim();
		// Check if this line contains a recognizable validation error pattern
		const parsed = parseValidationError(stripped);
		// Also match lines that contain validation error patterns not caught by parseValidationError
		const hasKnownError = parsed.errorKind !== "other" || /\bmissing required\b|\bnot in \[|\bundeclared\b|\bexpected\b.*\bgot\b/.test(stripped);
		if (hasKnownError) {
			const type = entityType ?? "task";
			const id = entityId ?? "unknown";
			const remediation = remediateError(stripped, type, id);
			enhanced.push(line);
			enhanced.push(`  💡 ${remediation.hint}`);
			if (remediation.command) {
				enhanced.push(`  → ${remediation.command}`);
			}
		} else {
			enhanced.push(line);
		}
	}

	return enhanced.join("\n");
}