# Hook Dispatcher Reference

> **Purpose**: Translates pi extension events into Forge hook semantics — write validation, error triage, post-init/post-sprint lifecycle triggers, and permission handling.
> **Source Code**: Tool event types in [`types.ts:772-908`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) (`ToolCallEvent` at 772, `ToolResultEvent` at 833); blocking example in [`examples/extensions/confirm-destructive.ts`](../../pi-mono/packages/coding-agent/examples/extensions/confirm-destructive.ts); bash hook example in [`examples/extensions/bash-spawn-hook.ts`](../../pi-mono/packages/coding-agent/examples/extensions/bash-spawn-hook.ts).

> **Important — bash-pattern hooks under pi**: Forge's `post-init.cjs`, `post-sprint.cjs`, and `query-logger.cjs` currently key off **bash command pattern matches** (Claude Code's `PostToolUse(Bash)` hook + match field). Under pi the equivalent requires routing those operations through wrapped custom tools (`forge_collate`, `forge_store`) and filtering on `tool_result`. Raw `node forge/tools/store-cli.cjs ...` invocations issued via the bash tool will **not** trigger these hooks. The agent personas must be instructed to use the `forge_*` tools rather than bash for store/collate operations under pi.

> **Important — permission semantics ≠ Claude Code 1:1**: pi's `tool_call` event only supports block-with-reason (`{ block: true, reason: "..." }`) — it is not an interactive approve/deny dialog. Mapping Claude Code's `PermissionRequest(Bash|Write|...)` requires either (a) the [`examples/extensions/permission-gate.ts`](../../pi-mono/packages/coding-agent/examples/extensions/permission-gate.ts) extension as a model, or (b) composing `tool_call` with `ctx.ui.confirm()` from `ExtensionUIContext` ([`types.ts:129`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) inside a slash command — not raw `tool_call` filtering alone.

## File: `extensions/forgecli/hook-dispatcher.ts`

## Event Mapping Overview

Forge's hooks in `forge/hooks/` are Claude Code hook protocol scripts. In pi, the same semantics are achieved via extension event handlers:

| # | Claude Code Hook | pi Event | Implementation |
|---|---|---|---|
| 1 | `hooks.json` → `SessionStart` → `check-update.js` | `pi.on("session_start")` | Check update-check-cache.json; show notification |
| 2 | `hooks.json` → `PreToolUse(Write\|Edit)` → `validate-write.js` | `pi.on("tool_call")` filter by write/edit | Check protected paths, block or allow |
| 3 | `hooks.json` → `PostToolUse(Bash)` → `triage-error.js` | `pi.on("tool_result")` filter by bash | Parse exit code; if error, append diagnostic context |
| 4 | `hooks.json` → `PostToolUse(Bash)` → `query-logger.cjs` | `pi.on("tool_result")` filter by forge_store | Log all store operations |
| 5 | `hooks.json` → `PostToolUse(Bash)` → `post-init.cjs` | Extension `/forge:init` command handler | Detect init completion; queue enhancement |
| 6 | `hooks.json` → `PostToolUse(Bash)` → `post-sprint.cjs` | `pi.on("tool_result")` filter by forge_collate | Detect `--purge-events`; queue enhancement |
| 7 | `hooks.json` → `PermissionRequest` → `forge-permissions.js` | `pi.on("tool_call")` + `ctx.ui.confirm()` (or `permission-gate` extension pattern) | Raw `tool_call` only blocks with reason; interactive approve/deny needs `ctx.ui.confirm()` composed in a command, or vendor the [`permission-gate`](../../pi-mono/packages/coding-agent/examples/extensions/permission-gate.ts) example |

## Reference Implementation

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerForgeHooks(pi: ExtensionAPI, forgeRoot: string, config: Record<string, any>) {
  const cwd = process.cwd();

  // ═══════════════════════════════════════════════════════════════════
  // validate-write hook
  // Forge's validate-write.js blocks writes to protected paths.
  // In pi, we intercept write/edit tool calls via ToolCallEvent.
  // See: types.ts — ToolCallEvent discriminated union (lines 772-832)
  // ═══════════════════════════════════════════════════════════════════
  pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
    // Type guard: only intercept write and edit tool calls
    // See: types.ts — WriteToolCallEvent, EditToolCallEvent
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const filePath = (event.input as any).file_path || (event.input as any).path;
    if (!filePath) return undefined;

    const resolved = path.resolve(cwd, filePath);
    const isStore = resolved.startsWith(path.join(cwd, ".forge", "store"));

    if (isStore) {
      // ToolCallEventResult.block prevents execution
      // See: types.ts — ToolCallEventResult (line 984)
      return { block: true, reason: "Use the forge_store tool for store operations, not direct file writes." };
    }
    return undefined;
  });

  // ═══════════════════════════════════════════════════════════════════
  // post-sprint enhancement trigger
  // Observes tool_result events from forge_collate.
  // See: types.ts — ToolResultEvent (lines 833-908), CustomToolResultEvent
  // ═══════════════════════════════════════════════════════════════════
  pi.on("tool_result", async (event, ctx) => {
    // Only observe results from forge_collate (a custom tool)
    if (event.toolName !== "forge_collate") return;

    const content = event.content.find(c => c.type === "text");
    if (!content || content.type !== "text") return;

    if (content.text.includes("--purge-events") || content.text.includes("S0")) {
      // ExtensionAPI.sendUserMessage() — see types.ts:1187
      pi.sendUserMessage("/forge:enhance --phase 2", { deliverAs: "followUp" });
    }
  });
}
```

## Hook Details

### Write Validation (`validate-write`)

**Purpose**: Prevent direct file writes to the Forge store directory. Store mutations must use the `forge_store` tool to maintain integrity.

**Implementation pattern**: Similar to [`examples/extensions/confirm-destructive.ts`](../../pi-mono/packages/coding-agent/examples/extensions/confirm-destructive.ts) which also intercepts tool calls.

**Logic**:
1. Intercept all `write` and `edit` tool calls — uses `ToolCallEvent` discriminated union
2. Resolve the target file path from `event.input`
3. If path is inside `.forge/store/` → **block** with `{ block: true, reason: "..." }` (see `ToolCallEventResult.block`)
4. If path is inside `.forge/workflows/` → **flag for caution**

**Key API types**:
- `WriteToolCallEvent` — [`types.ts:791`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)
- `EditToolCallEvent` — [`types.ts:786`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)
- `ToolCallEventResult.block` — [`types.ts:984`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)

### Error Triage (`triage-error`)

**Purpose**: After a bash command fails, append structured diagnostic context.

**Implementation pattern**: Similar to [`examples/extensions/bash-spawn-hook.ts`](../../pi-mono/packages/coding-agent/examples/extensions/bash-spawn-hook.ts) which observes bash tool results.

**Logic**:
1. Listen for `tool_result` events where `toolName === "bash"`
2. If `isError` is true, parse the stderr
3. Return modified content via `ToolResultEventResult.content`

**Key API types**:
- `BashToolResultEvent` — [`types.ts:840`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)
- `ToolResultEventResult.content` — [`types.ts:998`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)

### Post-Init Trigger (`post-init`)

**Purpose**: After Forge init completes, automatically queue Phase 1 enhancement.

**Implementation**: Handled in the `/forge:init` command handler (in `forge-commands.ts`), not as an event hook. After init completes:
```typescript
pi.sendUserMessage("/forge:enhance --phase 1 --auto", { deliverAs: "followUp" });
```

**Key API**: `ExtensionAPI.sendUserMessage()` — [`types.ts:1187`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)

### Post-Sprint Trigger (`post-sprint`)

**Purpose**: After collating a sprint with `--purge-events`, automatically queue Phase 2 enhancement.

**Implementation**: Observes `CustomToolResultEvent` from `forge_collate`.

**Key API types**:
- `CustomToolResultEvent` — [`types.ts:875`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)
- `ToolResultEventResult` — [`types.ts:998`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)

### Permission Handling (`forge-permissions`)

**Purpose**: Auto-approve deterministic Forge tool operations; prompt the user for risky operations.

**Implementation pattern**: Raw `tool_call` returns `{ block: true, reason }` only — it cannot prompt. Interactive approve/deny is implemented either by composing `tool_call` interception with `ctx.ui.confirm()` from `ExtensionUIContext` — [`types.ts:129`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) — within a registered command flow, or by adopting the [`examples/extensions/permission-gate.ts`](../../pi-mono/packages/coding-agent/examples/extensions/permission-gate.ts) pattern. The Forge `forge-permissions.json` rule format must be translated into either explicit allow/block branches (decisions known at registration time) or a small policy engine evaluated inside the handler.

**Logic**:
- Auto-approve (`tool_call` returns undefined → allow): `forge_store`, `forge_collate`, `forge_validate_store`, `forge_config`, reads
- Block (`tool_call` returns `{ block: true, reason }`): Direct writes to `.forge/store/`
- Confirm (custom command + `ctx.ui.confirm()`): Risky operations such as `rm`, `git push --force`, etc.

## Source Code References

| Concept | Source File |
|---|---|
| `ToolCallEvent` discriminated union | [`types.ts:772-832`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ToolResultEvent` discriminated union | [`types.ts:833-908`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ToolCallEventResult` (block/reason) | [`types.ts:984`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ToolResultEventResult` (content override) | [`types.ts:998`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `isToolCallEventType()` type guard | [`types.ts:934`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `pi.on("tool_call")` registration | [`types.ts:1123`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `pi.on("tool_result")` registration | [`types.ts:1124`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `pi.sendUserMessage()` | [`types.ts:1187`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Tool-call blocking example | [`examples/extensions/confirm-destructive.ts`](../../pi-mono/packages/coding-agent/examples/extensions/confirm-destructive.ts) |
| Bash hook example | [`examples/extensions/bash-spawn-hook.ts`](../../pi-mono/packages/coding-agent/examples/extensions/bash-spawn-hook.ts) |
| `ExtensionUIContext.confirm()` | [`types.ts:129`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Permission-gate example | [`examples/extensions/permission-gate.ts`](../../pi-mono/packages/coding-agent/examples/extensions/permission-gate.ts) |