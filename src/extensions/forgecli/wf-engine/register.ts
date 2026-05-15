import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";
import { runWorkflow } from "./engine.js";

export function registerRunWorkflow(pi: ExtensionAPI, options: { cwd?: string; workflowsDir?: string } = {}): void {
  pi.registerCommand("forge:run-workflow", {
    description:
      "Run a generic workflow defined in workflows/<workflowId>/workflow.yaml. " +
      "Usage: /forge:run-workflow <workflowId> [entryPrompt...]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const cwd = options.cwd ?? process.cwd();
      const workflowsDir = options.workflowsDir ?? path.join(cwd, "workflows");

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("× /forge:run-workflow — workflowId required. Usage: /forge:run-workflow <workflowId> [prompt]", "error");
        return;
      }
      const [workflowId, ...rest] = trimmed.split(/\s+/);
      const entryPrompt = rest.join(" ");

      try {
        const result = await runWorkflow({
          workflowsDir,
          workflowId,
          cwd,
          entryPrompt,
          notify: (line) => ctx.ui.notify(line, "info"),
        });
        if (result.status === "completed") {
          ctx.ui.notify(`✓ workflow complete: ${result.workingDir}`, "info");
        } else {
          ctx.ui.notify(`× workflow halted (${result.haltReason}): ${result.workingDir}`, "error");
        }
      } catch (err: unknown) {
        const e = err as { message?: string };
        ctx.ui.notify(`× /forge:run-workflow threw: ${e.message ?? "unknown"}`, "error");
      }
    },
  });
}
