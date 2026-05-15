import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";
import { runWorkflow } from "./engine.js";
import { getSessionRegistry } from "../session-registry.js";

export interface RegisterRunWorkflowOptions {
  cwd?:                  string;
  /** Explicit single search dir. If set, overrides the CWD-first/bundled-fallback resolution. */
  workflowsDir?:         string;
  /** Bundled workflows shipped with the package — used as fallback when CWD/workflows/<id> doesn't exist. */
  bundledWorkflowsDir?:  string;
}

export function registerRunWorkflow(pi: ExtensionAPI, options: RegisterRunWorkflowOptions = {}): void {
  pi.registerCommand("forge:run-workflow", {
    description:
      "Run a generic workflow defined in workflows/<workflowId>/workflow.yaml. " +
      "Resolution: CWD/workflows/<id> first, then bundled examples. " +
      "Usage: /forge:run-workflow <workflowId> [entryPrompt...]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const cwd = options.cwd ?? process.cwd();

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("× /forge:run-workflow — workflowId required. Usage: /forge:run-workflow <workflowId> [prompt]", "error");
        return;
      }
      const [workflowId, ...rest] = trimmed.split(/\s+/);
      const entryPrompt = rest.join(" ");

      // Resolve workflowsDir: explicit override > CWD/workflows (if it has the id) > bundled fallback
      let workflowsDir: string | undefined;
      if (options.workflowsDir) {
        workflowsDir = options.workflowsDir;
      } else {
        const cwdCandidate = path.join(cwd, "workflows");
        if (fs.existsSync(path.join(cwdCandidate, workflowId, "workflow.yaml"))) {
          workflowsDir = cwdCandidate;
        } else if (options.bundledWorkflowsDir) {
          workflowsDir = options.bundledWorkflowsDir;
        } else {
          workflowsDir = cwdCandidate;   // last resort — will surface a clear not-found error
        }
      }

      try {
        const result = await runWorkflow({
          workflowsDir,
          workflowId,
          cwd,
          entryPrompt,
          notify: (line) => ctx.ui.notify(line, "info"),
          registry: getSessionRegistry(),
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
