/**
 * Spike R4 — permission semantics (block + ui.confirm composition).
 *
 * FORGE-S15-T07 — Discharges architectural-review.md §R4 by exercising the
 * two pi v0.73 permission surfaces independently:
 *
 *   1. Hard block: a `pi.on("tool_call")` handler returns
 *      `{ block: true, reason }` when an agent tries to `write` or `edit`
 *      a path under `.forge/store/`. The model receives `reason` as the tool
 *      result; execution is prevented.
 *
 *   2. Soft confirm: a registered slash command
 *      `/forge:poc-confirm-destructive` composes `ctx.ui.confirm(...)` from
 *      `ExtensionUIContext`. On `true` it proceeds with `notify(... "info")`,
 *      on `false` it aborts with `notify("aborted","warning")`.
 *
 * No production code touched. Future `forge-permissions.json` shape sketched
 * in RESULT.md; loader implementation deferred to Stage 3.
 */

import path from "node:path";
import type {
	EditToolCallEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	ToolCallEvent,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Evidence record — populated by handler invocations
// ---------------------------------------------------------------------------

export interface SpikeR4BlockObservation {
	toolName: string;
	filePath: string;
	decision: "block" | "passthrough";
	reason?: string;
}

export interface SpikeR4NotifyObservation {
	message: string;
	type: "info" | "warning" | "error";
}

export interface SpikeR4Evidence {
	blockObservations: SpikeR4BlockObservation[];
	confirmDecisions: Array<"approved" | "aborted">;
	notifyCalls: SpikeR4NotifyObservation[];
}

let evidence: SpikeR4Evidence = freshEvidence();

function freshEvidence(): SpikeR4Evidence {
	return {
		blockObservations: [],
		confirmDecisions: [],
		notifyCalls: [],
	};
}

export function getEvidence(): SpikeR4Evidence {
	return evidence;
}

export function resetEvidence(): void {
	evidence = freshEvidence();
}

// ---------------------------------------------------------------------------
// Capture mechanism — records what the spike registers so tests can pull
// the handler/command back out without booting a real pi runtime.
// ---------------------------------------------------------------------------

export type ToolCallHandler = (
	event: ToolCallEvent,
) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;

export interface SpikeR4Captured {
	toolCallHandler?: ToolCallHandler;
	command?: { name: string; def: Omit<RegisteredCommand, "name" | "sourceInfo"> };
}

const captured: SpikeR4Captured = {};

export function getCaptured(): SpikeR4Captured {
	return captured;
}

// ---------------------------------------------------------------------------
// Path-membership predicate — true membership, not substring.
//
// `pathPrefix` semantics in the future `forge-permissions.json` MUST be
// resolved as path-relative membership (see RESULT.md §"Future policy-engine
// shape"). Substring `startsWith` would let `/.forge/storefoo/x.json` pass.
// ---------------------------------------------------------------------------

export function isUnderForgeStore(filePathRaw: string, cwd: string): boolean {
	if (!filePathRaw) return false;
	const resolved = path.isAbsolute(filePathRaw) ? path.resolve(filePathRaw) : path.resolve(cwd, filePathRaw);
	const forgeStore = path.resolve(cwd, ".forge", "store");
	const rel = path.relative(forgeStore, resolved);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Registration entry point — invoked as a DefaultResourceLoader factory or
// as a direct call from tests against a stub ExtensionAPI.
// ---------------------------------------------------------------------------

export function registerSpikeR4(pi: ExtensionAPI, opts?: { cwd?: string }): void {
	const cwd = opts?.cwd ?? process.cwd();

	// 1) Hard block: tool_call handler for write/edit under .forge/store/.
	const toolCallHandler: ToolCallHandler = async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const ev = event as WriteToolCallEvent | EditToolCallEvent;
		// pi v0.73 write/edit input field is `path`, not `file_path` (see
		// dist/core/tools/{write,edit}.d.ts). Earlier draft per architectural-
		// review/PLAN used `file_path`; verified against the live binding.
		const filePath = String(ev.input?.path ?? "");
		if (!isUnderForgeStore(filePath, cwd)) {
			evidence.blockObservations.push({
				toolName: event.toolName,
				filePath,
				decision: "passthrough",
			});
			return undefined;
		}
		const reason = "Use forge_store for store mutations.";
		evidence.blockObservations.push({
			toolName: event.toolName,
			filePath,
			decision: "block",
			reason,
		});
		return { block: true, reason };
	};
	pi.on("tool_call", toolCallHandler);
	captured.toolCallHandler = toolCallHandler;

	// 2) Soft confirm: slash command composes ctx.ui.confirm + ctx.ui.notify.
	const commandDef: Omit<RegisteredCommand, "name" | "sourceInfo"> = {
		description: "Spike R4 — confirm destructive op via ctx.ui.confirm.",
		async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
			const ok = await ctx.ui.confirm("Confirm destructive op", "Proceed?");
			if (ok) {
				evidence.confirmDecisions.push("approved");
				const message = "destructive op approved";
				const type = "info" as const;
				evidence.notifyCalls.push({ message, type });
				ctx.ui.notify(message, type);
			} else {
				evidence.confirmDecisions.push("aborted");
				const message = "aborted";
				const type = "warning" as const;
				evidence.notifyCalls.push({ message, type });
				ctx.ui.notify(message, type);
			}
		},
	};
	pi.registerCommand("forge:poc-confirm-destructive", commandDef);
	captured.command = { name: "forge:poc-confirm-destructive", def: commandDef };
}
