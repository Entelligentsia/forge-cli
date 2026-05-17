// viewport-events.ts
//
// Reusable subagent event observer. Wires `runForgeSubagent.onEvent` to:
//   1. Append per-event tail lines (with tree connectors, glyphs, risky tag,
//      thinking one-liners, batch markers) into SessionRegistry.
//   2. Maintain cumulative phase token usage and push it to the registry on
//      every turn_end — drives the sticky footer in the tail view AND the
//      aggregate Σ meter in the chip strip.
//   3. Surface counts (turn / tools / errors) so the orchestrator can render
//      its end-of-phase summary.
//
// Used by run-task, fix-bug, and run-sprint (ceremony) so every subagent
// "bubbles" usage up the same way. Top-level viewports read aggregate usage
// via SessionRegistry.getAggregateUsage().

import type { SessionRegistry } from "./session-registry.js";
import {
	argHint as fmtArgHint,
	extractThinkingOneLiner,
	extractTurnPreview,
	readUsage,
	resultShape,
	RISKY_TAG,
	toolGlyph,
	type UsageDelta,
} from "./viewport-renderer.js";

/** Minimal shape of the AgentSessionEvent union we care about — kept loose
 * so the file doesn't pull in @earendil-works/pi-agent-core types at compile
 * time for callers that only consume the factory. */
type SubagentEvent =
	| { type: "turn_start" }
	| { type: "turn_end"; message: unknown }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "compaction_start"; reason: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage?: string }
	| { type: string; [k: string]: unknown };

export interface ViewportObserverOpts {
	registry: SessionRegistry;
	/** session key in the registry (taskId, bugId, or sprintId:ceremony, etc.) */
	sessionId: string;
	/** phase scope for tail buffer and per-phase usage */
	phaseRole: string;
	/** displayed in the per-line prefix `[<displayRole> HH:MM:SS tN]`. Usually same
	 * as `phaseRole` but kept separate so callers like run-sprint ceremony can
	 * show a friendlier role label without changing the registry key. */
	displayRole?: string;
	/** optional `─── phase X/Y begin · sessionId ───` header to emit immediately */
	beginHeader?: string;
	/** optional JSONL audit sink (the run-task debug log). */
	writeDebug?: (rec: Record<string, unknown>) => void;
	/** optional verbose status setter — only called when FORGE_VERBOSE=1.
	 * The observer doesn't read FORGE_VERBOSE itself; caller decides whether to
	 * wire this. */
	setStatusVerbose?: (key: string, msg: string) => void;
	/** optional toast for compaction/retry; ignore to suppress. */
	notify?: (msg: string, level: "info" | "warning" | "error") => void;
	/** keys used for `setStatusVerbose` when caller wants verbose status. */
	verboseKeys?: { messageKey?: string };
	/** invoked after every handled event so orchestrators can refresh their own
	 * status line (e.g. FORGE_VERBOSE status with `lastTool`, elapsed seconds). */
	afterEach?: () => void;
}

export interface AttachedObserver {
	onEvent: (event: SubagentEvent) => void;
	/** Mutable counters orchestrator can read after subagent returns. */
	state: {
		turn: number;
		toolCount: number;
		errCount: number;
		lastTool: string;
		cumUsage: UsageDelta;
	};
}

export function attachViewportObserver(opts: ViewportObserverOpts): AttachedObserver {
	const { registry, sessionId, phaseRole, displayRole, beginHeader, writeDebug, setStatusVerbose, notify, verboseKeys, afterEach } = opts;
	const role = displayRole ?? phaseRole;

	const state = {
		turn: 0,
		toolCount: 0,
		errCount: 0,
		lastTool: "",
		cumUsage: { input: 0, output: 0, cacheRead: 0 } as UsageDelta,
	};

	// Per-turn tree-connector state.
	let toolsThisTurn = 0;
	let firstLineOfTurn = true;
	let currentTurnPrefixWidth = 0;
	const argsByCallId = new Map<string, unknown>();

	const formatTime = (ms: number): string => {
		const d = new Date(ms);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	};
	const tailPrefix = () => `[${role} ${formatTime(Date.now())} t${state.turn}]`;
	const appendTail = (line: string, opts?: { warning?: boolean }) => {
		registry.appendTail(sessionId, phaseRole, line, opts);
	};
	const extractErrorSummary = (result: unknown): string => {
		const raw =
			typeof result === "string"
				? result
				: typeof result === "object" && result !== null
				? JSON.stringify(result)
				: String(result);
		const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? raw;
		return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
	};

	const emitTurnLine = (body: string, lineOpts?: { warning?: boolean; closing?: boolean }) => {
		const isFirst = firstLineOfTurn;
		const isClosing = lineOpts?.closing === true;
		let branch: string;
		if (isFirst && isClosing) branch = "─";
		else if (isFirst) branch = "╭";
		else if (isClosing) branch = "╰";
		else branch = "│";

		let prefix: string;
		if (isFirst) {
			prefix = tailPrefix();
			currentTurnPrefixWidth = prefix.length;
		} else {
			prefix = " ".repeat(currentTurnPrefixWidth);
		}
		firstLineOfTurn = false;
		appendTail(`${prefix} ${branch} ${body}`, lineOpts?.warning ? { warning: true } : undefined);
	};

	if (beginHeader) appendTail(`${tailPrefix()} ${beginHeader}`);

	const onEvent = (event: SubagentEvent): void => {
		switch (event.type) {
			case "turn_start": {
				state.turn++;
				state.lastTool = "";
				toolsThisTurn = 0;
				firstLineOfTurn = true;
				registry.bumpTurn(sessionId);
				break;
			}
			case "turn_end": {
				const e = event as { message: unknown };
				const delta = readUsage(e.message as never);
				state.cumUsage.input += delta.input;
				state.cumUsage.output += delta.output;
				state.cumUsage.cacheRead += delta.cacheRead;
				registry.setPhaseUsage(sessionId, phaseRole, state.cumUsage);

				const closingBodies: string[] = [];
				const thinking = extractThinkingOneLiner(e.message as never);
				if (thinking) closingBodies.push(`✱ ${thinking}`);

				const preview = extractTurnPreview(e.message);
				if (preview) {
					registry.setTurnPreview(sessionId, preview);
					if (setStatusVerbose && verboseKeys?.messageKey) {
						setStatusVerbose(verboseKeys.messageKey, `  "${preview}"`);
					}
					closingBodies.push(`» "${preview}"`);
				}
				if (toolsThisTurn > 1) {
					closingBodies.push(`⇉ batched ${toolsThisTurn} tool calls in turn ${state.turn}`);
				}
				for (let i = 0; i < closingBodies.length; i++) {
					const isLast = i === closingBodies.length - 1;
					emitTurnLine(closingBodies[i], { closing: isLast });
				}
				break;
			}
			case "tool_execution_start": {
				const e = event as { toolCallId: string; toolName: string; args: unknown };
				state.toolCount++;
				toolsThisTurn++;
				argsByCallId.set(e.toolCallId, e.args);
				const hint = fmtArgHint(e.toolName, e.args);
				const { glyph, risky } = toolGlyph(e.toolName, e.args);
				state.lastTool = `${e.toolName}${hint ? ` ${hint}` : ""}`;
				writeDebug?.({
					kind: "tool_start",
					toolName: e.toolName,
					toolCallId: e.toolCallId,
					args: e.args,
				});
				registry.recordToolStart(sessionId, e.toolCallId, e.toolName, e.args);
				const riskPrefix = risky ? `${RISKY_TAG} ` : "";
				emitTurnLine(
					`${riskPrefix}${glyph} ${e.toolName}${hint ? ` ${hint}` : ""}`,
					risky ? { warning: true } : undefined,
				);
				break;
			}
			case "tool_execution_end": {
				const e = event as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
				argsByCallId.delete(e.toolCallId);
				writeDebug?.({
					kind: "tool_end",
					toolName: e.toolName,
					toolCallId: e.toolCallId,
					isError: e.isError,
					result: e.result,
				});
				registry.recordToolEnd(sessionId, e.toolCallId, e.toolName, e.isError, e.result);
				if (e.isError) {
					state.errCount++;
					emitTurnLine(
						`⚠ ${e.toolName} failed: ${extractErrorSummary(e.result)}`,
						{ warning: true },
					);
				} else {
					const shape = resultShape(e.toolName, e.result);
					emitTurnLine(`← ${e.toolName} ok${shape ? ` ${shape}` : ""}`);
				}
				break;
			}
			case "compaction_start": {
				const e = event as { reason: string };
				notify?.(`◌ ${role}: context compacting (${e.reason})…`, "info");
				appendTail(`${tailPrefix()} ◌ compacting (${e.reason})`);
				break;
			}
			case "auto_retry_start": {
				const e = event as { attempt: number; maxAttempts: number; errorMessage?: string };
				const err = e.errorMessage ?? "";
				notify?.(
					`↻ ${role}: model retry ${e.attempt}/${e.maxAttempts}${err ? `\n${err}` : ""}`,
					"warning",
				);
				appendTail(
					`${tailPrefix()} ↻ retry ${e.attempt}/${e.maxAttempts}${err ? `: ${extractErrorSummary(err)}` : ""}`,
					{ warning: true },
				);
				break;
			}
		}
		afterEach?.();
	};

	return { onEvent, state };
}
