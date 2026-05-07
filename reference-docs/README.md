# Forge-CLI Engineering Reference Documents

> Generated from `forge-cli-feasibility.txt` — a structured reference set for guiding forgecli engineering effort.
> All source code references point to [`pi-mono/packages/coding-agent/`](../../pi-mono/packages/coding-agent/) as the canonical pi codebase.
>
> **See also:** [`../architectural-review.md`](../architectural-review.md) — verified vs. inaccurate claims, risk-ranked blockers (R1–R7), and the recommended path forward. The patches in these docs (subagent vendoring, `forge_run_task` redesign, permission-gate guidance, refreshed line numbers) are driven by that review.

## Document Index

| # | Document | Purpose |
|---|---|---|
| 00 | [Architecture Overview](00-architecture-overview.md) | Core insight, capability mapping with source refs, dual-mode architecture, new code estimates |
| 01 | [Package Structure](01-package-structure.md) | Directory layout, package.json manifest, vendored `forge/` contents, resource discovery flow |
| 02 | [Extension Core](02-extension-core.md) | Main entry point: registration glue, Forge root discovery, KB injection, lifecycle — references `ExtensionAPI` |
| 03 | [Custom Tools](03-custom-tools.md) | All `.cjs` tool wrappers with schemas — references `ToolDefinition` type |
| 04 | [Hook Dispatcher](04-hook-dispatcher.md) | Event→hook mapping, write validation, error triage, triggers — references `ToolCallEvent`/`ToolResultEvent` types |
| 05 | [Init Orchestrator](05-init-orchestrator.md) | 4-phase init process, command handler, resumption — references `ExtensionCommandContext` |
| 06 | [Multi-Agent Orchestration](06-multi-agent-orchestration.md) | Subagent chain/parallel mapping, `forge_run_task` tool — references `examples/extensions/subagent/` |
| 07 | [Agent and Prompt Templates](07-agent-and-prompt-templates.md) | `.pi/agents/*.md` format, `.pi/prompts/*.md` format, skills, generation — references `parseFrontmatter`, `discoverAgents` |
| 08 | [Headless CLI](08-headless-cli.md) | `bin/forgecli.ts` SDK-based runner, command routing — references `createAgentSession`, `SessionManager.inMemory` |
| 09 | [Forge Source Adaptations](09-forge-source-adaptations.md) | Minimal changes to `forge/` itself: substitute-placeholders output mapping only |
| 10 | [Installation and Distribution](10-installation-and-distribution.md) | Install methods, dual-mode existence, CI usage, package metadata |
| 11 | [Event Mapping Reference](11-event-mapping-reference.md) | Complete Claude Code hooks → pi events table, return types, implementation priority |

## Reading Order

**For onboarding** (read in order):
1. `00-architecture-overview.md` — Understand the vision and mapping
2. `01-package-structure.md` — See the shape of the codebase
3. `02-extension-core.md` — Understand the entry point and registration flow
4. `05-init-orchestrator.md` — Understand the flagship feature

**For implementation** (reference as needed):
- `03-custom-tools.md` — When building tool wrappers
- `04-hook-dispatcher.md` — When implementing guardrails and triggers
- `06-multi-agent-orchestration.md` — When building the pipeline
- `07-agent-and-prompt-templates.md` — When generating .pi/ artifacts
- `08-headless-cli.md` — When building the CLI entry point
- `09-forge-source-adaptations.md` — When modifying `substitute-placeholders.cjs`

**For planning**:
- `11-event-mapping-reference.md` — Implementation priority and full mapping

## Key Source Code Files in pi-mono

| Concept | Source File | Relevance |
|---|---|---|
| **Extension API** (ExtensionAPI, all event types, ToolDefinition) | [`src/core/extensions/types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) | **Primary reference** — every forgecli extension function is typed here |
| **SDK entry point** (createAgentSession, CreateAgentSessionOptions) | [`src/core/sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts) | Headless CLI implementation model |
| **Agent session** (session.prompt, subscribe) | [`src/core/agent-session.ts`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts) | Headless command routing |
| **Resource loader** (DefaultResourceLoader, package discovery) | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) | Package installation and resource discovery |
| **Session manager** (inMemory, create, JSONL) | [`src/core/session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts) | Headless session creation |
| **Settings manager** (inMemory, create) | [`src/core/settings-manager.ts`](../../pi-mono/packages/coding-agent/src/core/settings-manager.ts) | Headless settings |
| **Auth storage** | [`src/core/auth-storage.ts`](../../pi-mono/packages/coding-agent/src/core/auth-storage.ts) | API key management |
| **Model registry** | [`src/core/model-registry.ts`](../../pi-mono/packages/coding-agent/src/core/model-registry.ts) | Model discovery and selection |
| **Subagent extension** (chain/parallel/single) | [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) | **Direct model** for forgecli multi-agent |
| **Agent discovery** (AgentConfig, discoverAgents) | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) | .pi/agents/ discovery pattern |
| **Frontmatter parser** (parseFrontmatter) | [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts) | Agent/prompt `.md` parsing |
| **Prompt templates** | [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts) | .pi/prompts/ loading |
| **Skills** | [`src/core/skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts) | .pi/skills/ loading |
| **Config / getAgentDir()** | [`src/config.ts`](../../pi-mono/packages/coding-agent/src/config.ts) | Agent directory resolution |
| **Built-in tools** (read, bash, edit, write, grep, find, ls) | [`src/core/tools/`](../../pi-mono/packages/coding-agent/src/core/tools/) | Tool implementations |
| **SDK examples** (minimal through full-control) | [`examples/sdk/`](../../pi-mono/packages/coding-agent/examples/sdk/) | Headless CLI patterns |
| **Extension examples** (hooks, commands, tools, UI) | [`examples/extensions/`](../../pi-mono/packages/coding-agent/examples/extensions/) | Implementation patterns |

## Key Facts

| Metric | Value |
|---|---|
| New code | ~880 lines across 5 source files |
| Changes to `forge/` | ~10 lines in 1 file (`substitute-placeholders.cjs`) |
| Changes to `pi-mono/` | 0 lines |
| New pi tools | 4 (`forge_collate`, `forge_store`, `forge_validate_store`, `forge_config`) |
| New pi commands | 2+ (`/forge:init`, `/forge:health`) |
| Agent definitions | 6 (engineer, supervisor, architect, collator, bug-fixer, qa-engineer) |
| Prompt templates | 6+ (plan, implement, review-code, run-task, sprint-plan, fix-bug) |
| Key source file (Extension API) | [`pi-mono/packages/coding-agent/src/core/extensions/types.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) (1567 lines) |
| Key pattern (Subagent) | [`pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |