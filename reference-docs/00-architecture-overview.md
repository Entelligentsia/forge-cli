# Forge-CLI Architecture Overview

> **Purpose**: Top-level reference for the forgecli architecture — the insight, the capability mapping, and the integration strategy.
> **Source Code**: All pi API references point to `pi-mono/packages/coding-agent/` unless otherwise noted.

## The Core Insight

The `pi-coding-agent` extension system provides everything Forge needs. **Forge does not need a new agent runtime.** The pi extension system IS the bridge bar (Forge's term for the controller/orchestrator layer).

Instead of building a new agent core from scratch, forgecli wraps the existing Forge plugin as a pi package, bridging Forge's concepts directly to pi's primitives via a thin extension layer (~900 lines of new code).

## Capability Mapping — Forge Concepts → pi Primitives

| Forge Concept | pi-Coding-Agent Equivalent | Source Reference |
|---|---|---|
| `/forge:init` orchestration | SDK `session.prompt()` + extension `before_agent_start` to inject workflow | [`agent-session.ts:967`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts), [`types.ts:624`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Forge's tool set (bash, read, write, edit) | Built-in pi tools (read, bash, edit, write, grep, find, ls) | [`src/core/tools/`](../../pi-mono/packages/coding-agent/src/core/tools/) |
| Forge's subagent spawning (Engineer, Architect, etc.) | Subagent extension (chain/parallel modes) | [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| Forge's hooks (validate-write, post-init, post-sprint) | Extension `tool_call` / `tool_result` event handlers | [`types.ts:814-932`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Forge's store-cli.cjs, collate.cjs | Custom tools via `pi.registerTool()` | [`types.ts:1133`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Forge's Tomoshibi concierge | Extension command via `pi.registerCommand()` | [`types.ts:1142`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Forge's phase banners and progress | Extension widgets, `ctx.ui.setStatus()`, `ctx.ui.notify()` | [`types.ts:124`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) § ExtensionUIContext |
| Forge's store/event emission | `pi.appendEntry()` for custom persistent state | [`types.ts:1193`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Forge's `FORGE_ROOT` path resolution | `pi -e ./path/to/extension.ts` + resource discovery | [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| Forge's banners.cjs terminal output | `ctx.ui.notify()` / `ctx.ui.setWidget()` | [`types.ts § ExtensionUIContext`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Slash commands | `pi.registerCommand()` | [`types.ts:1142`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| System prompt injection | `pi.on("before_agent_start")` | [`types.ts:1110`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Multi-agent orchestration | Subagent extension chain/parallel | [`examples/extensions/subagent/`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/) |
| Persistent state | `pi.appendEntry()` | [`types.ts:1193`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Agent personas | `.pi/agents/*.md` with YAML frontmatter | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| Prompt templates | `.pi/prompts/*.md` | [`prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts) |
| Skills | `.pi/skills/*/SKILL.md` | [`skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts) |
| TUI branding | `ctx.ui.setStatus()`, `ctx.ui.setWidget()`, `ctx.ui.notify()` | [`types.ts § ExtensionUIContext`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| Headless operation | `createAgentSession()` | [`sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts) |
| Session persistence | `SessionManager` (JSONL sessions with branching) | [`session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts) |
| Package distribution | `DefaultResourceLoader` package discovery | [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |

## What Changes in `forge/`

**Almost nothing.** The existing Forge plugin source tree remains fully compatible. Adaptations required:

1. **Agent output format** — `substitute-placeholders.cjs` gains an additional output directory mapping so personas are also emitted to `.pi/agents/` with YAML frontmatter.
2. **FORGE_ROOT resolution** — Instead of `${CLAUDE_PLUGIN_ROOT}`, the extension resolves it from `.forge/config.json`'s `paths.forgeRoot` field. The existing `--forge-root` CLI arg on all `.cjs` tools continues to work.
3. **Skill format** — Already compatible; pi discovers them from `skills/` directories.

Everything else — meta-definitions, base-pack, schemas, deterministic tools, init orchestration prompts, KB generation rules — works unchanged.

## New Code Estimates

| File | Est. Lines | Purpose |
|---|---|---|
| `extensions/forgecli/index.ts` | ~200 | Registration glue (tools, commands, hooks, lifecycle) |
| `extensions/forgecli/forge-tools.ts` | ~150 | Custom tool wrappers |
| `extensions/forgecli/hook-dispatcher.ts` | ~80 | Event → hook mapping |
| `extensions/forgecli/forge-commands.ts` | ~300 | Command handlers, init orchestrator |
| `bin/forgecli.ts` | ~150 | SDK-based headless runner |
| `agents/*.md` | generated | Base-pack personas in YAML frontmatter format |
| `prompts/*.md` | generated | Base-pack workflows with frontmatter |

**Total: ~880 lines of new code. Zero lines changed in `forge/`. Zero lines changed in `pi-mono/`.**

## Dual-Mode Existence

The same `forge/` source tree works as:
- A **Claude Code plugin** — installed via `/plugin install forge@skillforge`
- A **pi package** — installed via `pi install npm:forgecli`

Distribution branches (main → release tags → skillforge git-subdir) continue to work. The forgecli package adds only the `extensions/`, `agents/`, `prompts/`, `skills/`, and `bin/` directories.

## Source Code References

| Concept | Source File |
|---|---|
| Extension API (`ExtensionAPI`, `ToolDefinition`, all event types) | [`src/core/extensions/types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| SDK entry point (`createAgentSession`, `CreateAgentSessionOptions`) | [`src/core/sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts) |
| Agent session (`session.prompt()`, subscribe) | [`src/core/agent-session.ts`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts) |
| Resource loader (skills, prompts, extensions discovery) | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| Session manager (`create`, `inMemory`, JSONL persistence) | [`src/core/session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts) |
| Settings manager (`create`, `inMemory`) | [`src/core/settings-manager.ts`](../../pi-mono/packages/coding-agent/src/core/settings-manager.ts) |
| Auth storage | [`src/core/auth-storage.ts`](../../pi-mono/packages/coding-agent/src/core/auth-storage.ts) |
| Model registry (`create`, `find`, `getApiKeyAndHeaders`) | [`src/core/model-registry.ts`](../../pi-mono/packages/coding-agent/src/core/model-registry.ts) |
| Subagent extension (chain/parallel agent spawning) | [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| Agent discovery (frontmatter parsing, scopes) | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| Frontmatter parser (`parseFrontmatter`) | [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts) |
| Config / `getAgentDir()` | [`src/config.ts`](../../pi-mono/packages/coding-agent/src/config.ts) |
| Built-in tools (read, bash, edit, write, grep, find, ls) | [`src/core/tools/`](../../pi-mono/packages/coding-agent/src/core/tools/) |
| SDK examples (minimal, tools, extensions, sessions) | [`examples/sdk/`](../../pi-mono/packages/coding-agent/examples/sdk/) |
| Extension examples (hooks, commands, tools, UI) | [`examples/extensions/`](../../pi-mono/packages/coding-agent/examples/extensions/) |