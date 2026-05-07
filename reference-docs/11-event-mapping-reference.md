# Event Mapping Complete Reference

> **Purpose**: The definitive mapping of every Claude Code hook to its pi extension event equivalent, with implementation notes and source code cross-references.
> **Source Code**: All event types in [`src/core/extensions/types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts); extension examples in [`examples/extensions/`](../../pi-mono/packages/coding-agent/examples/extensions/).

## Complete Mapping Table

| # | Claude Code Hook | pi Event | Implementation Notes |
|---|---|---|---|
| 1 | `hooks.json` → `SessionStart` → `check-update.js` | `pi.on("session_start")` — [`types.ts:1090`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Check `.forge/update-check-cache.json`; show notification via `ctx.ui.notify()` |
| 2 | `hooks.json` → `PreToolUse(Write\|Edit)` → `validate-write.js` | `pi.on("tool_call")` — [`types.ts:1123`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Intercept `WriteToolCallEvent` / `EditToolCallEvent`; return `{ block: true, reason: "..." }` (see [`ToolCallEventResult` at types.ts:984](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) |
| 3 | `hooks.json` → `PostToolUse(Bash)` → `triage-error.js` | `pi.on("tool_result")` — [`types.ts:1124`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | Observe `BashToolResultEvent`; if `isError === true`, modify content via `ToolResultEventResult.content` (see [`types.ts:998`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) |
| 4 | `hooks.json` → `PostToolUse(Bash)` → `query-logger.cjs` | `pi.on("tool_result")` filter by `forge_store` (custom tool) | Log all `CustomToolResultEvent` results from `forge_store` tool calls. **Bash invocations of `node forge/tools/store-cli.cjs ...` will not trigger** — agents must use the `forge_store` custom tool under pi |
| 5 | `hooks.json` → `PostToolUse(Bash)` → `post-init.cjs` | Extension `/forge:init` command handler | Detect init completion via deterministic phase markers; queue `/forge:enhance --phase 1 --auto` via `pi.sendUserMessage()` ([`types.ts:1187`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) |
| 6 | `hooks.json` → `PostToolUse(Bash)` → `post-sprint.cjs` | `pi.on("tool_result")` filter by `forge_collate` (custom tool) | Detect `--purge-events` flag in `CustomToolResultEvent` output; queue `/forge:enhance --phase 2`. **Bash invocations of `node forge/tools/collate.cjs ...` will not trigger** — agents must use the `forge_collate` custom tool under pi |
| 7 | `hooks.json` → `PermissionRequest(Bash\|Write\|...)` → `forge-permissions.js` | `pi.on("tool_call")` for block-with-reason; for interactive approve/deny, compose with `ctx.ui.confirm()` from `ExtensionUIContext` ([`types.ts:129`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) inside a registered command, or vendor the [`permission-gate`](../../pi-mono/packages/coding-agent/examples/extensions/permission-gate.ts) example | Raw `tool_call` cannot prompt — it only blocks. The Claude Code `PermissionRequest` UX must be reconstructed via either the permission-gate pattern or a command-driven `ui.confirm()` flow |

## Summary Mapping — What Forge Needs → What pi Provides

| What Forge Needs | What pi Provides | How | Source Reference |
|---|---|---|---|
| Slash commands | `pi.registerCommand()` | `/forge:init`, `/forge:health`, `/forge:enhance`, `/sprint-plan`, `/run-task` | [`types.ts:1142`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Custom tools | `pi.registerTool()` | `forge_collate`, `forge_store`, `forge_validate_store`, `forge_config` | [`types.ts:1133`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Hook interceptors | `pi.on("tool_call")`, `pi.on("tool_result")` | Write validation, error triage, post-init/post-sprint triggers | [`types.ts:1123-1124`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| System prompt injection | `pi.on("before_agent_start")` | KB context, phase instructions | [`types.ts:1110`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Multi-agent orchestration | Subagent extension (chain/parallel) — **vendor required**, lives in `examples/` not `src/core/` | Plan→Review→Implement→Review→Approve→Commit pipeline | [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| Persistent state | `pi.appendEntry()` | Sprint state, enhancement proposals, calibration baselines | [`types.ts:1193`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Agent personas | `.pi/agents/*.md` | Engineer, Supervisor, Architect, etc. with per-agent model/tool config | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| Prompt templates | `.pi/prompts/*.md` | `/plan`, `/implement`, `/review-code`, `/run-task`, `/sprint-plan` | [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts) |
| Skills | `.pi/skills/*/SKILL.md` | `refresh-kb-links`, `store-custodian` | [`src/core/skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts) |
| TUI branding | `ctx.ui.setStatus()`, `ctx.ui.setWidget()`, `ctx.ui.notify()` | Phase banners, sprint progress, Tomoshibi status | [`types.ts § ExtensionUIContext`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Headless operation | `createAgentSession()` | `forgecli init`, `forgecli run-task ACME-S01-T01` | [`src/core/sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts) |
| Session persistence | `SessionManager` | JSONL sessions with branching | [`src/core/session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts) |
| Package distribution | `DefaultResourceLoader` package discovery | One command to get forgecli everywhere pi is installed | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |

## Key Event Handler Return Types

When implementing `pi.on("tool_call")` and `pi.on("tool_result")`, the return types matter:

### `ToolCallEventResult` — for blocking tool calls

From [`types.ts:984`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts):

```typescript
interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean;
  reason?: string;
}
```

Return `{ block: true, reason: "..." }` to prevent the tool from executing. Mutate `event.input` in place to modify arguments (no re-validation after mutation). **This is block-only — there is no built-in "ask the user" path.** For interactive approval, drive `ctx.ui.confirm()` from a registered command, or adopt the [`permission-gate`](../../pi-mono/packages/coding-agent/examples/extensions/permission-gate.ts) example pattern.

### `ToolResultEventResult` — for modifying tool results

From [`types.ts:998`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts):

```typescript
interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}
```

Return this to override the result content, details, or error status.

### `BeforeAgentStartEventResult` — for injecting system prompt content

From [`types.ts:1009`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts):

```typescript
interface BeforeAgentStartEventResult {
  /** Append a custom message before the agent turn. */
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  /** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
  systemPrompt?: string;
}
```

Both fields are optional. `systemPrompt` replaces the system prompt for the turn (chained across extensions); `message` appends a custom message. Earlier sketches that read `event.systemPrompt + ...` from the input event should be treated as pseudocode — confirm the `BeforeAgentStartEvent` input shape during implementation.

## Extension Examples by Pattern

| Pattern | Example File | forgecli Usage |
|---|---|---|
| Tool-call blocking | [`examples/extensions/confirm-destructive.ts`](../../pi-mono/packages/coding-agent/examples/extensions/confirm-destructive.ts) | Validate-write hook |
| Bash spawn hook | [`examples/extensions/bash-spawn-hook.ts`](../../pi-mono/packages/coding-agent/examples/extensions/bash-spawn-hook.ts) | Error triage |
| Dynamic tool registration | [`examples/extensions/dynamic-tools.ts`](../../pi-mono/packages/coding-agent/examples/extensions/dynamic-tools.ts) | Register forge_collate, forge_store, etc. |
| Custom commands | [`examples/extensions/shutdown-command.ts`](../../pi-mono/packages/coding-agent/examples/extensions/shutdown-command.ts) | /forge:init, /forge:health |
| Send user messages | [`examples/extensions/send-user-message.ts`](../../pi-mono/packages/coding-agent/examples/extensions/send-user-message.ts) | Post-init/post-sprint triggers |
| System prompt injection | [`examples/extensions/system-prompt-header.ts`](../../pi-mono/packages/coding-agent/examples/extensions/system-prompt-header.ts) | KB context injection |
| Status line | [`examples/extensions/status-line.ts`](../../pi-mono/packages/coding-agent/examples/extensions/status-line.ts) | Phase banners, sprint progress |
| Multi-agent (subagent) | [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) | Run-task pipeline |
| Resource discovery | [`examples/extensions/dynamic-resources/`](../../pi-mono/packages/coding-agent/examples/extensions/dynamic-resources/) | Additional .pi/ paths |
| Tool override | [`examples/extensions/tool-override.ts`](../../pi-mono/packages/coding-agent/examples/extensions/tool-override.ts) | Override built-in tool behavior |

## Implementation Priority

### Phase 1 — Core (Must-Have for MVP)

1. **Extension core** (`extensions/forgecli/index.ts`) — Registration, Forge root discovery, KB injection
2. **Custom tools** (`extensions/forgecli/forge-tools.ts`) — `forge_collate`, `forge_store`, `forge_validate_store`, `forge_config`
3. **Hook dispatcher** (`extensions/forgecli/hook-dispatcher.ts`) — Write validation, post-sprint trigger
4. **Init orchestrator** (`extensions/forgecli/init-orchestrator.ts`) — 4-phase init command
5. **Forge source adaptation** — `substitute-placeholders.cjs` output mapping

### Phase 2 — Orchestration (Multi-Agent)

6. **Workflow runner** (`extensions/forgecli/workflow-runner.ts`) — `forge_run_task` tool, subagent chains
7. **Agent definitions** (`agents/*.md`) — Engineer, Supervisor, Architect
8. **Prompt templates** (`prompts/*.md`) — /plan, /implement, /review-code, etc.

### Phase 3 — CLI (Headless)

9. **Headless runner** (`bin/forgecli.ts`) — SDK-based CLI entry point
10. **Command routing** — init, run-task, sprint-plan, health, collate

### Phase 4 — Polish

11. **Error triage hook** — Parse bash errors, append diagnostic context
12. **Permission handling** — Auto-approve Forge tools, prompt for risky ops
13. **TUI branding** — Phase banners via `ctx.ui.setWidget()`
14. **Update checking** — Session start notification