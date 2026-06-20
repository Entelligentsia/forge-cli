// claude-bootstrap/mcp-json-merge.ts — Idempotent .mcp.json writer (FORGE-S34-T06)
//
// Provides merge-not-clobber semantics for writing Forge's MCP server entry into
// a project's .mcp.json. Existing MCP servers (unrelated to Forge) are preserved
// byte-identical. The Forge entry is only added where missing.
//
// Key contracts:
//   - Never overwrites a file that does not parse as JSON
//   - Running twice is idempotent: second run detects existing Forge entry and returns "already-present"
//   - Pure fs operations: no shell-outs, no LLM, no network
//   - Template is read from payloadRoot/init/mcp/.mcp.json; mcpServers.forge is extracted and merged

import * as fs from "node:fs";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MergeMcpJsonResult {
	outcome: "created" | "merged" | "already-present" | "error";
	warning?: string;
}

// ── mergeMcpJson ──────────────────────────────────────────────────────────────

/**
 * Merge the Forge MCP server entry into the project .mcp.json with
 * merge-not-clobber semantics.
 *
 * Rules:
 * 1. templatePath absent → "error" (payload missing template; non-fatal).
 * 2. Project .mcp.json absent → read template, write { mcpServers: { forge: ... } } → "created".
 * 3. Project .mcp.json present, valid JSON, already has mcpServers.forge → "already-present" (no-op).
 * 4. Project .mcp.json present, valid JSON, no mcpServers.forge →
 *    deep-merge forge key into existing mcpServers, preserve all other servers → "merged".
 * 5. Project .mcp.json present, malformed JSON → "error", file never overwritten.
 * 6. Write failure → "error" with descriptive warning.
 */
export function mergeMcpJson(mcpJsonPath: string, templatePath: string): MergeMcpJsonResult {
	// ── Rule 1: Template absent ───────────────────────────────────────────────
	if (!fs.existsSync(templatePath)) {
		return {
			outcome: "error",
			warning: `MCP template missing at ${templatePath} — payload may be incomplete. Run 'npm run build' to regenerate.`,
		};
	}

	// ── Read and parse the template ───────────────────────────────────────────
	let templateRaw: string;
	try {
		templateRaw = fs.readFileSync(templatePath, "utf8");
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `Could not read MCP template at ${templatePath}: ${e.message ?? String(err)}`,
		};
	}

	let template: Record<string, unknown>;
	try {
		template = JSON.parse(templateRaw) as Record<string, unknown>;
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `MCP template at ${templatePath} is malformed JSON: ${e.message ?? String(err)}`,
		};
	}

	const templateMcpServers = template.mcpServers as Record<string, unknown> | undefined;
	if (!templateMcpServers?.forge) {
		return {
			outcome: "error",
			warning: `MCP template at ${templatePath} is missing mcpServers.forge entry.`,
		};
	}
	const forgeEntry = templateMcpServers.forge;

	// ── Rule 2: Project .mcp.json absent → create ─────────────────────────────
	if (!fs.existsSync(mcpJsonPath)) {
		try {
			const content = JSON.stringify({ mcpServers: { forge: forgeEntry } }, null, 2) + "\n";
			fs.writeFileSync(mcpJsonPath, content, "utf8");
			return { outcome: "created" };
		} catch (err: unknown) {
			const e = err as { message?: string };
			return {
				outcome: "error",
				warning: `Could not write ${mcpJsonPath}: ${e.message ?? String(err)}`,
			};
		}
	}

	// ── Project .mcp.json present: read and parse ─────────────────────────────
	let rawContent: string;
	try {
		rawContent = fs.readFileSync(mcpJsonPath, "utf8");
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `Could not read ${mcpJsonPath}: ${e.message ?? String(err)}`,
		};
	}

	// ── Rule 5: Malformed JSON ────────────────────────────────────────────────
	if (rawContent.trim() === "") {
		return {
			outcome: "error",
			warning: `${mcpJsonPath} is empty — cannot parse as JSON. Fix or delete the file and re-run.`,
		};
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(rawContent) as Record<string, unknown>;
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `${mcpJsonPath} contains malformed JSON — will not overwrite. Parse error: ${e.message ?? String(err)}`,
		};
	}

	// ── Rule 3: Already has mcpServers.forge → no-op ─────────────────────────
	const existingMcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
	if (existingMcpServers && "forge" in existingMcpServers) {
		return { outcome: "already-present" };
	}

	// ── Rule 4: Has mcpServers (or no mcpServers) but no forge → merge ────────
	try {
		const mergedMcpServers = { ...(existingMcpServers ?? {}), forge: forgeEntry };
		const updated = { ...parsed, mcpServers: mergedMcpServers };
		const content = JSON.stringify(updated, null, 2) + "\n";
		fs.writeFileSync(mcpJsonPath, content, "utf8");
		return { outcome: "merged" };
	} catch (err: unknown) {
		const e = err as { message?: string };
		return {
			outcome: "error",
			warning: `Could not write ${mcpJsonPath}: ${e.message ?? String(err)}`,
		};
	}
}
