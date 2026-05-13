// session-registry.ts — in-memory store of live run-task subagent sessions.
//
// Single source of truth that the session-monitor widget subscribes to.
// run-task.ts pushes events here; the widget renders from here. No disk I/O
// — the JSONL debug log at .forge/cache/run-task-debug-<taskId>.jsonl handles
// durable history. This registry is for the live in-process picture only.
//
// LRU-capped at MAX_SESSIONS to bound memory across long-running forge processes.

import { EventEmitter } from "node:events";

export interface PhaseSummary {
	role: string;
	index: number;
	startedAt: number;
	endedAt?: number;
	status: "running" | "completed" | "failed" | "skipped";
	turn: number;
	toolCount: number;
	errCount: number;
}

export interface ToolEventRecord {
	ts: number;
	kind: "tool_start" | "tool_end";
	phaseRole: string;
	toolName: string;
	toolCallId: string;
	args?: unknown;
	isError?: boolean;
	result?: unknown;
}

export interface SessionState {
	taskId: string;
	startedAt: number;
	updatedAt: number;
	status: "running" | "completed" | "failed" | "escalated";
	currentPhaseRole?: string;
	phases: PhaseSummary[];
	events: ToolEventRecord[];
}

const MAX_SESSIONS = 20;
const MAX_EVENTS_PER_SESSION = 500;

export class SessionRegistry extends EventEmitter {
	private sessions = new Map<string, SessionState>();

	getSession(taskId: string): SessionState | undefined {
		return this.sessions.get(taskId);
	}

	listSessions(): SessionState[] {
		// Most recently updated first.
		return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	startSession(taskId: string): void {
		const now = Date.now();
		const existing = this.sessions.get(taskId);
		if (existing) {
			// Resume — refresh status, keep prior events for visibility.
			existing.status = "running";
			existing.updatedAt = now;
		} else {
			this.sessions.set(taskId, {
				taskId,
				startedAt: now,
				updatedAt: now,
				status: "running",
				phases: [],
				events: [],
			});
			this.evictIfNeeded();
		}
		this.emit("change", taskId);
	}

	startPhase(taskId: string, role: string, phaseIndex: number): void {
		const s = this.sessions.get(taskId);
		if (!s) return;
		s.currentPhaseRole = role;
		s.updatedAt = Date.now();
		s.phases.push({
			role,
			index: phaseIndex,
			startedAt: Date.now(),
			status: "running",
			turn: 0,
			toolCount: 0,
			errCount: 0,
		});
		this.emit("change", taskId);
	}

	bumpTurn(taskId: string): void {
		const s = this.sessions.get(taskId);
		const p = s?.phases[s.phases.length - 1];
		if (!s || !p) return;
		p.turn++;
		s.updatedAt = Date.now();
		this.emit("change", taskId);
	}

	recordToolStart(
		taskId: string,
		toolCallId: string,
		toolName: string,
		args: unknown,
	): void {
		const s = this.sessions.get(taskId);
		const p = s?.phases[s.phases.length - 1];
		if (!s || !p) return;
		p.toolCount++;
		s.updatedAt = Date.now();
		s.events.push({
			ts: Date.now(),
			kind: "tool_start",
			phaseRole: p.role,
			toolName,
			toolCallId,
			args,
		});
		this.trimEvents(s);
		this.emit("change", taskId);
	}

	recordToolEnd(
		taskId: string,
		toolCallId: string,
		toolName: string,
		isError: boolean,
		result: unknown,
	): void {
		const s = this.sessions.get(taskId);
		const p = s?.phases[s.phases.length - 1];
		if (!s || !p) return;
		if (isError) p.errCount++;
		s.updatedAt = Date.now();
		s.events.push({
			ts: Date.now(),
			kind: "tool_end",
			phaseRole: p.role,
			toolName,
			toolCallId,
			isError,
			result,
		});
		this.trimEvents(s);
		this.emit("change", taskId);
	}

	completePhase(taskId: string, role: string, status: PhaseSummary["status"]): void {
		const s = this.sessions.get(taskId);
		const p = s?.phases[s.phases.length - 1];
		if (!s || !p || p.role !== role) return;
		p.endedAt = Date.now();
		p.status = status;
		s.updatedAt = Date.now();
		this.emit("change", taskId);
	}

	completeSession(taskId: string, status: SessionState["status"]): void {
		const s = this.sessions.get(taskId);
		if (!s) return;
		// Idempotent: once a session is in a terminal state, don't transition
		// it again. This lets every early-return path in run-task.ts blindly
		// call completeSession("failed") without clobbering the success-path's
		// prior "completed" mark.
		if (s.status !== "running") return;
		s.status = status;
		s.currentPhaseRole = undefined;
		s.updatedAt = Date.now();
		this.emit("change", taskId);
	}

	private trimEvents(s: SessionState): void {
		if (s.events.length > MAX_EVENTS_PER_SESSION) {
			s.events.splice(0, s.events.length - MAX_EVENTS_PER_SESSION);
		}
	}

	private evictIfNeeded(): void {
		if (this.sessions.size <= MAX_SESSIONS) return;
		const sorted = [...this.sessions.entries()].sort(
			(a, b) => a[1].updatedAt - b[1].updatedAt,
		);
		const toRemove = sorted.slice(0, this.sessions.size - MAX_SESSIONS);
		for (const [id] of toRemove) this.sessions.delete(id);
	}
}

let _registry: SessionRegistry | undefined;

export function getSessionRegistry(): SessionRegistry {
	if (!_registry) _registry = new SessionRegistry();
	return _registry;
}
