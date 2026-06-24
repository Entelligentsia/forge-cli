// viewport/events.ts
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

import * as fs from "node:fs";
import type { SessionRegistry } from "../session-registry.js";
import { getOrchestratorTree } from "../orchestrator-tree.js";
import {
	argContent as fmtArgContent,
	extractAssistantText,
	extractThinkingOneLiner,
	extractThinkingText,
	extractTurnPreview,
	argHint as fmtArgHint,
	RISKY_TAG,
	readUsage,
	resultShape,
	toolGlyph,
	type UsageDelta,
} from "./renderer.js";

/** Minimal shape of the AgentSessionEvent union we care about — kept loose
 * so the file doesn't pull in @earendil-works/pi-agent-core types at compile
 * time for callers that only consume the factory. */
type SubagentEvent =
	| { type: "turn_start" }
	| { type: "message_end"; message: unknown }
	| { type: "turn_end"; message: unknown }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "compaction_start"; reason: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage?: string }
	| { type: string; [k: string]: unknown };

function extractCompression(result: unknown): { tool: string; before: number; after: number; saved: number } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as { details?: { compression?: { tool?: string; before?: number; after?: number; saved?: number } } };
	const c = r.details?.compression;
	if (!c || typeof c.before !== "number" || typeof c.after !== "number") return undefined;
	return { tool: c.tool ?? "", before: c.before, after: c.after, saved: c.saved ?? 0 };
}

export interface ViewportObserverOpts {
	registry: SessionRegistry;
	/** session key in the registry (taskId, bugId, or sprintId:ceremony, etc.) */
	sessionId: string;
	/** phase scope for tail buffer and per-phase usage */
	phaseRole: string;
	/** Exact OrchestratorTree node ID for this dispatch. Orchestrators know
	 * the node they started (`<sessionId>:<role>:<attempt>`) — passing it pins
	 * every telemetry event to that node. Without it the observer falls back
	 * to a role-prefix scan for the first *running* match, which misattributes
	 * telemetry whenever an earlier same-role node is still open (the
	 * CART-BUG-003 dashboard regression: review-plan:2's logs accumulated on a
	 * leaked review-plan:1). */
	nodeId?: string;
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

/** One persisted tail-view line — exactly what the live dashboard rendered. */
export interface TailLogEntry {
	line: string;
	warning?: boolean;
}

/**
 * Head-preserving cap on the recorded tail log. Live phases rarely exceed a
 * few hundred lines; the cap only bounds pathological runs. Head-preserving
 * (stop recording, don't drop oldest) because the log's consumer is the
 * transcript-archive REPLAY, where the beginning is the valuable part.
 */
export const TAIL_LOG_CAP = 5000;

export interface AttachedObserver {
	onEvent: (event: SubagentEvent) => void;
	/** Mutable counters orchestrator can read after subagent returns. */
	state: {
		turn: number;
		toolCount: number;
		errCount: number;
		lastTool: string;
		cumUsage: UsageDelta;
		cumCompression: { calls: number; tokensSaved: number };
		/**
		 * Verbatim record of every tail line this observer rendered, in
		 * order — the live view stream. Orchestrators persist it next to
		 * the phase transcript (`<transcript>.tail.jsonl`) so transcript
		 * replay re-reads the EXACT lines the live dashboard showed
		 * instead of reconstructing an approximation from messages.
		 */
		tailLog: TailLogEntry[];
	};
}

/**
 * Persist the recorded tail log next to its phase transcript as JSONL
 * (`<transcript-base>.tail.jsonl`). The transcript archive sweeps it with
 * the run; replay re-reads the exact lines the live dashboard showed.
 * Best-effort — observability data, never throws.
 */
export function persistTailLog(subagentTranscriptPath: string, tailLog: TailLogEntry[]): string | null {
	if (!subagentTranscriptPath.endsWith(".json") || tailLog.length === 0) return null;
	try {
		const outPath = `${subagentTranscriptPath.slice(0, -".json".length)}.tail.jsonl`;
		fs.writeFileSync(outPath, `${tailLog.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
		return outPath;
	} catch {
		return null;
	}
}

export function attachViewportObserver(opts: ViewportObserverOpts): AttachedObserver {
	const {
		registry,
		sessionId,
		phaseRole,
		displayRole,
		beginHeader,
		writeDebug,
		setStatusVerbose,
		notify,
		verboseKeys,
		afterEach,
		nodeId: pinnedNodeId,
	} = opts;
	const role = displayRole ?? phaseRole;

	const tree = getOrchestratorTree();

	// Helper to resolve the correct active node ID in the OrchestratorTree.
	// When the caller pins the dispatch node, attribution is fixed — never
	// re-resolved by scan (node-per-dispatch contract). The scan below is the
	// legacy fallback for callers that don't pass nodeId.
	const resolveNodeId = (): string => {
		if (pinnedNodeId) return pinnedNodeId;
		const exactId = `${sessionId}:${phaseRole}`;
		const exactNode = tree.getNode(exactId);
		if (exactNode && exactNode.status === "running") return exactId;

		const parentNode = tree.getNode(sessionId);
		if (parentNode) {
			const prefix = `${sessionId}:${phaseRole}:`;
			for (const cid of parentNode.children) {
				if (cid.startsWith(prefix)) {
					const child = tree.getNode(cid);
					if (child && child.status === "running") {
						return cid;
					}
				}
			}
		}
		return exactId;
	};

	const state = {
		turn: 0,
		toolCount: 0,
		errCount: 0,
		lastTool: "",
		cumUsage: { input: 0, output: 0, cacheRead: 0 } as UsageDelta,
		cumCompression: { calls: 0, tokensSaved: 0 },
		tailLog: [] as TailLogEntry[],
	};

	// Per-turn tree-connector state.
	let toolsThisTurn = 0;
	let firstLineOfTurn = true;
	const argsByCallId = new Map<string, unknown>();

	const formatTime = (ms: number): string => {
		const d = new Date(ms);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	};
	// Compact turn stamp. No phase/role prefix — the tail renders inside a
	// phase-scoped context (dashboard node / phase tail view), so repeating
	// the role on every turn wastes log width.
	const tailPrefix = () => `[T${state.turn}:${formatTime(Date.now())}]`;
	const appendTail = (line: string, opts?: { warning?: boolean }) => {
		registry.appendTail(sessionId, phaseRole, line, opts);
		tree.appendTail(resolveNodeId(), line, opts);
		// Record the exact rendered line for post-run persistence (replay).
		if (state.tailLog.length < TAIL_LOG_CAP) {
			state.tailLog.push(opts?.warning ? { line, warning: true } : { line });
		} else if (state.tailLog.length === TAIL_LOG_CAP) {
			state.tailLog.push({ line: `… tail log capped at ${TAIL_LOG_CAP} lines` });
		}
	};
	const rawErrorText = (result: unknown): string =>
		typeof result === "string"
			? result
			: typeof result === "object" && result !== null
				? JSON.stringify(result)
				: String(result);
	// Short form for single-line UI surfaces (status/notify); the activity-log
	// entry carries the full error — clamping is the view's decision.
	const extractErrorSummary = (result: unknown): string => {
		const raw = rawErrorText(result);
		const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? raw;
		return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
	};

	// Turn grouping: bracket glyphs flush left on every line; the compact turn
	// stamp rides inside the first line. No left margin on continuation lines —
	// the full pane width carries log content.
	//   ╭ [T18:06:44:22] $ bash …
	//   │ ← bash ok 29L
	//   ╰ » "next step …"
	const emitTurnLine = (body: string, lineOpts?: { warning?: boolean; closing?: boolean }) => {
		const isFirst = firstLineOfTurn;
		const isClosing = lineOpts?.closing === true;
		let branch: string;
		if (isFirst && isClosing) branch = "─";
		else if (isFirst) branch = "╭";
		else if (isClosing) branch = "╰";
		else branch = "│";

		const stamp = isFirst ? ` ${tailPrefix()}` : "";
		firstLineOfTurn = false;
		appendTail(`${branch}${stamp} ${body}`, lineOpts?.warning ? { warning: true } : undefined);
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
				tree.bumpNodeTurn(resolveNodeId());
				break;
			}
			case "message_end": {
				// The assistant message (thinking → text → tool_use blocks)
				// lands here, BEFORE tool_execution_start fires. Emitting the
				// reasoning + narration now — as the turn's OPENING lines —
				// keeps the tail in true chronological order: the model's
				// "let me check X" sits ABOVE the tool it motivates instead of
				// trailing the tool result as a footer (the intra-turn reversal
				// users hit). Both are stored VERBATIM (no length cap, newlines
				// preserved); the dashboard clamps to LOG_CLAMP_ROWS and ctrl+o
				// expands, so nothing is lost from the saved transcript.
				const e = event as { message: unknown };
				const thinking = extractThinkingText(e.message as never);
				if (thinking) emitTurnLine(`✱ ${thinking}`);
				const narration = extractAssistantText(e.message);
				if (narration) emitTurnLine(`» ${narration}`);
				break;
			}
			case "turn_end": {
				const e = event as { message: unknown };
				const delta = readUsage(e.message as never);
				state.cumUsage.input += delta.input;
				state.cumUsage.output += delta.output;
				state.cumUsage.cacheRead += delta.cacheRead;
				registry.setPhaseUsage(sessionId, phaseRole, state.cumUsage);
				const nodeId = resolveNodeId();
				tree.setNodeUsage(nodeId, state.cumUsage);

				// Capture which (provider, model) actually served this turn so
				// the per-phase tail-view footer can display it. Cheap; the
				// registry no-ops when the value hasn't changed.
				const msg = e.message as { provider?: string; model?: string } | undefined;
				if (msg && (msg.provider || msg.model)) {
					registry.setPhaseModel(sessionId, phaseRole, {
						provider: msg.provider,
						model: msg.model,
					});
					tree.setNodeModel(nodeId, msg.model ?? "", msg.provider ?? "");
				}

				// The full narration/thinking already streamed to the tail at
				// message_end. Here we only set the COMPACT single-line label
				// that the registry/tree node and the consolidated turn event
				// surface (status line, dashboard node label) — these are
				// fixed-width breadcrumbs, not transcript content.
				const preview = extractTurnPreview(e.message);
				if (preview) {
					registry.setTurnPreview(sessionId, preview);
					tree.setTurnPreview(nodeId, preview);
					if (setStatusVerbose && verboseKeys?.messageKey) {
						setStatusVerbose(verboseKeys.messageKey, `  "${preview}"`);
					}
				}
				const thinkingPreview = extractThinkingOneLiner(e.message as never);
				if (toolsThisTurn > 1) {
					emitTurnLine(`⇉ batched ${toolsThisTurn} tool calls in turn ${state.turn}`, { closing: true });
				}

				// Bubble one consolidated event up to the registry so the
				// top-level viewport can surface activity from any subagent
				// with subagent-identified attribution.
				registry.recordTurnEvent({
					sessionId,
					phaseRole,
					displayRole: role,
					turn: state.turn,
					preview: preview ?? "",
					thinking: thinkingPreview ?? "",
					deltaUsage: { ...delta },
					cumUsage: { ...state.cumUsage },
					timestamp: Date.now(),
				});
				break;
			}
			case "tool_execution_start": {
				const e = event as { toolCallId: string; toolName: string; args: unknown };
				state.toolCount++;
				toolsThisTurn++;
				argsByCallId.set(e.toolCallId, e.args);
				// Status line gets a short hint (single-line UI constraint of
				// setStatus); the activity-log entry carries the FULL argument
				// content — display clamping/expansion is the view's decision.
				const hint = fmtArgHint(e.toolName, e.args);
				const content = fmtArgContent(e.toolName, e.args);
				const { glyph, risky } = toolGlyph(e.toolName, e.args);
				state.lastTool = `${e.toolName}${hint ? ` ${hint}` : ""}`;
				writeDebug?.({
					kind: "tool_start",
					toolName: e.toolName,
					toolCallId: e.toolCallId,
					args: e.args,
				});
				registry.recordToolStart(sessionId, e.toolCallId, e.toolName, e.args);
				tree.incrementNodeToolCount(resolveNodeId());
				const riskPrefix = risky ? `${RISKY_TAG} ` : "";
				emitTurnLine(
					`${riskPrefix}${glyph} ${e.toolName}${content ? ` ${content}` : ""}`,
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
				const nodeId = resolveNodeId();
				if (e.isError) {
					state.errCount++;
					tree.incrementNodeErrCount(nodeId);
					emitTurnLine(`⚠ ${e.toolName} failed: ${rawErrorText(e.result)}`, { warning: true });
				} else {
					const shape = resultShape(e.toolName, e.result);
					const comp = extractCompression(e.result);
					const compHint = comp ? ` ⇌${comp.saved}%` : "";
					emitTurnLine(`← ${e.toolName} ok${shape ? ` ${shape}` : ""}${compHint}`);
					if (comp) {
						state.cumCompression.calls++;
						state.cumCompression.tokensSaved += comp.before - comp.after;
						registry.setPhaseCompression(sessionId, phaseRole, state.cumCompression);
						tree.setNodeCompression(nodeId, state.cumCompression);
					}
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
				notify?.(`↻ ${role}: model retry ${e.attempt}/${e.maxAttempts}${err ? `\n${err}` : ""}`, "warning");
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
