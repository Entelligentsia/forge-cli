// mcp/cjs-handlers.ts — per-tool argv-mapping + cjs dispatch for the MCP server.
//
// Maps structured MCP tool arguments → argv arrays, then invokes the
// corresponding vendored .forge/tools/*.cjs via runCjsMcp.
//
// Iron Law 6 compliance: argv arrays only. No shell string interpolation.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCjsMcp } from "./run-cjs-mcp.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

type ToolArgs = Record<string, unknown>;

type ToolHandler = (args: ToolArgs, projectRoot: string, toolDir: string) => Promise<McpToolResult>;

// ── Result helpers ─────────────────────────────────────────────────────────────

function ok(text: string): McpToolResult {
	return { content: [{ type: "text", text: text || "OK" }] };
}

function err(text: string): McpToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// ── Large-content threshold (mirrors forge-artifact-tool.ts) ──────────────────

const INLINE_CONTENT_LIMIT = 64 * 1024; // 64 KB

// ── Handler implementations ───────────────────────────────────────────────────

const collateHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "collate.cjs");
	const argv: string[] = [];
	if (typeof args["sprintId"] === "string") argv.push(args["sprintId"]);
	if (args["purgeEvents"] === true) argv.push("--purge-events");
	if (args["dryRun"] === true) argv.push("--dry-run");
	try {
		const { stdout } = await runCjsMcp(toolPath, argv, projectRoot, 30_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_collate failed: ${ex.message ?? "unknown error"}`);
	}
};

const storeHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "store-cli.cjs");
	const command = String(args["command"] ?? "");
	const rawArgs = Array.isArray(args["args"]) ? (args["args"] as string[]) : [];
	const argv: string[] = [command, ...rawArgs];
	if (args["dryRun"] === true) argv.push("--dry-run");
	try {
		const { stdout } = await runCjsMcp(toolPath, argv, projectRoot, 10_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_store failed: ${ex.message ?? "unknown error"}`);
	}
};

const commitHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "commit-task.cjs");
	const entity = String(args["entity"] ?? "task");
	const id = String(args["id"] ?? "");
	const message = String(args["message"] ?? "");
	const argv: string[] = [`--${entity}`, id, "--message", message];
	if (typeof args["trailer"] === "string") argv.push("--trailer", args["trailer"]);
	for (const p of Array.isArray(args["also"]) ? (args["also"] as string[]) : []) {
		argv.push("--also", p);
	}
	if (args["dryRun"] === true) argv.push("--dry-run");
	if (args["skipGate"] === true) argv.push("--skip-gate");
	try {
		const { stdout } = await runCjsMcp(toolPath, argv, projectRoot, 30_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_commit failed: ${ex.message ?? "unknown error"}`);
	}
};

const validateStoreHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "validate-store.cjs");
	const argv: string[] = [];
	if (args["fix"] === true) argv.push("--fix");
	if (args["json"] === true) argv.push("--json");
	if (args["dryRun"] === true) argv.push("--dry-run");
	try {
		const { stdout } = await runCjsMcp(toolPath, argv, projectRoot, 10_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as {
			code?: number | string;
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		// Exit code 1 is informational — validation found errors but the tool
		// ran successfully. Numeric code check: string codes (ENOENT, ETIMEDOUT)
		// are hard failures.
		if (typeof ex.code === "number" && ex.code === 1) {
			const output = [ex.stdout, ex.stderr].filter(Boolean).join("\n");
			return ok(output || "Validation errors found.");
		}
		return err(`forge_validate_store failed: ${ex.message ?? "unknown error"}`);
	}
};

const configHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "manage-config.cjs");
	const subcommand = String(args["subcommand"] ?? "");
	const rawArgs = Array.isArray(args["args"]) ? (args["args"] as string[]) : [];
	const argv: string[] = [subcommand, ...rawArgs];
	try {
		const { stdout } = await runCjsMcp(toolPath, argv, projectRoot, 10_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_config failed: ${ex.message ?? "unknown error"}`);
	}
};

const storeDescribeHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "store-cli.cjs");
	const entity = String(args["entity"] ?? "");
	try {
		const { stdout } = await runCjsMcp(toolPath, ["describe", entity], projectRoot, 5_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_store_describe failed: ${ex.message ?? "unknown error"}`);
	}
};

const storeTemplateHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "store-cli.cjs");
	const entity = String(args["entity"] ?? "");
	try {
		const { stdout } = await runCjsMcp(toolPath, ["template", entity], projectRoot, 5_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_store_template failed: ${ex.message ?? "unknown error"}`);
	}
};

const storeQueryHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "store-cli.cjs");
	const command = String(args["command"] ?? "");
	const rawArgs = Array.isArray(args["args"]) ? (args["args"] as string[]) : [];
	const argv: string[] = [command, ...rawArgs];
	const timeout = command === "nlp" ? 30_000 : 10_000;
	try {
		const { stdout } = await runCjsMcp(toolPath, argv, projectRoot, timeout);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_store_query failed: ${ex.message ?? "unknown error"}`);
	}
};

const verifyApplyHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "verify-apply.cjs");
	const claimedPaths = Array.isArray(args["claimed_paths"]) ? (args["claimed_paths"] as string[]) : [];
	try {
		const { stdout } = await runCjsMcp(toolPath, claimedPaths, projectRoot, 30_000);
		return ok(stdout.trim() || "{}");
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_verify_apply failed: ${ex.message ?? "unknown error"}`);
	}
};

const artifactHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "artifact.cjs");
	const command = String(args["command"] ?? "");
	const entity = String(args["entity"] ?? "");
	const entityId = String(args["entityId"] ?? "");
	const artifact = typeof args["artifact"] === "string" ? args["artifact"] : undefined;
	const content = typeof args["content"] === "string" ? args["content"] : undefined;

	let tmpFile: string | null = null;
	try {
		const argv: string[] = [command, entity, entityId];

		if (command !== "list") {
			if (!artifact) {
				return err(`"artifact" is required for ${command}.`);
			}
			argv.push(artifact);
		}

		if (command === "write") {
			if (!content) {
				return err(`"content" is required for write.`);
			}
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes >= INLINE_CONTENT_LIMIT) {
				// Large content: write to temp file and pass @<path>
				tmpFile = path.join(os.tmpdir(), `forge-mcp-artifact-${Date.now()}-${process.pid}.tmp`);
				fs.writeFileSync(tmpFile, content, "utf8");
				argv.push(`@${tmpFile}`);
			} else {
				argv.push(content);
			}
		}

		const { stdout, stderr } = await runCjsMcp(toolPath, argv, projectRoot, 10_000);

		if (stderr && stderr.trim()) {
			return err(stderr.trim());
		}
		return ok(stdout.trim() || "OK");
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_artifact failed: ${ex.message ?? "unknown error"}`);
	} finally {
		if (tmpFile) {
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				/* best-effort cleanup */
			}
		}
	}
};

const preflightHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "preflight-gate.cjs");
	const phase = String(args["phase"] ?? "");
	const argv: string[] = ["--phase", phase];
	if (typeof args["task"] === "string") argv.push("--task", args["task"]);
	if (typeof args["bug"] === "string") argv.push("--bug", args["bug"]);
	try {
		const { stdout } = await runCjsMcp(toolPath, argv, projectRoot, 10_000);
		return ok(stdout || "Preflight passed.");
	} catch (e: unknown) {
		const ex = e as { message?: string; stdout?: string };
		return err(ex.stdout || ex.message || "Preflight gate failed.");
	}
};

const bannerHandler: ToolHandler = async (args, projectRoot, toolDir) => {
	const toolPath = path.join(toolDir, "banners.cjs");
	const name = String(args["name"] ?? "");
	try {
		const { stdout } = await runCjsMcp(toolPath, [name], projectRoot, 5_000);
		return ok(stdout);
	} catch (e: unknown) {
		const ex = e as { message?: string };
		return err(`forge_banner failed: ${ex.message ?? "unknown error"}`);
	}
};

// ── Handler registry ──────────────────────────────────────────────────────────

export const CJS_HANDLERS: Record<string, ToolHandler> = {
	collate: collateHandler,
	store: storeHandler,
	commit: commitHandler,
	validate_store: validateStoreHandler,
	config: configHandler,
	store_describe: storeDescribeHandler,
	store_template: storeTemplateHandler,
	store_query: storeQueryHandler,
	verify_apply: verifyApplyHandler,
	artifact: artifactHandler,
	preflight: preflightHandler,
	banner: bannerHandler,
};
