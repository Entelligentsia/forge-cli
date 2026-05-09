// Pi-runtime hook adapter — FORGE-S18-T02
//
// Wires Forge's hook semantics onto pi's tool_call / tool_result events.
// Provides audit-only observation scaffolding in T02; T03 layers validation
// (store-cli pushback correction loop) on top of the surface exposed here.
//
// Audit logging: set FORGE_HOOK_AUDIT=1 to write to .forge/logs/hooks.log.
// No tool calls are blocked in this task.

import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type {
	BashToolCallEvent,
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

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
export function parseStoreCLIInvocation(
	command: string,
	_forgeRoot: string,
): StoreCLICall | null {
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
 * AC#3: tool_call handler logs to .forge/logs/hooks.log when FORGE_HOOK_AUDIT=1.
 * AC#4: tool_result handler same.
 * AC#6: bash invocation interception scaffold in place via parseStoreCLIInvocation().
 */
export function registerHookDispatcher(pi: ExtensionAPI, forgeRoot: string): void {
	const logsDir = path.join(process.cwd(), ".forge", "logs");

	// ── tool_call: fires before any tool executes (can block; T02 = audit-only) ──
	pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult | void => {
		appendAudit(
			logsDir,
			`[tool_call] toolName=${event.toolName} toolCallId=${event.toolCallId}`,
		);

		// Bash interception scaffold: identify store-cli write/update-status calls.
		if (isToolCallEventType("bash", event)) {
			const bashEvent = event as BashToolCallEvent;
			const intercept = parseStoreCLIInvocation(bashEvent.input.command, forgeRoot);
			if (intercept) {
				appendAudit(
					logsDir,
					`[store-cli-intercept] subcmd=${intercept.subcmd} entity=${intercept.entity} payload=${JSON.stringify(intercept.payload)}`,
				);
				// T02 scope: observe-only. T03 will add: validate payload against schema
				// and return { block: true, reason } on violation.
			}
		}

		// Audit-only in T02 — return void (no blocking).
		return undefined;
	});

	// ── tool_result: fires after any tool completes (observe-only) ──────────────
	pi.on("tool_result", (event: ToolResultEvent): void => {
		appendAudit(
			logsDir,
			`[tool_result] toolName=${event.toolName} toolCallId=${event.toolCallId}`,
		);
		// Audit-only in T02 — return void (no result replacement).
	});
}
