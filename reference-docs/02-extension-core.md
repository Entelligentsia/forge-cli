# Extension Core Reference

> **Purpose**: The main extension entry point — registration glue, Forge root discovery, KB context injection, lifecycle management.
> **Source Code**: Extension API types in [`types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts); SDK in [`sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts); pattern examples in [`examples/extensions/`](../../pi-mono/packages/coding-agent/examples/extensions/).

## File: `extensions/forgecli/index.ts`

This is the heart of forgecli. It:

1. **Discovers the Forge plugin root** from `.forge/config.json` (same as Forge's `forgeRef` resolution)
2. **Registers all Forge's `.cjs` tools** as pi custom tools
3. **Registers Forge commands** as pi slash commands
4. **Intercepts tool calls** to implement write-validation and error-triage hooks
5. **Registers Forge's agent personas** as pi agent definitions in `.pi/agents/`
6. **Manages lifecycle events** (post-init, post-sprint enhancement triggers)

## Complete Reference Implementation

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { registerForgeTools } from "./forge-tools.js";
import { registerForgeCommands } from "./forge-commands.js";
import { registerForgeHooks } from "./hook-dispatcher.js";
import { discoverForgeRoot } from "./forge-root.js";

export default function(pi: ExtensionAPI) {
  // ─── Resolve forge root ────────────────────────────────────────────
  // The forge root is the installed plugin directory containing meta/,
  // init/, tools/, etc. Same resolution as FORGE_ROOT in the Claude plugin.
  const forgeRoot = discoverForgeRoot();
  if (!forgeRoot) return; // Not in a Forge-initialized project — noop

  const configPath = path.join(process.cwd(), ".forge", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const kbPath = config.paths?.engineering ?? "engineering";

  // ─── Register custom tools (wrapping forge/tools/*.cjs) ─────────────
  registerForgeTools(pi, forgeRoot, config);

  // ─── Register slash commands ────────────────────────────────────────
  registerForgeCommands(pi, forgeRoot, config);

  // ─── Register hook interceptors ─────────────────────────────────────
  registerForgeHooks(pi, forgeRoot, config);

  // ─── Inject Forge system context ───────────────────────────────────
  // ExtensionAPI.on("before_agent_start") → BeforeAgentStartEvent
  // Handler registration: types.ts:1110
  // BeforeAgentStartEventResult: types.ts:1009 — supports both `systemPrompt?: string`
  // (replace system prompt) and `message?: Pick<CustomMessage, "customType"|"content"|"display"|"details">`
  // (append a custom message). The `event.systemPrompt` access below is illustrative pseudocode —
  // verify the actual BeforeAgentStartEvent shape during implementation before depending on it.
  pi.on("before_agent_start", async (event, ctx) => {
    // Inject KB context into the system prompt, same as Forge's
    // refresh-kb-links skill does for CLAUDE.md
    const masterIndex = path.join(process.cwd(), kbPath, "MASTER_INDEX.md");
    if (fs.existsSync(masterIndex)) {
      return {
        systemPrompt: event.systemPrompt + "\n\n## Forge KB\n\n" +
          `Knowledge base at ${kbPath}/. Use /forge:ask or read ${kbPath}/MASTER_INDEX.md for context.`,
      };
    }
  });

  // ─── Session start: ensure agents are available ─────────────────────
  // ExtensionAPI.on("session_start") → SessionStartEvent
  // Handler registration: types.ts:1090; event def: types.ts:514
  pi.on("session_start", async (_event, ctx) => {
    // Copy Forge's generated agent prompts into .pi/agents/ if not present
    // This makes them available to the subagent tool for multi-agent workflows
    ensureAgentsAvailable(forgeRoot, config);
  });
}
```

## Key Design Decisions

### No-Op Outside Forge Projects

If `discoverForgeRoot()` returns null (no `.forge/config.json` found), the entire extension becomes a no-op. This means forgecli can be installed globally without interfering with non-Forge pi sessions.

Pattern: same as [`examples/extensions/dirty-repo-guard.ts`](../../pi-mono/packages/coding-agent/examples/extensions/dirty-repo-guard.ts) — extension conditionally activates based on project state.

### Single Entry Point, Modular Delegates

The `index.ts` file is a thin orchestrator. All substantive logic is delegated to:

| Module | Responsibility |
|---|---|
| `forge-tools.ts` | Register `forge_collate`, `forge_store`, `forge_validate_store`, `forge_config` as pi tools |
| `forge-commands.ts` | Register `/forge:init`, `/forge:health`, `/forge:enhance`, etc. as pi commands |
| `hook-dispatcher.ts` | Intercept `tool_call`/`tool_result` events for write validation, error triage, lifecycle triggers |
| `init-orchestrator.ts` | Drive the 4-phase init flow programmatically |

Pattern: same as [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) — single `export default function` with delegated modules.

### KB Context Injection

The `before_agent_start` event handler appends knowledge base context to the system prompt. This mirrors Forge's `refresh-kb-links` skill behavior — the agent always knows the KB exists and where to find it.

API: `BeforeAgentStartEventResult` — see [`types.ts:1009`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts). The result type carries an optional `systemPrompt?: string` (replaces the system prompt for the turn — chained when multiple extensions return it) and an optional `message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">` (appends a custom message). Treat any `event.systemPrompt + ...` snippet here as pseudocode; confirm the input event shape before relying on string concatenation.

Pattern reference: [`examples/extensions/system-prompt-header.ts`](../../pi-mono/packages/coding-agent/examples/extensions/system-prompt-header.ts) injects a header into the system prompt the same way.

### Agent Availability

On `session_start`, the extension ensures generated agent definitions (`.pi/agents/*.md`) are present. If they haven't been materialized yet (pre-init), this is a no-op.

The `session_start` event also fires with a `reason` field (`"startup" | "reload" | "new" | "resume" | "fork"`) — see [`types.ts:514`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts).

## Dependency: `discoverForgeRoot()`

```typescript
// forge-root.ts
import * as path from "node:path";
import * as fs from "node:fs";

export function discoverForgeRoot(): string | null {
  // 1. Check .forge/config.json for explicit paths.forgeRoot
  const configPath = path.join(process.cwd(), ".forge", "config.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (config.paths?.forgeRoot) {
      return path.resolve(process.cwd(), config.paths.forgeRoot);
    }
  }
  // 2. Fallback: walk up directory tree looking for .forge/config.json
  //    (pattern: same as findNearestProjectAgentsDir in
  //     examples/extensions/subagent/agents.ts)
  return null;
}
```

The `findNearestProjectAgentsDir()` walk-up pattern in [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) is the direct model for this.

## Extension API Methods Used

| Method | Source Reference | forgecli Usage |
|---|---|---|
| `pi.on("before_agent_start")` | [`types.ts:1110`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Inject KB context into system prompt |
| `pi.on("session_start")` | [`types.ts:1090`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Ensure agents are available |
| `pi.registerTool()` | [`types.ts:1133`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Register forge_collate, forge_store, etc. |
| `pi.registerCommand()` | [`types.ts:1142`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Register /forge:init, /forge:health, etc. |
| `pi.on("tool_call")` | [`types.ts:1123`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Write validation hook |
| `pi.on("tool_result")` | [`types.ts:1124`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Post-sprint trigger, error triage |