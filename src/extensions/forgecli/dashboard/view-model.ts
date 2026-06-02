// dashboard/view-model.ts — ViewModel projection for the dashboard MVC.
//
// The ViewModel is a flat, pre-computed snapshot of the OrchestratorTree model.
// The DashboardController builds it on every model event; the
// DashboardComponent reads only from it — never directly from the model.
//
// This eliminates MVC boundary violations:
//   V1 (view reads model directly) — view reads only the VM via controller
//   V4 (controller reads model for queries) — controller reads from VM

import type { OrchestratorTree, NodeKind, NodeStatus, UsageSnapshot, NodeMetrics } from "../orchestrator-tree.js";

export interface NodeViewModel {
	id: string;
	label: string;
	kind: NodeKind;
	parentId: string | null;
	children: string[];
	status: NodeStatus;
	depth: number;
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
}

export interface TreeViewModel {
	/** Active root node IDs, in insertion order. */
	roots: string[];
	/** All projected nodes keyed by ID (reaches all descendants of active roots). */
	nodes: Map<string, NodeViewModel>;
}

/** Build a fresh TreeViewModel snapshot from the live model. */
export function buildViewModel(tree: OrchestratorTree): TreeViewModel {
	const nodes = new Map<string, NodeViewModel>();
	const roots = tree.getActiveRoots();

	// Walk all descendants of active roots.
	const stack: string[] = [];
	for (const root of roots) {
		stack.push(root.id);
	}

	while (stack.length > 0) {
		const id = stack.pop()!;
		const m = tree.getNode(id);
		if (!m) continue;

		const nvm: NodeViewModel = {
			id: m.id,
			label: m.label,
			kind: m.kind,
			parentId: m.parentId,
			children: [...m.children],
			status: m.status,
			depth: tree.getDepth(id),
			startedAt: m.startedAt,
			endedAt: m.endedAt,
			usage: { ...m.usage },
			model: m.model,
			provider: m.provider,
			compression: m.compression
				? { calls: m.compression.calls, tokensSaved: m.compression.tokensSaved }
				: undefined,
			metrics: { ...m.metrics },
			iteration: m.iteration,
			tailBuffer: [...m.tailBuffer],
			unreadWarnings: m.unreadWarnings,
			firstTurnPreview: m.firstTurnPreview,
			lastTurnPreview: m.lastTurnPreview,
			promptPreview: m.promptPreview,
			outcomePreview: m.outcomePreview,
		};
		nodes.set(id, nvm);
		stack.push(...m.children);
	}

	return { roots: roots.map((r) => r.id), nodes };
}