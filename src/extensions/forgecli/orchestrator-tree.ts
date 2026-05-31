// orchestrator-tree.ts — Generic observable tree for orchestrator > subagent
// visualization.
//
// Sibling to SessionRegistry (which drives the chip strip). The dashboard
// overlay reads from OrchestratorTree; the chip strip reads from
// SessionRegistry. Both are written to by the same orchestrator call-sites.
//
// The tree is depth-agnostic: Sprint>Tasks>Phases, Fix-bug>Phases, and
// standalone Run-task are all fan-out trees with the same node shape. Any
// future orchestrator (run-release, etc.) adds nodes without dashboard
// changes.
//
// Node IDs are dot/colon-separated paths for readability:
//   "FORGE-S27"                    — sprint root (orchestrator)
//   "FORGE-S27-T01"                — task (orchestrator)
//   "FORGE-S27-T01:plan:1"         — phase (leaf)
//   "FORGE-S27:ceremony"           — ceremony (leaf)
//
// LRU-capped at MAX_NODES to bound memory across long-running processes.
// Ring-buffer tail caps at MAX_TAIL_LINES_PER_NODE.

import { EventEmitter } from "node:events";

// ── Types ──────────────────────────────────────────────────────────────────

export type NodeKind = "orchestrator" | "leaf";
export type NodeStatus = "pending" | "running" | "cancelling" | "cancelled" | "completed" | "failed" | "escalated";

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
}

export interface NodeMetrics {
	turn: number;
	toolCount: number;
	errCount: number;
}

export interface OrchestratorNode {
	id: string;
	label: string;
	kind: NodeKind;
	parentId: string | null;
	children: string[];
	status: NodeStatus;
	startedAt: number;
	endedAt?: number;
	usage: UsageSnapshot;
	model?: string;
	provider?: string;
	compression?: { calls: number; tokensSaved: number };
	metrics: NodeMetrics;
	iteration?: number;
	tailBuffer: string[];
	unreadWarnings: number;
	firstTurnPreview?: string;
	lastTurnPreview?: string;
	promptPreview?: string;
	outcomePreview?: string;
	abortController?: AbortController;
}

export interface StartNodeOptions {
	parentId?: string;
	label?: string;
	kind?: NodeKind;
	promptPreview?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_NODES = 50;
const MAX_TAIL_LINES_PER_NODE = 2048;
const MAX_TAIL_APPEND = 500; // per-append cap before trimming

// ── OrchestratorTree ───────────────────────────────────────────────────────

export class OrchestratorTree extends EventEmitter {
	private nodes = new Map<string, OrchestratorNode>();
	private roots = new Set<string>();

	// ── Mutation: lifecycle ────────────────────────────────────────────────

	startNode(id: string, opts: StartNodeOptions = {}): OrchestratorNode {
		const existing = this.nodes.get(id);
		if (existing) {
			// Resume — refresh status and timestamps, keep events for visibility.
			existing.status = "running";
			existing.startedAt = Date.now();
			existing.endedAt = undefined;
			existing.abortController = new AbortController();
			this.emit("change", id);
			this.emit("tree", id);
			return existing;
		}

		const node: OrchestratorNode = {
			id,
			label: opts.label ?? id,
			kind: opts.kind ?? "leaf",
			parentId: opts.parentId ?? null,
			children: [],
			status: "running",
			startedAt: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0 },
			metrics: { turn: 0, toolCount: 0, errCount: 0 },
			tailBuffer: [],
			unreadWarnings: 0,
			abortController: new AbortController(),
		};

		if (opts.promptPreview) {
			node.promptPreview = opts.promptPreview;
		}

		// Link to parent.
		if (node.parentId) {
			const parent = this.nodes.get(node.parentId);
			if (parent) {
				parent.children.push(id);
			}
		} else {
			this.roots.add(id);
		}

		this.nodes.set(id, node);
		this.evictIfNeeded();
		this.emit("change", id);
		this.emit("tree", id);
		return node;
	}

	completeNode(id: string, status: NodeStatus): void {
		const node = this.nodes.get(id);
		if (!node) return;
		// Idempotent for terminal states — don't clobber a success-path mark.
		if (node.status !== "running" && node.status !== "cancelling") return;
		node.status = status;
		node.endedAt = Date.now();
		node.abortController = undefined;
		this.emit("change", id);
	}

	// ── Mutation: telemetry ─────────────────────────────────────────────────

	setNodeUsage(id: string, usage: UsageSnapshot): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead };
		this.emit("change", id);
	}

	setNodeModel(id: string, model: string, provider: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		// Only emit when the value actually changes — turn_end fires every
		// turn and the model is stable across a phase.
		if (node.provider === provider && node.model === model) return;
		node.model = model;
		node.provider = provider;
		this.emit("change", id);
	}

	setNodeCompression(id: string, compression: { calls: number; tokensSaved: number }): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.compression = { calls: compression.calls, tokensSaved: compression.tokensSaved };
		this.emit("change", id);
	}

	bumpNodeTurn(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.metrics.turn++;
		this.emit("change", id);
	}

	incrementNodeToolCount(id: string, delta = 1): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.metrics.toolCount += delta;
		this.emit("change", id);
	}

	incrementNodeErrCount(id: string, delta = 1): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.metrics.errCount += delta;
		this.emit("change", id);
	}

	setNodeIteration(id: string, iteration: number): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.iteration = iteration;
		this.emit("change", id);
	}

	setNodeOutcome(id: string, preview: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.outcomePreview = preview;
		this.emit("change", id);
	}

	// ── Mutation: tail buffer ───────────────────────────────────────────────

	appendTail(id: string, line: string, opts?: { warning?: boolean }): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.tailBuffer.push(line);
		if (node.tailBuffer.length > MAX_TAIL_LINES_PER_NODE) {
			node.tailBuffer.splice(0, node.tailBuffer.length - MAX_TAIL_LINES_PER_NODE);
		}
		if (opts?.warning) node.unreadWarnings++;
		this.emit("tail", id);
	}

	markTailRead(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		if (node.unreadWarnings === 0) return;
		node.unreadWarnings = 0;
		this.emit("change", id);
	}

	setTurnPreview(id: string, preview: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		if (node.lastTurnPreview === preview) return;
		node.lastTurnPreview = preview;
		if (node.firstTurnPreview === undefined) node.firstTurnPreview = preview;
		this.emit("preview", id);
	}

	// ── Mutation: cancellation ───────────────────────────────────────────────

	requestCancel(id: string): boolean {
		const node = this.nodes.get(id);
		if (!node) return false;
		if (node.status !== "running") return false;
		node.status = "cancelling";
		node.abortController?.abort();
		this.emit("change", id);
		return true;
	}

	getAbortSignal(id: string): AbortSignal | undefined {
		return this.nodes.get(id)?.abortController?.signal;
	}

	// ── Queries ──────────────────────────────────────────────────────────────

	getNode(id: string): OrchestratorNode | undefined {
		return this.nodes.get(id);
	}

	getChildren(id: string): OrchestratorNode[] {
		const node = this.nodes.get(id);
		if (!node) return [];
		return node.children
			.map((cid) => this.nodes.get(cid))
			.filter((n): n is OrchestratorNode => n !== undefined);
	}

	getAncestors(id: string): OrchestratorNode[] {
		const result: OrchestratorNode[] = [];
		let current = this.nodes.get(id);
		while (current?.parentId) {
			const parent = this.nodes.get(current.parentId);
			if (parent) result.push(parent);
			current = parent;
		}
		return result;
	}

	getRoots(): OrchestratorNode[] {
		return [...this.roots]
			.map((id) => this.nodes.get(id))
			.filter((n): n is OrchestratorNode => n !== undefined);
	}

	getSubtreeUsage(id: string): UsageSnapshot {
		const agg: UsageSnapshot = { input: 0, output: 0, cacheRead: 0 };
		const stack = [id];
		while (stack.length > 0) {
			const current = stack.pop()!;
			const node = this.nodes.get(current);
			if (!node) continue;
			agg.input += node.usage.input;
			agg.output += node.usage.output;
			agg.cacheRead += node.usage.cacheRead;
			stack.push(...node.children);
		}
		return agg;
	}

	getSubtreeProgress(id: string): { completed: number; total: number } {
		let completed = 0;
		let total = 0;
		const stack = [id];
		while (stack.length > 0) {
			const current = stack.pop()!;
			const node = this.nodes.get(current);
			if (!node) continue;
			if (node.kind === "leaf") {
				total++;
				if (node.status === "completed") completed++;
			}
			stack.push(...node.children);
		}
		return { completed, total };
	}

	/** Depth of a node (root = 0). Useful for tree indentation. */
	getDepth(id: string): number {
		let depth = 0;
		let current = this.nodes.get(id);
		while (current?.parentId) {
			depth++;
			current = this.nodes.get(current.parentId);
		}
		return depth;
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private evictIfNeeded(): void {
		if (this.nodes.size <= MAX_NODES) return;
		// Evict the oldest completed/failed/cancelled root node.
		const roots = this.getRoots();
		const evictable = roots
			.filter(
				(r) =>
					r.status === "completed" ||
					r.status === "failed" ||
					r.status === "cancelled" ||
					r.status === "escalated",
			)
			.sort((a, b) => a.startedAt - b.startedAt);
		if (evictable.length === 0) return;
		const victim = evictable[0]!;
		this.removeSubtree(victim.id);
	}

	private removeSubtree(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		// Remove all descendants first.
		for (const childId of [...node.children]) {
			this.removeSubtree(childId);
		}
		// Unlink from parent.
		if (node.parentId) {
			const parent = this.nodes.get(node.parentId);
			if (parent) {
				parent.children = parent.children.filter((cid) => cid !== id);
			}
		} else {
			this.roots.delete(id);
		}
		this.nodes.delete(id);
	}
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _tree: OrchestratorTree | undefined;

export function getOrchestratorTree(): OrchestratorTree {
	if (!_tree) _tree = new OrchestratorTree();
	return _tree;
}