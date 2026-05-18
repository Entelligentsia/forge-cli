// Native /forge:config handler — replaces the LLM-backed delegateMarkdownCommand
// stub that previously lived in forge-commands.ts.
//
// Plan 16 Slice 4a. The handler delegates to runConfigTui which is the same
// entry point used by the `forge config` bin subcommand — single source of
// truth for the routing config TUI / show flow.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runConfigTui } from "./config-tui/handler.js";

export interface RegisterConfigCommandOptions {
  /** When null, /forge:config is registered but only the routing-config bits
   *  are reachable — plugin-config display is hidden (no .forge to read).
   */
  forgeRoot: string | null;
}

export function registerConfigCommand(pi: ExtensionAPI, _opts: RegisterConfigCommandOptions): void {
  pi.registerCommand("forge:config", {
    description:
      "Inspect or change forge-cli routing config (persona-models, pipeline overrides) and view Forge project config",
    async handler(args, ctx) {
      // pi splits `args` as a single string; split on whitespace, drop empties.
      const argv = args.trim().length === 0 ? [] : args.trim().split(/\s+/);

      const exitCode = await runConfigTui(argv, process.cwd(), {
        // No-op stdout in pi-session context; notifications carry user-visible output.
        write: () => {},
        writeErr: (s) => ctx.ui.notify(s, "error"),
        ctx: {
          notify: (msg, level) => {
            const lvl = (level === "warning" || level === "error" ? level : "info") as
              | "info"
              | "warning"
              | "error";
            ctx.ui.notify(msg, lvl);
          },
        },
      });

      if (exitCode !== 0) {
        ctx.ui.notify(`forge:config exited with code ${exitCode}`, "warning");
      }
    },
  });
}
