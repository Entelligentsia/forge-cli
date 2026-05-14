import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";
import { startReviewServer } from "./review-server.js";
import { resolveEntityRef, resolveToolDir } from "./store-resolver.js";

function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
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

			const resolved = await resolveEntityRef(arg, toolDir, ctx.cwd, {
				ctx,
				statusLabel: "forge:read",
			}).catch((err: any) => {
				ctx.ui.setStatus("forge:read", undefined);
				ctx.ui.notify(`Store query failed: ${err.message}`, "error");
				return null;
			});

			if (!resolved) return;

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
