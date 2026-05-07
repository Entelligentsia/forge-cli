# Custom Tools Reference

> **Purpose**: Detailed reference for all Forge `.cjs` tools wrapped as pi custom tools via `pi.registerTool()`.
> **Source Code**: `ToolDefinition` interface in [`types.ts:426`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts); `defineTool` helper in [`types.ts:484`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts); example in [`examples/extensions/dynamic-tools.ts`](../../pi-mono/packages/coding-agent/examples/extensions/dynamic-tools.ts).

## Design Rationale

Forge's `forge/tools/*.cjs` scripts are standalone Node scripts that read from `.forge/config.json` and the store. They can be invoked via bash directly, but wrapping them as pi custom tools provides:

- **Schema validation** — TypeBox parameters enforce correct usage (validated by pi before `execute()` is called)
- **Progress streaming** — `onUpdate` callback for long-running operations
- **Error handling** — Structured error results (`isError: true`) instead of raw stderr
- **UI rendering** — Custom `renderCall` / `renderResult` for rich display in the TUI
- **Tool discovery** — The LLM sees these in its tool list with descriptions and snippets
- **Prompt injection** — `promptSnippet` and `promptGuidelines` add tool usage hints to the system prompt

## ToolDefinition Anatomy

From [`types.ts:426`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts):

```typescript
interface ToolDefinition<TParams, TDetails, TState> {
  name: string;                    // LLM-callable tool name
  label: string;                   // Human-readable label for UI
  description: string;             // Description for LLM
  promptSnippet?: string;          // One-line snippet in default system prompt
  promptGuidelines?: string[];     // Guideline bullets appended to system prompt
  parameters: TSchema;             // TypeBox parameter schema
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;
  executionMode?: "sequential" | "parallel";
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
  renderCall?(args, theme, context): Component;
  renderResult?(result, options, theme, context): Component;
}
```

The `onUpdate` callback type is `AgentToolUpdateCallback<TDetails>` — see [`types.ts:426`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) and the re-export from `@mariozechner/pi-agent-core`.

## Tools Registry

### `forge_collate` — Regenerate Markdown Views

Regenerates all markdown views from the JSON store. Run after completing tasks or sprints.

```typescript
pi.registerTool({
  name: "forge_collate",
  label: "Forge Collate",
  description: "Regenerate markdown views from the JSON store. Run after completing tasks or sprints.",
  promptSnippet: "Use forge_collate to regenerate project indexes and timesheets",
  promptGuidelines: ["Use forge_collate after completing tasks or sprints to update all project views."],
  parameters: Type.Object({
    sprint_id: Type.Optional(Type.String({ description: "Sprint ID (e.g. S01). Omit for all." })),
    dry_run: Type.Optional(Type.Boolean({ description: "Preview changes without writing." })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const args = ["node", `${forgeRoot}/tools/collate.cjs`];
    if (params.sprint_id) args.push(params.sprint_id);
    if (params.dry_run) args.push("--dry-run");

    try {
      const result = execSync(args.join(" "), {
        cwd,
        encoding: "utf8",
        timeout: 30000,
        signal,
      });
      return {
        content: [{ type: "text", text: result || "Collation complete." }],
        details: { sprint_id: params.sprint_id, dry_run: params.dry_run ?? false },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Collation failed: ${err.stderr || err.message}` }],
        details: {},
        isError: true,
      };
    }
  },
});
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sprint_id` | `string?` | No | Sprint ID (e.g. `S01`). Omit for all sprints. |
| `dry_run` | `boolean?` | No | Preview changes without writing files. |

**Wraps**: `forge/tools/collate.cjs`
**Timeout**: 30 seconds

---

### `forge_store` — Query/Update the Forge Store

Manages SDLC entities (sprints, tasks, bugs, features, events) in the Forge JSON store.

```typescript
pi.registerTool({
  name: "forge_store",
  label: "Forge Store",
  description: "Query or update the Forge JSON store (sprints, tasks, bugs, events).",
  promptSnippet: "Use forge_store to create, read, or update sprint/task/bug records",
  promptGuidelines: ["Use forge_store to manage SDLC entities."],
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("read"),
      Type.Literal("update-status"),
      Type.Literal("list"),
      Type.Literal("emit"),
    ]),
    entity: Type.Union([
      Type.Literal("sprint"),
      Type.Literal("task"),
      Type.Literal("bug"),
      Type.Literal("feature"),
      Type.Literal("event"),
    ]),
    data: Type.Optional(Type.String({ description: "JSON data for create/update" })),
    id: Type.Optional(Type.String({ description: "Entity ID for read/update" })),
    filter: Type.Optional(Type.String({ description: "Filter expression (e.g. status=active)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const args = ["node", `${forgeRoot}/tools/store-cli.cjs`, params.action, params.entity];
    if (params.id) args.push(params.id);
    if (params.filter) args.push("--filter", params.filter);
    if (params.data) args.push(params.data);

    try {
      const result = execSync(args.join(" "), { cwd, encoding: "utf8", timeout: 10000, signal });
      return {
        content: [{ type: "text", text: result || "OK" }],
        details: { action: params.action, entity: params.entity },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Store operation failed: ${err.stderr || err.message}` }],
        details: {},
        isError: true,
      };
    }
  },
});
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `enum` | Yes | One of: `create`, `read`, `update-status`, `list`, `emit` |
| `entity` | `enum` | Yes | One of: `sprint`, `task`, `bug`, `feature`, `event` |
| `data` | `string?` | No | JSON string for create/update operations |
| `id` | `string?` | No | Entity ID for read/update operations |
| `filter` | `string?` | No | Filter expression (e.g. `status=active`) |

**Wraps**: `forge/tools/store-cli.cjs`
**Timeout**: 10 seconds

---

### `forge_validate_store` — Validate Store Integrity

```typescript
pi.registerTool({
  name: "forge_validate_store",
  label: "Forge Validate Store",
  description: "Validate Forge store integrity (required fields, referential integrity).",
  promptSnippet: "Use forge_validate_store to check store health",
  parameters: Type.Object({}),
  async execute() {
    const result = execSync(`node ${forgeRoot}/tools/validate-store.cjs`, { cwd, encoding: "utf8", timeout: 10000 });
    return { content: [{ type: "text", text: result }], details: {} };
  },
});
```

**Wraps**: `forge/tools/validate-store.cjs`
**Timeout**: 10 seconds

---

### `forge_config` — Get/Set Configuration

```typescript
pi.registerTool({
  name: "forge_config",
  label: "Forge Config",
  description: "Get or set Forge configuration values.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
    key: Type.String({ description: "Dot-notation config key (e.g. project.prefix)" }),
    value: Type.Optional(Type.String({ description: "Value to set (for set action)" })),
  }),
  async execute(_id, params) {
    const args = ["node", `${forgeRoot}/tools/manage-config.cjs`, params.action, params.key];
    if (params.action === "set" && params.value !== undefined) args.push(params.value);
    const result = execSync(args.join(" "), { cwd, encoding: "utf8", timeout: 5000 });
    return { content: [{ type: "text", text: result }], details: {} };
  },
});
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `enum` | Yes | `get` or `set` |
| `key` | `string` | Yes | Dot-notation config key (e.g. `project.prefix`) |
| `value` | `string?` | No | Value to set (required when action is `set`) |

**Wraps**: `forge/tools/manage-config.cjs`
**Timeout**: 5 seconds

## Common Patterns

### Error Handling Convention

All tool wrappers follow the same error pattern, matching `AgentToolResult` from [`types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts):

```typescript
try {
  const result = execSync(args.join(" "), { cwd, encoding: "utf8", timeout, signal });
  return { content: [{ type: "text", text: result || "OK" }], details: { ... } };
} catch (err: any) {
  return {
    content: [{ type: "text", text: `Operation failed: ${err.stderr || err.message}` }],
    details: {},
    isError: true,
  };
}
```

The `isError` field is part of `AgentToolResult` — the TUI renders error results differently. See the `isError` field usage in [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) renderResult.

### Argument Construction

All tool wrappers construct CLI arguments from the typed parameters:

```typescript
const args = ["node", `${forgeRoot}/tools/<tool>.cjs`, ...positionalArgs];
if (params.optionalFlag) args.push("--flag-name");
```

The `forgeRoot` is resolved by `discoverForgeRoot()` in the extension core and passed to `registerForgeTools()`.

### Progress Streaming

The `onUpdate` callback (`AgentToolUpdateCallback<TDetails>`) enables partial result streaming for long-running operations. Currently unused by forgecli's synchronous `execSync` wrappers, but available for future async tool implementations.

API: `AgentToolUpdateCallback` re-exported from `@mariozechner/pi-agent-core` — see [`types.ts:426`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) `execute()` parameter.

### Tool Naming Convention

| pi Tool Name | Forge `.cjs` Script | Purpose |
|---|---|---|
| `forge_collate` | `collate.cjs` | Regenerate markdown views |
| `forge_store` | `store-cli.cjs` | CRUD on SDLC entities |
| `forge_validate_store` | `validate-store.cjs` | Store integrity check |
| `forge_config` | `manage-config.cjs` | Configuration get/set |

All pi tool names use `forge_` prefix with underscores. All Forge scripts use hyphenated names.

## Source Code References

| Concept | Source File |
|---|---|
| `ToolDefinition<TParams, TDetails, TState>` | [`src/core/extensions/types.ts:426`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `defineTool()` helper for type inference | [`src/core/extensions/types.ts:484`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `AgentToolResult<TDetails>` return type | Re-exported from `@mariozechner/pi-agent-core` via [`types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `AgentToolUpdateCallback` (progress streaming) | Re-exported from `@mariozechner/pi-agent-core` via [`types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Dynamic tool registration example | [`examples/extensions/dynamic-tools.ts`](../../pi-mono/packages/coding-agent/examples/extensions/dynamic-tools.ts) |
| Tool with custom renderers (subagent) | [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| `pi.registerTool()` API method | [`src/core/extensions/types.ts:1116`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |