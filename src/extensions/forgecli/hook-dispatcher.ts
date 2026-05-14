// Pi-runtime hook adapter — FORGE-S18-T02 / FORGE-S18-T03
//
// Wires Forge's hook semantics onto pi's tool_call / tool_result events.
// T02: Provides audit-only observation scaffolding.
// T03: Adds enforcement — validates store-cli write payloads via store-validator,
//      checks status transitions via transition-guard, and blocks on violation
//      by returning { block: true, reason } from the tool_call handler.
//
// Audit logging: set FORGE_HOOK_AUDIT=1 to write to .forge/logs/hooks.log.
// In enforcement mode (default): violations are blocked.
// In audit mode (FORGE_HOOK_AUDIT=1): violations are logged but never blocked.
//
// --force scope:
//   When --force is present in store-cli argv, transition-guard is bypassed.
//   store-validator still runs — a malformed payload is always invalid.

import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type {
	BashToolCallEvent,
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@entelligentsia/pi-coding-agent";
import { isToolCallEventType } from "@entelligentsia/pi-coding-agent";
import { checkTwoLayerBoundary } from "./hooks/two-layer-guard.js";
import { validateStoreCLIPayload } from "./store-validator.js";
import { checkTransition } from "./transition-guard.js";

// ── Exported types — used by T03 to layer validation ─────────────────────────

/** Parsed representation of a store-cli invocation intercepted from a bash command. */
export interface StoreCLICall {
	/** Subcommand: write or update-status */
	subcmd: "write" | "update-status";
	/** Entity type: "task" | "sprint" | "bug" | "event" | ... */
	entity: string;
	/** For "write": parsed JSON payload. For "update-status": { field: string, value: string } */
	payload: unknown;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function auditEnabled(): boolean {
	return process.env.FORGE_HOOK_AUDIT === "1";
}

function appendAudit(logsDir: string, line: string): void {
	if (!auditEnabled()) return;
	try {
		mkdirSync(logsDir, { recursive: true });
		appendFileSync(path.join(logsDir, "hooks.log"), line + "\n", "utf8");
	} catch {
		// Audit is best-effort — never throw from the dispatch path.
	}
}

// ── Store-CLI invocation parser (exported for T03) ───────────────────────────

/**
 * Parses a bash command string to detect a store-cli write or update-status invocation.
 *
 * Handles forms produced by Forge workflows:
 *   node "$FORGE_ROOT/tools/store-cli.cjs" write task '{"taskId":"X",...}'
 *   node "/abs/path/to/store-cli.cjs" update-status task X status Y
 *
 * Returns null if the command does not invoke store-cli.cjs.
 *
 * NOTE (T02 scope): extraction only — no validation performed here.
 * T03 imports this function and layers schema validation on the returned payload.
 */
export function parseStoreCLIInvocation(command: string, _forgeRoot: string): StoreCLICall | null {
	// Quick pre-filter before any parsing overhead.
	if (!command.includes("store-cli.cjs")) return null;

	// Tokenise the command string into whitespace-separated tokens, respecting
	// single-quoted strings (the common form produced by Forge workflows for JSON payloads).
	const tokens = tokeniseShellCommand(command);
	if (tokens.length < 2) return null;

	// Find the token that names store-cli.cjs — it may be the first or second arg
	// depending on whether the invocation is: `node ... store-cli.cjs subcmd ...`
	// or `store-cli.cjs subcmd ...`.
	let storeCliIdx = -1;
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].endsWith("store-cli.cjs")) {
			storeCliIdx = i;
			break;
		}
	}
	if (storeCliIdx === -1 || storeCliIdx + 1 >= tokens.length) return null;

	const subcmdRaw = tokens[storeCliIdx + 1];
	const rest = tokens.slice(storeCliIdx + 2);

	if (subcmdRaw === "write") {
		// Form: store-cli.cjs write <entity> '<json-payload>'
		if (rest.length < 2) return null;
		const entity = rest[0];
		const payloadRaw = rest[1];
		let payload: unknown;
		try {
			payload = JSON.parse(payloadRaw);
		} catch {
			// Non-JSON payload — record raw string for T03 to handle.
			payload = payloadRaw;
		}
		return { subcmd: "write", entity, payload };
	}

	if (subcmdRaw === "update-status") {
		// Form: store-cli.cjs update-status <entity> <id> status <value>
		// e.g.: update-status task FORGE-S18-T02 status implemented
		if (rest.length < 4) return null;
		const entity = rest[0];
		// rest[1] is the entity ID — included in payload for T03.
		const entityId = rest[1];
		// rest[2] should be "status", rest[3] the new value.
		const field = rest[2];
		const value = rest[3];
		return {
			subcmd: "update-status",
			entity,
			payload: { entityId, field, value },
		};
	}

	// Other subcommands (emit, list, nlp, etc.) — not intercepted in T02.
	return null;
}

/**
 * Minimal shell tokeniser that handles:
 *   - whitespace delimiters
 *   - single-quoted strings (no escape sequences inside — shell literal)
 *   - double-quoted strings (basic; no escape sequences for simplicity)
 *   - unquoted tokens with embedded env-var expansions treated as opaque
 *
 * This is T02-quality — good enough to extract store-cli arguments.
 * A full POSIX tokeniser is not needed here.
 */
function tokeniseShellCommand(command: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < command.length) {
		// Skip whitespace.
		while (i < command.length && /\s/.test(command[i])) i++;
		if (i >= command.length) break;

		const ch = command[i];
		if (ch === "'") {
			// Single-quoted literal.
			i++; // skip opening quote
			let tok = "";
			while (i < command.length && command[i] !== "'") {
				tok += command[i++];
			}
			if (i < command.length) i++; // skip closing quote
			tokens.push(tok);
		} else if (ch === '"') {
			// Double-quoted — treat as literal for T02.
			i++; // skip opening quote
			let tok = "";
			while (i < command.length && command[i] !== '"') {
				tok += command[i++];
			}
			if (i < command.length) i++; // skip closing quote
			tokens.push(tok);
		} else {
			// Unquoted token — ends at whitespace or end of string.
			let tok = "";
			while (i < command.length && !/\s/.test(command[i])) {
				tok += command[i++];
			}
			tokens.push(tok);
		}
	}
	return tokens;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wire Forge hook semantics onto pi's tool_call and tool_result events.
 *
 * @param pi        The ExtensionAPI instance provided by pi at extension init.
 * @param forgeRoot Absolute path to the Forge plugin root (from .forge/config.json).
 *
 * AC#1: Both tool_call and tool_result handlers are registered.
 * AC#2: write calls validated via store-validator; blocked on schema violation.
 * AC#3: update-status calls checked via transition-guard; blocked on illegal transition.
 * AC#4: FORGE_HOOK_AUDIT=1 — all decisions logged, nothing blocked.
 */
export function registerHookDispatcher(pi: ExtensionAPI, forgeRoot: string): void {
	const logsDir = path.join(process.cwd(), ".forge", "logs");

	// ── tool_call: fires before any tool executes ─────────────────────────────
	pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult | void => {
		appendAudit(logsDir, `[tool_call] toolName=${event.toolName} toolCallId=${event.toolCallId}`);

		// ── Two-layer boundary guard (FORGE-S20-T07) ───────────────────────────
		// Reject any write/edit whose target path resolves under
		// <cwd>/forge/forge/meta/. Two-layer rule: fixes to Forge itself go
		// through forge-engineer/forge-bugfixer against forge/, not via
		// forge-cli runtime edits. FORGE_HOOK_AUDIT=1 logs but never blocks.
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const verdict = checkTwoLayerBoundary(event.input.path, process.cwd());
			if (!verdict.allowed) {
				appendAudit(
					logsDir,
					`[two-layer-guard] decision=would-block path=${verdict.resolvedPath} reason=${verdict.reason}`,
				);
				if (auditEnabled()) {
					return undefined;
				}
				return { block: true, reason: verdict.reason as string };
			}
		}

		// Bash interception: identify store-cli write/update-status calls.
		if (isToolCallEventType("bash", event)) {
			const bashEvent = event as BashToolCallEvent;
			const intercept = parseStoreCLIInvocation(bashEvent.input.command, forgeRoot);
			if (intercept) {
				appendAudit(
					logsDir,
					`[store-cli-intercept] subcmd=${intercept.subcmd} entity=${intercept.entity} payload=${JSON.stringify(intercept.payload)}`,
				);

				// Detect --force in the original argv tokens.
				const tokens = tokeniseShellCommand(bashEvent.input.command);
				const hasForce = tokens.includes("--force");

				if (intercept.subcmd === "write") {
					// AC#2: Validate payload against schema via store-validator.
					// --force does NOT bypass schema validation.
					const validation = validateStoreCLIPayload(intercept.entity, intercept.payload, forgeRoot);
					if (!validation.ok) {
						appendAudit(logsDir, `[store-cli-intercept] decision=would-block reason=${validation.reason}`);
						if (auditEnabled()) {
							// Audit mode: log and allow.
							return undefined;
						}
						return { block: true, reason: validation.reason };
					}
					appendAudit(logsDir, `[store-cli-intercept] decision=would-allow`);
				} else if (intercept.subcmd === "update-status") {
					// AC#3: Check transition via transition-guard.
					// --force bypasses transition-guard only (not schema validation).
					if (!hasForce) {
						const payloadRecord = intercept.payload as {
							entityId: string;
							field: string;
							value: string;
						};
						const guard = checkTransition(
							{
								entity: intercept.entity,
								entityId: payloadRecord.entityId,
								toStatus: payloadRecord.value,
							},
							forgeRoot,
						);

						if (guard.reason === "lookup-failed") {
							// Fail-open: lookup error must never block.
							appendAudit(
								logsDir,
								`[store-cli-intercept] decision=lookup-failed entity=${intercept.entity} entityId=${payloadRecord.entityId}`,
							);
							return undefined;
						}

						if (!guard.allowed) {
							appendAudit(logsDir, `[store-cli-intercept] decision=would-block reason=${guard.reason}`);
							if (auditEnabled()) {
								return undefined;
							}
							return { block: true, reason: guard.reason };
						}
						appendAudit(logsDir, `[store-cli-intercept] decision=would-allow`);
					} else {
						appendAudit(
							logsDir,
							`[store-cli-intercept] decision=would-allow (--force bypasses transition-guard)`,
						);
					}
				}
			}
		}

		return undefined;
	});

	// ── tool_result: fires after any tool completes (observe-only) ──────────────
	pi.on("tool_result", (event: ToolResultEvent): void => {
		appendAudit(logsDir, `[tool_result] toolName=${event.toolName} toolCallId=${event.toolCallId}`);
		// Audit-only in T02 — return void (no result replacement).
	});
}
