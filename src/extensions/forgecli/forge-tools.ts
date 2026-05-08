// Production forge tool wrappers — FORGE-S16-T03.
//
// Implements four pi custom tools that wrap the Forge deterministic .cjs tools:
//   forge_collate        → forge/tools/collate.cjs
//   forge_store          → forge/tools/store-cli.cjs
//   forge_validate_store → forge/tools/validate-store.cjs
//   forge_config         → forge/tools/manage-config.cjs
//
// AC4 note: the upstream .cjs tools do NOT accept a --forge-root flag; they
// use findProjectRoot() which walks up from process.cwd(). The equivalent
// guarantee is provided by capturing forgeRoot at extension-init time and
// passing `cwd: projectRoot` to execFileAsync on every call — no per-call
// process.cwd() derivation occurs in this module.
//
// Iron Law 6 compliance: execFile with argv arrays only. No shell strings.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

// ── Shared helper ────────────────────────────────────────────────────────────

/**
 * runCjs — shared execFileAsync wrapper for all four .cjs tool invocations.
 *
 * Implements DRY: AbortSignal propagation, timeout, cwd binding, and
 * stdout/stderr capture are applied consistently across all tools.
 *
 * Timeout guidance: collate 30s (large stores); store/validate 10s; config 5s.
 *
 * @param toolPath    Absolute path to the .cjs tool.
 * @param argv        Arguments to pass after "node <toolPath>".
 * @param signal      AbortSignal from tool execute — propagated to subprocess.
 * @param timeoutMs   Subprocess timeout in milliseconds.
 * @param projectRoot Directory containing .forge/ — cwd for the subprocess so
 *                    findProjectRoot() in the .cjs tool resolves correctly.
 */
async function runCjs(
	toolPath: string,
	argv: string[],
	signal: AbortSignal | undefined,
	timeoutMs: number,
	projectRoot: string,
): Promise<{ stdout: string; stderr: string }> {
	const opts: Parameters<typeof execFileAsync>[2] = {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: timeoutMs,
	};
	// AbortSignal is optional — only pass when defined (execFile rejects if
	// signal is undefined and the type expects AbortSignal | undefined).
	if (signal !== undefined) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(opts as any).signal = signal;
	}
	const result = await execFileAsync("node", [toolPath, ...argv], opts);
	return {
		stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8"),
		stderr: typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8"),
	};
}

// ── Result helpers ───────────────────────────────────────────────────────────

function okResult(text: string) {
	return {
		content: [{ type: "text" as const, text: text || "OK" }],
		details: {} as unknown,
	};
}

function errResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {} as unknown,
		isError: true as const,
	};
}

// ── Public registration ──────────────────────────────────────────────────────

/**
 * Register all four Forge .cjs tool wrappers with the pi ExtensionAPI.
 *
 * @param pi          The pi ExtensionAPI instance.
 * @param forgeRoot   Absolute path to the Forge plugin root (resolved at init time).
 * @param projectRoot The directory containing `.forge/` (parent of `.forge/`).
 */
export function registerForgeTools(pi: ExtensionAPI, forgeRoot: string, projectRoot: string): void {
	registerForgeCollate(pi, forgeRoot, projectRoot);
	registerForgeStore(pi, forgeRoot, projectRoot);
	registerForgeValidateStore(pi, forgeRoot, projectRoot);
	registerForgeConfig(pi, forgeRoot, projectRoot);
}

// ── forge_collate ────────────────────────────────────────────────────────────

function registerForgeCollate(pi: ExtensionAPI, forgeRoot: string, projectRoot: string): void {
	pi.registerTool({
		name: "forge_collate",
		label: "Forge Collate",
		description: "Regenerate Forge KB markdown documents from the JSON store. Wraps forge/tools/collate.cjs.",
		promptSnippet: "Use forge_collate to refresh the engineering knowledge base.",
		parameters: Type.Object({
			sprintId: Type.Optional(
				Type.String({
					description: "Sprint or bug ID to collate (e.g. FORGE-S16). Omit to collate all.",
				}),
			),
			purgeEvents: Type.Optional(
				Type.Boolean({
					description: "Delete event directory after generating COST_REPORT.md.",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "Preview changes without writing files.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const toolPath = path.join(forgeRoot, "tools", "collate.cjs");
			const argv: string[] = [];
			if (params.sprintId) argv.push(params.sprintId);
			if (params.purgeEvents) argv.push("--purge-events");
			if (params.dryRun) argv.push("--dry-run");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 30_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_collate failed: ${e.message ?? "unknown error"}`);
			}
		},
	});
}

// ── forge_store ──────────────────────────────────────────────────────────────

function registerForgeStore(pi: ExtensionAPI, forgeRoot: string, projectRoot: string): void {
	pi.registerTool({
		name: "forge_store",
		label: "Forge Store",
		description:
			"Full store CRUD — wraps forge/tools/store-cli.cjs. Accepts any subcommand and argv. " +
			"store-cli enforces schema validation, status transitions, and path-traversal guards internally.",
		promptSnippet: "Use forge_store to read or write sprint/task/bug/feature/event records in the Forge store.",
		parameters: Type.Object({
			command: Type.String({
				description:
					"store-cli subcommand: write|read|list|delete|update-status|emit|merge-sidecar|record-usage|purge-events|write-collation-state|validate|set-summary|set-bug-summary|progress|progress-clear|nlp",
			}),
			args: Type.Array(Type.String(), {
				description: "Positional and flag arguments after the subcommand. E.g. ['task', 'FORGE-S16-T03', '--json']",
			}),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "Pass --dry-run flag (validate without writing).",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const toolPath = path.join(forgeRoot, "tools", "store-cli.cjs");
			const argv: string[] = [params.command, ...params.args];
			if (params.dryRun) argv.push("--dry-run");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_store failed: ${e.message ?? "unknown error"}`);
			}
		},
	});
}

// ── forge_validate_store ─────────────────────────────────────────────────────

function registerForgeValidateStore(pi: ExtensionAPI, forgeRoot: string, projectRoot: string): void {
	pi.registerTool({
		name: "forge_validate_store",
		label: "Forge Validate Store",
		description:
			"Validate Forge store integrity — wraps forge/tools/validate-store.cjs. " +
			"Exit code 1 means validation errors were found (returned as informational content, not isError). " +
			"Only hard failures (ENOENT, timeout) return isError: true.",
		promptSnippet: "Use forge_validate_store to check the Forge store for integrity issues.",
		parameters: Type.Object({
			fix: Type.Optional(
				Type.Boolean({
					description: "Attempt to auto-fix recoverable issues.",
				}),
			),
			json: Type.Optional(
				Type.Boolean({
					description: "Output results as JSON.",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "Validate only, no writes.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const toolPath = path.join(forgeRoot, "tools", "validate-store.cjs");
			const argv: string[] = [];
			if (params.fix) argv.push("--fix");
			if (params.json) argv.push("--json");
			if (params.dryRun) argv.push("--dry-run");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as {
					code?: number | string;
					stdout?: string;
					stderr?: string;
					message?: string;
				};
				// Exit code 1 is informational: validation found errors.
				// Node sets `.code` to a NUMBER for normal non-zero exits.
				// For spawn errors (ENOENT, ETIMEDOUT), `.code` is a STRING.
				// The numeric check correctly excludes string codes (ENOENT etc.)
				// which must still be treated as hard failures.
				if (typeof e.code === "number" && e.code === 1) {
					const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
					return okResult(output || "Validation errors found.");
				}
				// Real failure: ENOENT, timeout, SIGKILL, etc.
				return errResult(`forge_validate_store failed: ${e.message ?? "unknown error"}`);
			}
		},
	});
}

// ── forge_config ─────────────────────────────────────────────────────────────

function registerForgeConfig(pi: ExtensionAPI, forgeRoot: string, projectRoot: string): void {
	// Subcommand union verified against manage-config.cjs source dispatch
	// (FORGE-S16-T03 PLAN_REVIEW advisory #4, pre-flight grep):
	// handles exactly: get, list-pipelines, pipeline, set, resolve-forge-root.
	pi.registerTool({
		name: "forge_config",
		label: "Forge Config",
		description:
			"Read/write .forge/config.json — wraps forge/tools/manage-config.cjs. " +
			"Supported subcommands: get, set, list-pipelines, pipeline, resolve-forge-root.",
		promptSnippet: "Use forge_config to read or update Forge project configuration.",
		parameters: Type.Object({
			subcommand: Type.Union(
				[
					Type.Literal("get"),
					Type.Literal("set"),
					Type.Literal("list-pipelines"),
					Type.Literal("pipeline"),
					Type.Literal("resolve-forge-root"),
				],
				{ description: "manage-config subcommand." },
			),
			args: Type.Array(Type.String(), {
				description:
					"Additional arguments. For 'get': ['paths.forgeRoot']. For 'set': ['project.name', '\"MyProject\"'].",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const toolPath = path.join(forgeRoot, "tools", "manage-config.cjs");
			const argv: string[] = [params.subcommand, ...params.args];

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 5_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_config failed: ${e.message ?? "unknown error"}`);
			}
		},
	});
}
