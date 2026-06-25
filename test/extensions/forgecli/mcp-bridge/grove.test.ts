// Grove consumer + implicit-init tests (FORGE-S34).
//
// Two layers:
//   1. Graceful contract — deterministic everywhere by clearing PATH so no grove
//      is reachable; resolveGroveBin → null, ensureGroveReady → not ready,
//      attachGrove → null (a no-op session, never a throw).
//   2. Real integration — drives the bridge against a real `grove serve` process
//      across its whole tool surface (outline → symbols → source, callers,
//      definition, check), the subagent-roster wiring, and the implicit init
//      path. When grove is genuinely absent each test asserts the graceful
//      contract instead — a runtime branch, not a skipped test (CI no-skip safe).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ForgeToolDefs, getSubagentTools, setExtraSubagentTools } from "../../../../src/extensions/forgecli/forge-tools.js";
import type { McpAttachment } from "../../../../src/extensions/forgecli/mcp-bridge/mcp-bridge.js";
import {
	attachGrove,
	ensureGroveReady,
	resolveGroveBin,
} from "../../../../src/extensions/forgecli/mcp-bridge/grove.js";

const CTX = {} as unknown as ExtensionContext;
const REPO_ROOT = process.cwd();
const BRIDGE_DIR = "src/extensions/forgecli/mcp-bridge";

// pi's AgentToolResult type does not surface the runtime `isError` / text field.
type ExecResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

/** Call one synthesized grove tool by its prefixed name. */
async function call(
	attachment: McpAttachment,
	name: string,
	args: Record<string, unknown>,
): Promise<ExecResult> {
	const tool = attachment.tools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} not advertised`);
	return (await tool.execute(`itest-${name}`, args, undefined, undefined, CTX)) as ExecResult;
}

function textOf(r: ExecResult): string {
	return r.content.map((c) => c.text ?? "").join("\n");
}

// Pin the grove the developer actually installed. Under `npx vitest` the npm
// runner prepends ancestor node_modules/.bin dirs to PATH, so a stray
// node_modules/.bin/grove anywhere up the tree can shadow the intended binary.
// `npm i -g @entelligentsia/grove` installs the bin next to the active node, so
// prefer that; fall back to PATH resolution. (Production `4ge` is launched
// directly, without npm's PATH augmentation, so this shadowing is test-only.)
function pickGrove(): string | null {
	const sibling = path.join(path.dirname(process.execPath), "grove");
	if (existsSync(sibling)) {
		const ok = resolveGroveBin(sibling);
		if (ok) return ok;
	}
	return resolveGroveBin();
}

describe("grove graceful contract (no grove reachable)", () => {
	let savedPath: string | undefined;
	let savedBin: string | undefined;
	let emptyDir: string;

	beforeEach(() => {
		savedPath = process.env.PATH;
		savedBin = process.env.FORGE_GROVE_BIN;
		emptyDir = mkdtempSync(path.join(tmpdir(), "grove-empty-"));
		// An empty PATH means a bare "grove" command cannot be resolved, even on a
		// machine where grove is installed — makes the absent-path deterministic.
		process.env.PATH = emptyDir;
		delete process.env.FORGE_GROVE_BIN;
	});

	afterEach(() => {
		if (savedPath !== undefined) process.env.PATH = savedPath;
		if (savedBin !== undefined) process.env.FORGE_GROVE_BIN = savedBin;
		else delete process.env.FORGE_GROVE_BIN;
		rmSync(emptyDir, { recursive: true, force: true });
	});

	it("resolveGroveBin returns null when nothing is reachable", () => {
		expect(resolveGroveBin()).toBeNull();
		expect(resolveGroveBin("/definitely/not/here/grove")).toBeNull();
	});

	it("ensureGroveReady reports not-ready and never runs init", () => {
		const r = ensureGroveReady({ cwd: emptyDir, runInit: true });
		expect(r.bin).toBeNull();
		expect(r.initialized).toBe(false);
		expect(r.ranInit).toBe(false);
	});

	it("attachGrove resolves to null (no-op, no throw)", async () => {
		await expect(attachGrove({ cwd: emptyDir })).resolves.toBeNull();
	});
});

describe("grove real integration (live `grove serve`)", () => {
	const groveBin = pickGrove();
	let attachment: McpAttachment | null = null;

	beforeAll(async () => {
		if (groveBin) attachment = await attachGrove({ cwd: REPO_ROOT, bin: groveBin ?? undefined });
	}, 30000);

	afterAll(async () => {
		if (attachment) await attachment.dispose();
		setExtraSubagentTools([]); // undo roster mutation from the subagent test
	});

	it("discovers the full grove tool surface dynamically", () => {
		if (!attachment) {
			expect(groveBin).toBeNull();
			return;
		}
		// Whatever `grove serve` advertised this run — no hardcoded list in src.
		// (grove 0.1.7 added `map` over 0.1.4; the bridge picks it up for free.)
		expect(attachment.toolNames).toEqual(
			expect.arrayContaining([
				"mcp__grove__outline",
				"mcp__grove__symbols",
				"mcp__grove__source",
				"mcp__grove__callers",
				"mcp__grove__definition",
				"mcp__grove__check",
			]),
		);
		console.error(`[grove itest] grove ${attachment.serverInfo?.version} discovered ${attachment.toolNames.length} tools: ${attachment.toolNames.join(", ")}`);
	});

	it("outline → symbols → source resolves a real symbol's body", async () => {
		if (!attachment) {
			expect(groveBin).toBeNull();
			return;
		}
		// 1. outline the bridge's grove.ts
		const outline = await call(attachment, "mcp__grove__outline", { file: `${BRIDGE_DIR}/grove.ts` });
		expect(outline.isError).toBe(false);
		expect(textOf(outline)).toContain("grove.ts#");

		// 2. locate a real exported symbol by exact name across the bridge dir.
		//    (grove's TS tags index interfaces/types — use one this file declares.)
		const symbols = await call(attachment, "mcp__grove__symbols", {
			dir: BRIDGE_DIR,
			name: "GroveReadiness",
		});
		expect(symbols.isError).toBe(false);
		const found = JSON.parse(textOf(symbols)) as Array<{ id: string; name: string }>;
		const target = found.find((s) => s.name === "GroveReadiness");
		expect(target, "symbols should locate GroveReadiness").toBeDefined();
		console.error(`[grove itest] symbols→ ${target!.id}`);

		// 3. read exactly that symbol's body by id — the dynamic-discovery payoff:
		//    the id from step 2 round-trips straight into a different tool.
		const source = await call(attachment, "mcp__grove__source", { id: target!.id });
		expect(source.isError).toBe(false);
		const body = textOf(source);
		expect(body).toContain("interface GroveReadiness");
		console.error(`[grove itest] source bytes: ${body.length}`);
	}, 30000);

	it("callers resolves a real cross-function reference", async () => {
		if (!attachment) {
			expect(groveBin).toBeNull();
			return;
		}
		const callers = await call(attachment, "mcp__grove__callers", {
			name: "resolveGroveBin",
			dir: BRIDGE_DIR,
		});
		expect(callers.isError).toBe(false);
		// ensureGroveReady calls resolveGroveBin — it must appear as a call site.
		expect(textOf(callers)).toContain("ensureGroveReady");
		console.error(`[grove itest] callers(resolveGroveBin) → ${textOf(callers).replace(/\s+/g, " ").slice(0, 160)}`);
	}, 30000);

	it("definition and map resolve real structure", async () => {
		if (!attachment) {
			expect(groveBin).toBeNull();
			return;
		}
		const def = await call(attachment, "mcp__grove__definition", {
			name: "GroveReadiness",
			dir: BRIDGE_DIR,
		});
		expect(def.isError).toBe(false);
		expect(textOf(def)).toContain("GroveReadiness");
		console.error(`[grove itest] definition(GroveReadiness) → ${textOf(def).replace(/\s+/g, " ").slice(0, 140)}`);

		// `map` is only present on grove >= 0.1.7 — exercise it when advertised,
		// proving the dynamically-discovered tool works end to end.
		if (attachment.toolNames.includes("mcp__grove__map")) {
			const map = await call(attachment, "mcp__grove__map", { dir: BRIDGE_DIR });
			expect(map.isError).toBe(false);
			expect(textOf(map)).toContain("grove.ts");
			console.error(`[grove itest] map bytes: ${textOf(map).length}`);
		}
	}, 30000);

	it("check reports the bridge sources as syntactically clean", async () => {
		if (!attachment) {
			expect(groveBin).toBeNull();
			return;
		}
		const check = await call(attachment, "mcp__grove__check", { file: `${BRIDGE_DIR}/mcp-bridge.ts` });
		expect(check.isError).toBe(false);
		console.error(`[grove itest] check → ${textOf(check) || "(clean)"}`);
	}, 15000);

	it("synthesized tools carry grove steering + verbatim JSON-Schema params", () => {
		if (!attachment) {
			expect(groveBin).toBeNull();
			return;
		}
		const outline = attachment.tools.find((t) => t.name === "mcp__grove__outline")!;
		expect(outline.promptGuidelines?.length).toBeGreaterThan(0);
		// The parameters are grove's own JSON Schema (object with a `file` prop).
		const schema = outline.parameters as { type?: string; properties?: Record<string, unknown> };
		expect(schema.type).toBe("object");
		expect(schema.properties).toHaveProperty("file");
	});

	it("grove tools reach the subagent roster via getSubagentTools", () => {
		if (!attachment) {
			expect(groveBin).toBeNull();
			return;
		}
		// This is the seam orchestrators use to build a subagent's customTools.
		setExtraSubagentTools(attachment.tools);
		const roster = getSubagentTools({} as ForgeToolDefs).map((t) => t.name);
		expect(roster).toEqual(expect.arrayContaining(["mcp__grove__outline", "mcp__grove__source"]));
		console.error(`[grove itest] subagent roster includes grove: ${roster.filter((n) => n.startsWith("mcp__grove__")).join(", ")}`);
	});
});

describe("grove implicit init path (live)", () => {
	const groveBin = pickGrove();
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(path.join(tmpdir(), "grove-init-"));
	});
	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("provisions a fresh project (grove.lock) when runInit is requested", () => {
		if (!groveBin) {
			expect(groveBin).toBeNull();
			return;
		}
		// Seed a TypeScript file so grove detects a language to provision.
		writeFileSync(path.join(workdir, "sample.ts"), "export const x = (): number => 1;\n", "utf8");
		expect(existsSync(path.join(workdir, "grove.lock"))).toBe(false);

		const r = ensureGroveReady({ cwd: workdir, bin: groveBin ?? undefined, runInit: true });
		expect(r.bin).toBe(groveBin);
		expect(r.ranInit).toBe(true);
		expect(r.initialized).toBe(true);
		expect(existsSync(path.join(workdir, "grove.lock"))).toBe(true);
		console.error(`[grove itest] implicit init provisioned grove.lock in ${workdir}`);
	}, 90000);
});
