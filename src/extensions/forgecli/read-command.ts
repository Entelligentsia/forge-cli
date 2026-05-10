import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { startReviewServer } from "./review-server.js";

const execFileAsync = promisify(execFile);

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
	const result = await execFileAsync("node", [toolPath, ...argv], {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
	});
	return JSON.parse(result.stdout);
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

	// ── 2-5. Structured ID → store-query query flags ─────────────────────────
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
	} catch {
		// structured query failed — fall through
	}

	if (structuredResult?.results?.length > 0) {
		return pickFromResults(structuredResult.results, arg, ctx);
	}

	// ── 6. ID suffix matching (for bare IDs like "S01" or "S01-T01" without project prefix) ─
	// --keyword only searches titles; IDs need separate suffix matching against the full entity list.
	const looksLikeIdFragment = /^(S|B|F)\d+(-T\d+)?$/i.test(arg);
	if (looksLikeIdFragment) {
		ctx.ui.setStatus("forge:read", `Searching for ID suffix "${arg}"…`);
		try {
			const suffix = arg.toUpperCase();
			// List all sprints to discover project prefix, then resolve
			const listResult = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
			const allSprints: any[] = listResult?.results ?? [];

			// Try to find sprint by suffix
			const matchedSprints = allSprints.filter((s: any) =>
				s.id?.toUpperCase().endsWith(`-${suffix}`) || s.id?.toUpperCase() === suffix,
			);
			if (matchedSprints.length > 0) {
				// Re-query using canonical IDs we found
				const canonicalResults: any[] = [];
				for (const s of matchedSprints) {
					try {
						const r = await runStoreCli(toolDir, ["query", "--sprint", s.id], cwd);
						canonicalResults.push(...(r?.results ?? []));
					} catch { /* skip */ }
				}
				if (canonicalResults.length > 0) return pickFromResults(canonicalResults, arg, ctx);
			}

			// Try task suffix match (e.g. S01-T01 → look for id ending in -S01-T01)
			if (taskIdRe.test(arg)) {
				const taskListResult = await runStoreCli(toolDir, ["query", "--list-sprints"], cwd);
				for (const s of taskListResult?.results ?? []) {
					try {
						const taskId = `${s.id}-${suffix.split("-")[1]}`; // e.g. HELLO-S01 + T01 → HELLO-S01-T01
						const r = await runStoreCli(toolDir, ["query", "--task", taskId], cwd);
						if (r?.results?.length > 0) return pickFromResults(r.results, arg, ctx);
					} catch { /* skip */ }
				}
			}
		} catch {
			// fall through to keyword search
		}
	}

	// ── 7. Keyword search (title substring match) ─────────────────────────────
	ctx.ui.setStatus("forge:read", `Keyword search: "${arg}"…`);
	let keywordResult: any | null = null;
	try {
		keywordResult = await runStoreCli(toolDir, ["query", "--keyword", arg], cwd);
	} catch {
		// keyword search failed — fall through to NLP
	}

	if (keywordResult?.results?.length > 0) {
		return pickFromResults(
			keywordResult.results.filter((r: any) => ["task", "sprint", "bug", "feature"].includes(r.type)),
			arg,
			ctx,
		);
	}

	// ── 8. NLP fallback ───────────────────────────────────────────────────────
	ctx.ui.setStatus("forge:read", `Searching Forge store: "${arg}"…`);


	const nlpResult = await runStoreCli(toolDir, ["nlp", arg], cwd);
	const items = (nlpResult.results || []).filter((r: any) =>
		["task", "sprint", "bug", "feature"].includes(r.type),
	);

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
	const options = items.map((t: any) => `${t.id} (${t.type}): ${t.title}`);
	const selection = await ctx.ui.select(
		`Multiple records found for "${arg}". Select one:`,
		options,
	);
	if (!selection) return null;
	const selectedId = selection.split(" ")[0].trim();
	return { item: items.find((t: any) => t.id === selectedId) };
}

export function registerReadCommand(pi: ExtensionAPI, forgeRoot: string | null): void {
	pi.registerCommand("forge:read", {
		description: "Review a Forge artifact in the browser and provide inline feedback",
		async handler(args: string, ctx: ExtensionCommandContext) {
			if (!forgeRoot) {
				ctx.ui.notify("forge:read — no Forge project at cwd; run /forge:init to bootstrap", "warning");
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

					await pi.sendUserMessage(promptText);
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
