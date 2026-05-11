import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { startReviewServer } from "./review-server.js";

const execFileAsync = promisify(execFile);

const ENTITY_TYPES = new Set(["task", "sprint", "bug", "feature"]);
const filterEntities = (rs: any[]): any[] => rs.filter((r: any) => ENTITY_TYPES.has(r.type));

function isDebug(): boolean {
	return process.env.FORGE_DEBUG === "1";
}

function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

function resolveToolDir(forgeRoot: string): string {
	const nested = path.join(forgeRoot, "tools");
	try {
		if (fsSync.statSync(nested).isDirectory()) return nested;
	} catch {
		// nested missing — fall through to flat
	}
	return forgeRoot;
}

async function runStoreCli(toolDir: string, argv: string[], cwd: string): Promise<any> {
	const toolPath = path.join(toolDir, "store-cli.cjs");
	// NLP queries can be model-backed and slow; bump timeout for `nlp` subcommand only.
	const timeout = argv[0] === "nlp" ? 30_000 : 10_000;
	const result = await execFileAsync("node", [toolPath, ...argv], {
		cwd,
		encoding: "utf8",
		timeout,
	});
	try {
		return JSON.parse(result.stdout);
	} catch (err: any) {
		throw new Error(
			`store-cli returned non-JSON for argv=${JSON.stringify(argv)}: ${result.stdout.slice(0, 200)}`,
		);
	}
}

/**
 * Resolution cascade:
 *   1. @path   → use the path directly as artifact directory
 *   2. Task ID → store-query query --task <id>
 *   3. Bug ID  → store-query query --bug <id>
 *   4. Feature ID → store-query query --feature <id>
 *   5. Sprint ID → store-query query --sprint <id>
 *   6. NLP     → store-query nlp "<query>"
 */
async function resolveArg(
	arg: string,
	toolDir: string,
	cwd: string,
	ctx: ExtensionCommandContext,
): Promise<{ dir: string } | { item: any } | null> {
	// ── 1. @path ──────────────────────────────────────────────────────────────
	if (arg.startsWith("@")) {
		const rawPath = arg.slice(1).trim();
		const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
		return { dir: resolved };
	}

	const taskIdRe = /^([A-Z0-9]+-)?S\d+-T\d+$/i;
	const sprintIdRe = /^([A-Z0-9]+-)?S\d+$/i;
	const bugIdRe = /^([A-Z0-9]+-)?B\d+$/i;
	const featureIdRe = /^([A-Z0-9]+-)?F\d+$/i;
	const bareTaskIdRe = /^T\d+$/i;

	// ── 2-5. Structured ID → store-query query flags ─────────────────────────
	// Canonical IDs (with project prefix) must match exactly — fail-fast on miss
	// rather than fall through to NLP, which guesses wildly.
	const isCanonical =
		/^[A-Z0-9]+-/i.test(arg) &&
		(taskIdRe.test(arg) || bugIdRe.test(arg) || featureIdRe.test(arg) || sprintIdRe.test(arg));
	let structuredResult: any | null = null;
	try {
		if (taskIdRe.test(arg)) {
			ctx.ui.setStatus("forge:read", `Looking up task ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--task", arg], cwd);
		} else if (bugIdRe.test(arg)) {
			ctx.ui.setStatus("forge:read", `Looking up bug ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--bug", arg], cwd);
		} else if (featureIdRe.test(arg)) {
			ctx.ui.setStatus("forge:read", `Looking up feature ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--feature", arg], cwd);
		} else if (sprintIdRe.test(arg)) {
			ctx.ui.setStatus("forge:read", `Looking up sprint ${arg}…`);
			structuredResult = await runStoreCli(toolDir, ["query", "--sprint", arg], cwd);
		}
	} catch (err: any) {
		if (isDebug()) console.error(`[forge:read] structured query failed: ${err.message}`);
	}

	if (structuredResult?.results?.length > 0) {
		return pickFromResults(structuredResult.results, arg, ctx);
	}

	if (isCanonical) {
		ctx.ui.setStatus("forge:read", undefined);
		ctx.ui.notify(`No record found for canonical ID "${arg}"`, "warning");
		return null;
	}

	// ── 6. ID suffix matching (for bare IDs like "S01" or "S01-T01" without project prefix) ─
	// --keyword only searches titles; IDs need separate suffix matching against the full entity list.
	const looksLikeIdFragment = /^(S|B|F|T)\d+(-T\d+)?$/i.test(arg);
	if (looksLikeIdFragment) {
		ctx.ui.setStatus("forge:read", `Searching for ID suffix "${arg}"…`);
		try {
			const suffix = arg.toUpperCase();
			// Cache sprint list — used for both sprint-suffix and task-suffix branches.
			let cachedSprints: any[] | null = null;
			const getSprints = async (): Promise<any[]> => {
				if (cachedSprints !== null) return cachedSprints;
				const r = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
				cachedSprints = r?.results ?? [];
				return cachedSprints!;
			};

			const allSprints = await getSprints();
			const matchedSprints = allSprints.filter((s: any) =>
				s.id?.toUpperCase().endsWith(`-${suffix}`) || s.id?.toUpperCase() === suffix,
			);
			if (matchedSprints.length > 0) {
				const canonicalResults: any[] = [];
				for (const s of matchedSprints) {
					try {
						const r = await runStoreCli(toolDir, ["query", "--sprint", s.id], cwd);
						canonicalResults.push(...(r?.results ?? []));
					} catch (err: any) {
						if (isDebug()) console.error(`[forge:read] sprint lookup failed for ${s.id}: ${err.message}`);
					}
				}
				if (canonicalResults.length > 0) return pickFromResults(canonicalResults, arg, ctx);
			}

			// Task suffix match. Supports `S01-T01` (find sprint suffix, append Tnn)
			// and bare `T01` (try every sprint).
			if (taskIdRe.test(arg) || bareTaskIdRe.test(arg)) {
				const tPart = bareTaskIdRe.test(arg) ? suffix : suffix.split("-")[1];
				for (const s of await getSprints()) {
					try {
						const taskId = `${s.id}-${tPart}`;
						const r = await runStoreCli(toolDir, ["query", "--task", taskId], cwd);
						if (r?.results?.length > 0) return pickFromResults(r.results, arg, ctx);
					} catch (err: any) {
						if (isDebug()) console.error(`[forge:read] task lookup failed for ${s.id}-${tPart}: ${err.message}`);
					}
				}
			}
		} catch (err: any) {
			if (isDebug()) console.error(`[forge:read] suffix search failed: ${err.message}`);
		}
	}

	// ── 7. Keyword search (title substring match) ─────────────────────────────
	ctx.ui.setStatus("forge:read", `Keyword search: "${arg}"…`);
	let keywordResult: any | null = null;
	try {
		keywordResult = await runStoreCli(toolDir, ["query", "--keyword", arg], cwd);
	} catch (err: any) {
		if (isDebug()) console.error(`[forge:read] keyword search failed: ${err.message}`);
	}

	if (keywordResult?.results?.length > 0) {
		return pickFromResults(filterEntities(keywordResult.results), arg, ctx);
	}

	// ── 8. NLP fallback ───────────────────────────────────────────────────────
	ctx.ui.setStatus("forge:read", `Searching Forge store: "${arg}"…`);

	const nlpResult = await runStoreCli(toolDir, ["nlp", arg], cwd);
	const items = filterEntities(nlpResult.results || []);

	if (items.length === 0) {
		ctx.ui.setStatus("forge:read", undefined);
		ctx.ui.notify(`No records found matching "${arg}"`, "warning");
		return null;
	}

	return pickFromResults(items, arg, ctx);
}

async function pickFromResults(
	items: any[],
	arg: string,
	ctx: ExtensionCommandContext,
): Promise<{ item: any } | null> {
	if (items.length === 1) {
		return { item: items[0] };
	}
	ctx.ui.setStatus("forge:read", undefined);
	if (isNonInteractive()) {
		ctx.ui.notify(
			`Multiple records match "${arg}" — refusing to pick in non-interactive mode`,
			"error",
		);
		return null;
	}
	const options = items.map((t: any, i: number) => `[${i}] ${t.id} (${t.type}): ${t.title}`);
	const selection = await ctx.ui.select(
		`Multiple records found for "${arg}". Select one:`,
		options,
	);
	if (!selection) return null;
	const idx = parseInt(selection.match(/^\[(\d+)\]/)?.[1] ?? "-1", 10);
	if (idx < 0 || idx >= items.length) return null;
	return { item: items[idx] };
}

export function registerReadCommand(pi: ExtensionAPI, forgeRoot: string | null): void {
	pi.registerCommand("forge:read", {
		description: "Review a Forge artifact in the browser and provide inline feedback",
		async handler(args: string, ctx: ExtensionCommandContext) {
			if (!forgeRoot) {
				ctx.ui.notify("forge:read — no Forge project at cwd; run /forge:init to bootstrap", "warning");
				return;
			}

			if (isNonInteractive()) {
				ctx.ui.notify(
					"forge:read requires interactive mode (browser review). Unset FORGE_YES/FORGE_NON_INTERACTIVE.",
					"error",
				);
				return;
			}

			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(
					"Usage: /forge:read <task-id|sprint-id|@path|natural language>\n" +
					"Examples: /forge:read S01-T01  |  /forge:read S01  |  " +
					"/forge:read @engineering/sprints/HELLO-S01/HELLO-S01-T01  |  " +
					"/forge:read the i18n task",
					"error",
				);
				return;
			}

			const toolDir = resolveToolDir(forgeRoot);

			const resolved = await resolveArg(arg, toolDir, ctx.cwd, ctx).catch((err: any) => {
				ctx.ui.setStatus("forge:read", undefined);
				ctx.ui.notify(`Store query failed: ${err.message}`, "error");
				return null;
			});

			if (!resolved) return;

			// Determine artifact directory and display label
			let taskDir: string;
			let label: string;

			if ("dir" in resolved) {
				taskDir = resolved.dir;
				label = path.basename(taskDir);
			} else {
				const item = resolved.item;
				if (!item.fileRefs?.md) {
					ctx.ui.notify(`No markdown index found for ${item.id}`, "error");
					return;
				}
				taskDir = path.dirname(path.join(ctx.cwd, item.fileRefs.md));
				label = `${item.id} — ${item.title}`;
				ctx.ui.notify(`Resolved to ${item.type}: ${item.id} (${item.title})`, "info");
			}

			// List markdown files in artifact directory
			let files: string[];
			try {
				files = await fs.readdir(taskDir);
			} catch {
				ctx.ui.notify(`No artifacts found at ${taskDir}`, "warning");
				return;
			}

			const mdFiles = files.filter(f => f.endsWith(".md"));
			if (mdFiles.length === 0) {
				ctx.ui.notify(`No markdown artifacts found at ${taskDir}`, "info");
				return;
			}

			const selectedFile = await ctx.ui.select(`Select artifact to review for ${label}:`, mdFiles);
			if (!selectedFile) return;

			const artifactPath = path.join(taskDir, selectedFile);
			ctx.ui.notify(`Starting local review server for ${selectedFile}…`, "info");
			ctx.ui.setStatus("forge:read", "Waiting for browser review…");

			try {
				const feedback = await startReviewServer(artifactPath, `${label} — ${selectedFile}`);
				ctx.ui.setStatus("forge:read", undefined);

				if (feedback && feedback.length > 0) {
					ctx.ui.notify(`Received ${feedback.length} feedback item(s). Sending to Forge…`, "info");

					const itemType = "item" in resolved ? resolved.item.type : "artifact";
					const itemId = "item" in resolved ? resolved.item.id : label;
					let promptText = `I have reviewed the artifact \`${selectedFile}\` for ${itemType} ${itemId}. Here is my inline feedback:\n\n`;

					for (const fb of feedback) {
						promptText += `> **Text:** "${fb.selectedText}"\n`;
						promptText += `> **Feedback:** ${fb.comment}\n\n`;
					}
					promptText += `Please process this feedback and update the artifact accordingly.`;

					pi.sendUserMessage(promptText, { deliverAs: "steer" });
				} else {
					ctx.ui.notify("Review completed with no feedback submitted.", "info");
				}
			} catch (err: any) {
				ctx.ui.setStatus("forge:read", undefined);
				ctx.ui.notify(`forge:read error: ${err.message}`, "error");
			}
		},
	});
}
