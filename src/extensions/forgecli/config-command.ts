// Native /forge:config handler — replaces the LLM-backed delegateMarkdownCommand
// stub that previously lived in forge-commands.ts.
//
// Plan 16 Slice 4a + 4b. The handler delegates to runConfigTui which is the
// same entry point used by the `forge config` bin subcommand — single source
// of truth for the routing config TUI / show flow. The wrapper supplies a
// `mountConfigTui` callback that uses ctx.ui.custom() to overlay the TUI.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigTuiComponent } from "./config-tui/component.js";
import { runConfigTui } from "./config-tui/handler.js";
import type { InitOptions } from "./config-tui/state.js";

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
      const argv = args.trim().length === 0 ? [] : args.trim().split(/\s+/);

      const mountConfigTui = async (init: InitOptions): Promise<number> => {
        const exitCode = await ctx.ui.custom<number>((_tui, _theme, _kb, done) => {
          // Component drives done() on q or successful confirm-quit.
          const component = createConfigTuiComponent({
            ...init,
            onExit: (code) => done(code),
            onSaved: (target) => ctx.ui.notify(`forge config: saved → ${target}`, "info"),
            onError: (msg) => ctx.ui.notify(`forge config: ${msg}`, "error"),
          });
          return component;
        }, { overlay: true });
        return exitCode;
      };

      const exitCode = await runConfigTui(argv, process.cwd(), {
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
          mountConfigTui,
        },
      });

      if (exitCode !== 0) {
        ctx.ui.notify(`forge:config exited with code ${exitCode}`, "warning");
      }
    },
  });
}
