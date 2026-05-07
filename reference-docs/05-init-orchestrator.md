# Init Orchestrator Reference

> **Purpose**: The 4-phase init process — how `forge:init` drives pi sessions programmatically through Collect → Discover → Materialize → Register.
> **Source Code**: Command registration via `pi.registerCommand()` in [`types.ts:1139`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts); `ExtensionCommandContext` in [`types.ts:333`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts); `session.prompt()` in [`agent-session.ts:967`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts); `ctx.ui.setStatus()` / `ctx.ui.notify()` in [`types.ts:124`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts).

## File: `extensions/forgecli/init-orchestrator.ts`

## Overview

Forge's init flow is a 4-phase process that combines LLM-driven discovery with deterministic file generation. In the Claude Code plugin, this runs as a single monolithic prompt. In pi, the orchestration is **programmatic** — the extension drives each phase via `session.prompt()` (in headless mode) or `ctx.sendUserMessage()` (in interactive mode).

## The Four Phases

| Phase | Name | Type | Duration | Description |
|---|---|---|---|---|
| 1 | **Collect** | LLM | ~2-5 min | Run 5 discovery scans (stack, processes, database, routing, testing) |
| 2 | **Discover** | LLM | ~5-10 min | Generate 7 knowledge base documents from discovery results |
| 3 | **Materialize** | Deterministic | ~1 sec | Substitute placeholders, build overlay, create project structure |
| 4 | **Register** | Deterministic | ~1 sec | Version management, manifest, persona/context packs, seed store |

## Command Registration

Commands are registered via `pi.registerCommand()` — see [`types.ts:1139`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) and `RegisteredCommand` interface:

```typescript
export interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
```

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export function registerForgeInitCommand(pi: ExtensionAPI, forgeRoot: string) {
  pi.registerCommand("forge:init", {
    description: "Bootstrap a complete AI-SDLC for the current project",
    getArgumentCompletions: (prefix: string) => {
      return [
        { value: "--fast", label: "Fast mode (equivalent to full, base-pack only)" },
        { value: "--full", label: "Full mode (equivalent to base-pack)" },
      ].filter(i => i.value.startsWith(prefix));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // ... (see full handler below)
    },
  });
}
```

## Full Handler

The handler uses `ExtensionCommandContext` ([`types.ts:333`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) which extends `ExtensionContext` with session control methods:

- `ctx.waitForIdle()` — wait for the agent to finish streaming
- `ctx.ui.notify()` — show status notifications
- `ctx.ui.setStatus()` — set status bar text
- `ctx.sendUserMessage()` — send a user message to the agent (only available on `ReplacedSessionContext`)

For interactive mode, use `pi.sendUserMessage()` from `ExtensionAPI` — [`types.ts:1153`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts).

```typescript
handler: async (args: string, ctx: ExtensionCommandContext) => {
  const cwd = ctx.cwd;

  // ─── Pre-flight checks ──────────────────────────────────────────
  if (fs.existsSync(path.join(cwd, ".forge", "config.json"))) {
    // ExtensionUIContext.confirm() — types.ts:128
    const resume = await ctx.ui.confirm(
      "Existing .forge/config.json detected",
      "Resume from previous init? (No = start over)"
    );
    if (resume) {
      // Check init-progress.json for phase
      // ... resume logic
      return;
    }
    ctx.ui.notify("Removing existing .forge/ directory...", "info");
  }

  // ─── Phase 1: Collect ──────────────────────────────────────────
  // ExtensionUIContext.notify() and setStatus() — types.ts § ExtensionUIContext
  ctx.ui.notify("Phase 1/4: Collect — Running 5 discovery scans...", "info");
  ctx.ui.setStatus("forge:init", "Phase 1/4: Collect");

  const stackPrompt = fs.readFileSync(
    path.join(forgeRoot, "init/discovery/discover-stack.md"), "utf8"
  );

  // Use pi.sendUserMessage() to drive the agent — types.ts:1153
  pi.sendUserMessage(`
Run the following 5 discovery scans in parallel using the subagent tool:

1. **Stack discovery**: ${stackPrompt}
2. **Processes discovery**: ...
3. **Database discovery**: ...
4. **Routing discovery**: ...
5. **Testing discovery**: ...

Write the combined discovery results to .forge/init-context.md and assemble .forge/config.json.
  `);

  // ─── Phase 2: Discover ─────────────────────────────────────────
  ctx.ui.notify("Phase 2/4: Discover — Generating knowledge base...", "info");
  ctx.ui.setStatus("forge:init", "Phase 2/4: Discover");

  pi.sendUserMessage(`
Read and follow the rulebook at ${forgeRoot}/init/generation/generate-kb-doc.md exactly.
Generate all 7 knowledge base documents as specified. Use subagent parallelism for the leaf docs.
  `);

  // ─── Phase 3: Materialize (deterministic) ──────────────────────
  ctx.ui.notify("Phase 3/4: Materialize — Substituting placeholders...", "info");
  ctx.ui.setStatus("forge:init", "Phase 3/4: Materialize");

  execSync(`node ${forgeRoot}/tools/substitute-placeholders.cjs ` +
    `--forge-root ${forgeRoot} --base-pack ${forgeRoot}/init/base-pack ` +
    `--config .forge/config.json --context .forge/project-context.json --out .`,
    { cwd, encoding: "utf8" });

  execSync(`node ${forgeRoot}/tools/build-overlay.cjs --task INIT-SMOKE-TEST --format json`,
    { cwd, encoding: "utf8" });

  // ─── Phase 4: Register (deterministic) ─────────────────────────
  ctx.ui.notify("Phase 4/4: Register — Finalizing...", "info");
  ctx.ui.setStatus("forge:init", "Phase 4/4: Register");

  execSync(`node ${forgeRoot}/tools/manage-versions.cjs init`, { cwd, encoding: "utf8" });
  execSync(`node ${forgeRoot}/tools/generation-manifest.cjs record-all`, { cwd, encoding: "utf8" });
  execSync(`node ${forgeRoot}/tools/build-persona-pack.cjs --out .forge/cache/persona-pack.json`, { cwd, encoding: "utf8" });
  execSync(`node ${forgeRoot}/tools/build-context-pack.cjs --arch-dir ${kbPath}/architecture --out-md .forge/cache/context-pack.md --out-json .forge/cache/context-pack.json`, { cwd, encoding: "utf8" });
  execSync(`node ${forgeRoot}/tools/build-init-context.cjs --config .forge/config.json --personas .forge/personas --templates .forge/templates --kb ${kbPath} --out .forge/init-context.md --json-out .forge/init-context.json`, { cwd, encoding: "utf8" });
  execSync(`node ${forgeRoot}/tools/seed-store.cjs`, { cwd, encoding: "utf8" });

  // Write update-check cache
  const pluginPkg = JSON.parse(fs.readFileSync(path.join(forgeRoot, ".claude-plugin/plugin.json"), "utf8"));
  const cache = { lastChecked: new Date().toISOString(), installedVersion: pluginPkg.version, latestVersion: pluginPkg.version, upToDate: true };
  fs.mkdirSync(path.join(cwd, ".forge"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".forge/update-check-cache.json"), JSON.stringify(cache, null, 2) + "\n");

  // Clean up init-progress
  fs.unlinkSync(path.join(cwd, ".forge/init-progress.json"));

  ctx.ui.setStatus("forge:init", undefined); // Clear status
  ctx.ui.notify("✓ Forge init complete! Run /sprint-plan to start.", "success");

  // Trigger enhance --phase 1 — deliverAs: "followUp" queues after current turn
  pi.sendUserMessage("/forge:enhance --phase 1 --auto", { deliverAs: "followUp" });
}
```

## `deliverAs` Options

When queuing messages via `pi.sendUserMessage()` ([`types.ts:1153`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)):

| `deliverAs` | Behavior |
|---|---|
| `"steer"` | Inject as a steering message during the current turn |
| `"followUp"` | Queue as a follow-up message after the current turn completes |

## Phase Details

### Phase 1: Collect
- **Input**: Discovery prompts from `forge/init/discovery/*.md`
- **Process**: LLM runs 5 scans via subagent parallel spawning
- **Output**: `.forge/init-context.md`, `.forge/config.json`, `.forge/project-context.json`
- **Mode**: LLM-driven

### Phase 2: Discover
- **Input**: Generation prompts from `forge/init/generation/*.md` + Phase 1 outputs
- **Process**: LLM generates 7 knowledge base documents using subagent parallelism
- **Output**: `engineering/` directory populated with KB docs
- **Mode**: LLM-driven

### Phase 3: Materialize
- **Input**: `.forge/config.json`, base-pack templates from `forge/init/base-pack/`
- **Process**: Deterministic substitution of `{{KEY}}` placeholders + overlay building
- **Output**: `.forge/personas/`, `.forge/workflows/`, `.forge/templates/`, `.pi/agents/`, `.pi/prompts/`
- **Tools used**:
  - `substitute-placeholders.cjs --forge-root --base-pack --config --context --out`
  - `build-overlay.cjs --task --format`
- **Mode**: Deterministic (no LLM)

### Phase 4: Register
- **Input**: Generated project structure
- **Process**: Version stamping, manifest recording, pack building, store seeding
- **Output**: `.forge/versions.json`, `.forge/generation-manifest.json`, `.forge/cache/`, `.forge/store/`
- **Tools used**: `manage-versions.cjs`, `generation-manifest.cjs`, `build-persona-pack.cjs`, `build-context-pack.cjs`, `build-init-context.cjs`, `seed-store.cjs`
- **Mode**: Deterministic (no LLM)

## Resumption Logic

If `init-progress.json` exists (from a previous interrupted init), the handler should read the phase number and skip completed phases. This mirrors Forge's existing init-progress tracking, which writes phase completion status between phases.

## Source Code References

| Concept | Source File |
|---|---|
| `pi.registerCommand()` | [`types.ts:1139`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `RegisteredCommand` interface | [`types.ts:475`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ExtensionCommandContext` | [`types.ts:333`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ExtensionUIContext.notify()` | [`types.ts:128`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ExtensionUIContext.setStatus()` | [`types.ts:134`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ExtensionUIContext.confirm()` | [`types.ts:126`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `pi.sendUserMessage()` | [`types.ts:1153`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `session.prompt()` | [`agent-session.ts:967`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts) |
| Command example | [`examples/extensions/shutdown-command.ts`](../../pi-mono/packages/coding-agent/examples/extensions/shutdown-command.ts) |
| Send user message example | [`examples/extensions/send-user-message.ts`](../../pi-mono/packages/coding-agent/examples/extensions/send-user-message.ts) |
| Status line example | [`examples/extensions/status-line.ts`](../../pi-mono/packages/coding-agent/examples/extensions/status-line.ts) |