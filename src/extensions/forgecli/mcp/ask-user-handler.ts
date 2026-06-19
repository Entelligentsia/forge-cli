// mcp/ask-user-handler.ts — MCP elicitation handler for forge_ask_user.
// FORGE-S34-T04.
//
// Implements forge_ask_user over MCP server.elicitInput() (form mode per
// @modelcontextprotocol/sdk @1.29.0). When the client does not support
// elicitation or FORGE_YES/FORGE_NON_INTERACTIVE is set, falls back to the
// declared default without blocking.
//
// Three elicitation outcomes handled per ADR Decision 5:
//   accept  → return user answer
//   decline → return isError (user explicitly said no)
//   cancel  → return fallback (treat as non-interactive)
//
// Iron Law 6 compliance: no subprocess spawning. Only server.elicitInput() call.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolResult } from "./cjs-handlers.js";

// ── Non-interactive detection ─────────────────────────────────────────────────

function isNonInteractive(): boolean {
	return process.env["FORGE_YES"] === "1" || process.env["FORGE_NON_INTERACTIVE"] === "1";
}

// ── Fallback computation ──────────────────────────────────────────────────────

function computeFallback(type: string, options?: string[], defaultVal?: string): string {
	if (defaultVal !== undefined) return defaultVal;
	if (type === "confirm") return "Y";
	if (type === "choice") return options?.[0] ?? "";
	return ""; // text
}

// ── Result helpers ────────────────────────────────────────────────────────────

function okResult(text: string): McpToolResult {
	return { content: [{ type: "text", text: text || "" }] };
}

function errResult(text: string): McpToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// ── Handler factory ───────────────────────────────────────────────────────────

/**
 * Create the forge_ask_user MCP handler. `server` is used to call
 * server.elicitInput() for interactive form mode.
 */
export function createAskUserHandler(
	server: Server,
): (args: Record<string, unknown>) => Promise<McpToolResult> {
	return async function askUserHandler(args: Record<string, unknown>): Promise<McpToolResult> {
		const question = String(args["question"] ?? "");
		const type = String(args["type"] ?? "text");
		const options = Array.isArray(args["options"]) ? (args["options"] as string[]) : undefined;
		const defaultVal = typeof args["default"] === "string" ? args["default"] : undefined;

		// Non-interactive bypass: env flag forces the default everywhere (CI mode).
		if (isNonInteractive()) {
			const fallback = computeFallback(type, options, defaultVal);
			process.stderr.write(
				`[forge:ask_user] non-interactive fallback — type=${type} question="${question}" default="${fallback}"\n`,
			);
			return okResult(fallback);
		}

		// Build the elicitation form params.
		const formParams: ElicitRequestFormParams = {
			message: question,
			requestedSchema: {
				type: "object",
				properties: {
					answer: buildAnswerSchema(type, options, question),
				},
				required: ["answer"],
			},
		};

		let result: ElicitResult;
		try {
			result = await server.elicitInput(formParams);
		} catch (err: unknown) {
			// Elicitation not supported by client (or other SDK error).
			process.stderr.write(
				`[forge:ask_user] elicitation unsupported — falling back to default: ${(err as { message?: string }).message}\n`,
			);
			return okResult(computeFallback(type, options, defaultVal));
		}

		if (result.action === "accept") {
			const answer = result.content?.["answer"];
			return okResult(answer !== undefined ? String(answer) : computeFallback(type, options, defaultVal));
		}

		if (result.action === "decline") {
			return errResult("User declined the question.");
		}

		// cancel — treat as non-interactive fallback
		return okResult(computeFallback(type, options, defaultVal));
	};
}

// ── Schema builder ────────────────────────────────────────────────────────────

type EnumPropertySchema = { type: "string"; enum: string[]; title?: string };
type TextPropertySchema = { type: "string"; title?: string };
type AnswerPropertySchema = EnumPropertySchema | TextPropertySchema;

function buildAnswerSchema(type: string, options: string[] | undefined, question: string): AnswerPropertySchema {
	if (type === "confirm") {
		return { type: "string" as const, enum: ["Y", "N"], title: question };
	}
	if (type === "choice" && options && options.length > 0) {
		return { type: "string" as const, enum: options, title: question };
	}
	// text (and choice with no options)
	return { type: "string" as const, title: question };
}
