# Installation and Distribution Reference

> **Purpose**: How forgecli is installed, distributed, and used in both interactive and headless modes.
> **Source Code**: Package manager in [`src/core/package-manager.ts`](../../pi-mono/packages/coding-agent/src/core/package-manager.ts); resource loader in [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts); extension loading in [`src/core/extensions/loader.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts); SDK session creation in [`src/core/sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts).

## Interactive Mode — Installing Within a pi Project

### From npm

```bash
pi install npm:forgecli
```

### From git

```bash
pi install git:github.com:Entelligentsia/forgecli
```

### For development (local)

```bash
pi -e ./path/to/forgecli/extensions/forgecli/index.ts
```

### How Installation Works

The `pi install` command uses `DefaultPackageManager.resolve()` ([`src/core/package-manager.ts`](../../pi-mono/packages/coding-agent/src/core/package-manager.ts)) to:

1. Read the package's `package.json` `pi.*` fields
2. Resolve extension, skill, and prompt paths
3. Register the package in the project's `.pi/settings.json`
4. On next `pi` launch, `DefaultResourceLoader.reload()` ([`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts)) discovers the registered package and loads its resources

### Post-Installation

After installing, the forgecli extension is active. Running `pi` in a project directory gives access to all Forge commands:

```bash
pi
> /forge:init
# ... the full 4-phase init runs, generating:
#   .forge/               (store, config, workflows, personas, templates)
#   engineering/          (knowledge base)
#   .pi/agents/           (Forge personas as pi agents)
#   .pi/prompts/          (Forge commands as pi prompt templates)
#   .pi/skills/forgecli   (Forge skills)
```

## Headless Mode — Using forgecli CLI Directly

### Prerequisites

- `forgecli` must be installed globally or available in `PATH`
- API keys (Anthropic) must be configured via `AuthStorage` ([`src/core/auth-storage.ts`](../../pi-mono/packages/coding-agent/src/core/auth-storage.ts))

### Commands

```bash
forgecli init --fast               # Bootstrap AI-SDLC (fast mode)
forgecli run-task ACME-S01-T01     # Orchestrate a task through full pipeline
forgecli sprint-plan --json        # Plan a sprint (JSON output)
forgecli collate S01               # Collate sprint results
forgecli health                    # Run health checks
```

### Deterministic Commands (No LLM)

These commands run `.cjs` tools directly without creating an SDK session:

| Command | Underlying Tool |
|---|---|
| `forgecli health` | `ensure-ready.cjs --all` |
| `forgecli collate [SPRINT_ID]` | `collate.cjs [SPRINT_ID]` |
| `forgecli validate-store` | `validate-store.cjs` |
| `forgecli config get <key>` | `manage-config.cjs get <key>` |
| `forgecli config set <key> <value>` | `manage-config.cjs set <key> <value>` |

### LLM-Driven Commands

These commands create an SDK session using `createAgentSession()` ([`sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts)) and call `session.prompt()` ([`agent-session.ts:967`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts)):

| Command | Prompt Source |
|---|---|
| `forgecli init [--fast\|--full]` | `forge/init/sdlc-init.md` |
| `forgecli run-task <TASK_ID>` | `.forge/workflows/orchestrate_task.md` |
| `forgecli sprint-plan [SPRINT_ID]` | `.forge/workflows/architect_sprint_plan.md` |
| `forgecli enhance --phase N` | Enhancement workflow |

## Dual-Mode Existence

The same `forge/` source tree works as both:

### Claude Code Plugin

```bash
# Install as a Claude Code plugin
/plugin install forge@skillforge
```

- Uses `forge/hooks/*.js` (Claude Code hook protocol)
- Uses `forge/commands/*.md` (Claude Code slash commands)
- Resolves `FORGE_ROOT` via `${CLAUDE_PLUGIN_ROOT}`
- Reads persona content from `.forge/personas/`

### pi Package

```bash
# Install as a pi package
pi install npm:forgecli
```

- Uses `extensions/forgecli/` (pi extension system, loaded by [`src/core/extensions/loader.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts))
- Uses `pi.registerCommand()` + `pi.registerTool()`
- Resolves `FORGE_ROOT` via `.forge/config.json` `paths.forgeRoot`
- Discovers agents from `.pi/agents/` (via [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts))
- Discovers prompts from `.pi/prompts/` (via [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts))

### Distribution Branches

The existing distribution flow continues:

```
main branch
  └── release tags
       └── skillforge (git-subdir)
            └── Claude Code: /plugin install forge@skillforge
            └── pi:       pi install npm:forgecli
```

The forgecli npm package is built from the repository and includes:
- `forge/` — vendored as-is
- `extensions/` — pi extension layer
- `agents/` — default agent definitions
- `prompts/` — default prompt templates
- `skills/` — Forge skills
- `bin/` — headless CLI entry point

## CI/Automation Usage

For CI pipelines and automation, the headless CLI enables Forge workflows without human interaction:

```bash
# In CI:
forgecli health                    # Pre-flight check
forgecli run-task ACME-S01-T01     # Execute a task
forgecli collate S01               # Update project views
forgecli validate-store            # Ensure store integrity
```

The `--auto` flag on enhancement commands makes them proceed without user confirmation, suitable for CI:

```bash
forgecli enhance --phase 1 --auto
forgecli enhance --phase 2 --auto
```

## Package Metadata

| Field | Value |
|---|---|
| `name` | `forgecli` |
| `version` | Tracks Forge version (currently `0.40.2`) |
| `keywords` | `["pi-package"]` |
| `pi.extensions` | `["./extensions/forgecli"]` |
| `pi.skills` | `["./skills/forgecli"]` |
| `pi.prompts` | `["./prompts"]` |
| `bin.forgecli` | `"./bin/forgecli.ts"` |
| `dependencies` | `@mariozechner/pi-coding-agent ^0.73.0`, `@mariozechner/pi-ai ^0.73.0`, `@mariozechner/pi-tui ^0.73.0`, `typebox ^1.1.24` |

## Source Code References

| Concept | Source File |
|---|---|
| `DefaultPackageManager` — package resolution | [`src/core/package-manager.ts`](../../pi-mono/packages/coding-agent/src/core/package-manager.ts) |
| `DefaultResourceLoader` — resource discovery | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| Extension loading | [`src/core/extensions/loader.ts`](../../pi-mono/packages/coding-agent/src/core/extensions/loader.ts) |
| `createAgentSession()` — SDK entry | [`src/core/sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts) |
| `session.prompt()` — send prompts | [`src/core/agent-session.ts`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts) |
| `AuthStorage.create()` — credential storage | [`src/core/auth-storage.ts`](../../pi-mono/packages/coding-agent/src/core/auth-storage.ts) |
| `SessionManager.inMemory()` — headless sessions | [`src/core/session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts) |
| `SettingsManager.inMemory()` — headless settings | [`src-mgr`]: [`src/core/settings-manager.ts`](../../pi-mono/packages/coding-agent/src/core/settings-manager.ts) |
| `getAgentDir()` — agent directory path | [`src/config.ts`](../../pi-mono/packages/coding-agent/src/config.ts) |
| Extension examples | [`examples/extensions/`](../../pi-mono/packages/coding-agent/examples/extensions/) |
| SDK examples | [`examples/sdk/`](../../pi-mono/packages/coding-agent/examples/sdk/) |