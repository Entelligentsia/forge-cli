// Write-boundary schema guard — FORGE-S23-T02.
//
// Validates Write/Edit tool calls targeting Forge-owned paths (.forge/store/**/*.json
// and .forge/config.json) against the corresponding JSON schemas.
//
// Mirrors the plugin's forge/forge/hooks/validate-write.js logic, ported to
// TypeScript for pi's synchronous tool_call handler. Key differences from plugin:
//   - No MultiEdit: pi does not have a MultiEdit event type.
//   - Edit semantics: pi edit events use `edits: [{oldText, newText}]` arrays,
//     not `old_string / new_string`. All edits are applied sequentially.
//   - Progress.log (line-pipe-delimited) format is NOT covered — pi agents do not
//     write progress.log directly; store-cli does.
//   - In-process validation via createRequire (no spawn): matches pi's sync constraint.
//
// Fail-open philosophy: any internal error (schema not found, validate.js load
// failure, JSON parse error) logs a warning to stderr and returns { block: false }.
// A broken validator must never block legitimate work.
//
// FORGE_SKIP_WRITE_VALIDATION=1: bypass switch (operator-only). Logs to hooks.log.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { enhanceBlockMessage } from "../store-error-remediation.js";

// ── Path → schema registry ────────────────────────────────────────────────────
//
// Ported from forge/forge/hooks/lib/write-registry.js REGISTRY.
// FIRST match wins — more specific patterns before generalizations.
// All patterns anchor to absolute-path suffixes.

interface RegistryEntry {
	pattern: RegExp;
	schema: string;
	kind: string;
}

export const WRITE_REGISTRY: RegistryEntry[] = [
	// Core store entities
	{ pattern: /(?:^|\/)\.forge\/store\/features\/[^/]+\.json$/, schema: "feature.schema.json", kind: "feature" },
	{ pattern: /(?:^|\/)\.forge\/store\/sprints\/[^/]+\.json$/, schema: "sprint.schema.json", kind: "sprint" },
	{ pattern: /(?:^|\/)\.forge\/store\/tasks\/[^/]+\.json$/, schema: "task.schema.json", kind: "task" },
	{ pattern: /(?:^|\/)\.forge\/store\/bugs\/[^/]+\.json$/, schema: "bug.schema.json", kind: "bug" },

	// Event sidecars — prefixed with `_`, must be before general event pattern
	{
		pattern: /(?:^|\/)\.forge\/store\/events\/[^/]+\/_[^/]+_usage\.json$/,
		schema: "event-sidecar.schema.json",
		kind: "event-sidecar",
	},

	// Canonical events — any other .json under events/<bucket>/ not starting with `_`
	{
		pattern: /(?:^|\/)\.forge\/store\/events\/[^/]+\/[^_/][^/]*\.json$/,
		schema: "event.schema.json",
		kind: "event",
	},

	// Collation watermark
	{
		pattern: /(?:^|\/)\.forge\/store\/COLLATION_STATE\.json$/,
		schema: "collation-state.schema.json",
		kind: "collation-state",
	},

	// AC#3: Forge config (new — not in plugin registry)
	{ pattern: /(?:^|\/)\.forge\/config\.json$/, schema: "config.schema.json", kind: "config" },
];

export function matchWriteRegistry(absPath: string): RegistryEntry | null {
	if (!absPath || typeof absPath !== "string") return null;
	for (const entry of WRITE_REGISTRY) {
		if (entry.pattern.test(absPath)) return entry;
	}
	return null;
}

// ── Schema loader ─────────────────────────────────────────────────────────────
//
// Resolution order (mirrors plugin's loadSchema()):
//   1. <bundleRoot>/forge-payload/.schemas/<filename>  — bundled npm install
//   2. <forgeRoot>/schemas/<filename>                  — dev mode
//
// bundleRoot is resolved relative to this module's location:
//   dist/extensions/forgecli/hooks/write-guard.js  →  dist/
//   → up 3 levels from the hooks/ directory.

function resolveBundleRoot(): string {
	// import.meta.url → this file's URL → resolve to package dist/ root
	const thisFile = fileURLToPath(import.meta.url);
	// thisFile: .../dist/extensions/forgecli/hooks/write-guard.js
	// up 4 dirs: hooks → forgecli → extensions → dist → pkg-root
	// We want dist/, which is 3 levels up from this file's directory
	return path.resolve(path.dirname(thisFile), "../../../");
}

function loadSchema(filename: string, forgeRoot: string): unknown {
	const bundleRoot = resolveBundleRoot();
	const candidates = [
		path.join(bundleRoot, "forge-payload", ".schemas", filename),
		path.join(forgeRoot, "schemas", filename),
	];
	for (const c of candidates) {
		if (existsSync(c)) {
			return JSON.parse(readFileSync(c, "utf8"));
		}
	}
	throw new Error(`schema not found: ${filename} (looked in: ${candidates.join(", ")})`);
}

// ── CJS validator loader (validate.js + suggest.cjs) ──────────────────────────
//
// validate.js and suggest.cjs are CommonJS modules bundled in
// dist/forge-payload/tools/lib/. We load them via createRequire — the
// ESM→CJS bridge — so we can use them synchronously without spawn overhead.

interface ValidateModule {
	validateRecord: (record: unknown, schema: unknown) => string[];
}

function loadValidator(forgeRoot: string): ValidateModule {
	const require = createRequire(import.meta.url);
	const bundleRoot = resolveBundleRoot();
	const candidates = [
		path.join(bundleRoot, "forge-payload", "tools", "lib", "validate.js"),
		path.join(forgeRoot, "tools", "lib", "validate.js"),
	];
	for (const c of candidates) {
		if (existsSync(c)) {
			return require(c) as ValidateModule;
		}
	}
	throw new Error(`validate.js not found (looked in: ${candidates.join(", ")})`);
}

// ── Pi edit semantics ──────────────────────────────────────────────────────────
//
// Pi edit events carry: { path: string, edits: Array<{oldText: string, newText: string}> }
// Apply all edits sequentially against the current file contents.
// Fail-open if the file cannot be read (return empty string).

export function applyPiEdits(
	filePath: string,
	edits: Array<{ oldText: string; newText: string }>,
): string {
	let contents: string;
	try {
		contents = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
	} catch {
		// Fail-open: cannot read file, treat as empty
		contents = "";
	}
	for (const edit of edits) {
		const idx = contents.indexOf(edit.oldText);
		if (idx === -1) {
			// oldText not found — fail-open (do not block due to edit mechanics)
			continue;
		}
		contents = contents.slice(0, idx) + edit.newText + contents.slice(idx + edit.oldText.length);
	}
	return contents;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface WriteGuardResult {
	block: boolean;
	reason?: string;
}

/**
 * Check whether a Write or Edit targeting `filePath` with `contents` satisfies
 * the Forge schema for that path.
 *
 * @param filePath  Absolute path being written (from event.input.path, resolved).
 * @param contents  Post-write/post-edit file contents as a string.
 * @param forgeRoot Absolute path to the Forge plugin root.
 * @returns { block: false } if allowed; { block: true, reason } if blocked.
 *
 * Fail-open: returns { block: false } on any internal error.
 */
export function checkWriteGuard(
	filePath: string,
	contents: string,
	forgeRoot: string,
): WriteGuardResult {
	// Bypass: operator-only escape hatch
	if (process.env.FORGE_SKIP_WRITE_VALIDATION === "1") {
		try {
			// Audit log — best-effort
			import("node:fs").then(({ appendFileSync, mkdirSync }) => {
				const logsDir = path.join(process.cwd(), ".forge", "logs");
				mkdirSync(logsDir, { recursive: true });
				const relPath = path.relative(process.cwd(), filePath);
				appendFileSync(
					path.join(logsDir, "hooks.log"),
					`[write-guard] FORGE_SKIP_WRITE_VALIDATION=1 bypass on ${relPath}\n`,
					"utf8",
				);
			}).catch(() => {});
		} catch {
			// Audit is best-effort
		}
		return { block: false };
	}

	// Check registry
	const entry = matchWriteRegistry(filePath);
	if (!entry) {
		return { block: false }; // Not a Forge-owned path — allow
	}

	// Load schema and validator (fail-open on any error)
	let validator: ValidateModule;
	let schema: unknown;
	try {
		validator = loadValidator(forgeRoot);
		schema = loadSchema(entry.schema, forgeRoot);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		try {
			process.stderr.write(`[write-guard] setup error (fail-open): ${msg}\n`);
		} catch {
			// ignore
		}
		return { block: false };
	}

	// Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const relPath = path.relative(process.cwd(), filePath);
		return {
			block: true,
			reason:
				`❌ Forge schema violation — write blocked\n` +
				`Path: ${relPath}\n` +
				`Kind: ${entry.kind}\n` +
				`Violation: Invalid JSON: ${msg}\n` +
				`💡 Fix the JSON syntax error (common: trailing comma, unquoted key, missing brace).\n` +
				`Hint: see forge/schemas/${entry.schema} for the expected shape.\n` +
				"To bypass for one turn (emergency repair): FORGE_SKIP_WRITE_VALIDATION=1.",
		};
	}

	// Validate
	let errors: string[];
	try {
		errors = validator.validateRecord(parsed, schema);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		try {
			process.stderr.write(`[write-guard] validation error (fail-open): ${msg}\n`);
		} catch {
			// ignore
		}
		return { block: false };
	}

	if (errors.length > 0) {
		const relPath = path.relative(process.cwd(), filePath);
		const violationLines = errors.map((e) => `  - ${e}`).join("\n");
		const enhancedViolations = enhanceBlockMessage(violationLines, entry.kind, "unknown");
		return {
			block: true,
			reason:
				`❌ Forge schema violation — write blocked\n` +
				`Path: ${relPath}\n` +
				`Kind: ${entry.kind}\n` +
				`Violations:\n${enhancedViolations}\n` +
				`Hint: see forge/schemas/${entry.schema} for the full shape.\n` +
				"To bypass for one turn (emergency repair): FORGE_SKIP_WRITE_VALIDATION=1.",
		};
	}

	return { block: false };
}
