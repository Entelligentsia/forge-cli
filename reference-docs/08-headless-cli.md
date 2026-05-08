# Headless CLI Reference

> **Purpose**: The SDK-based headless runner that enables `forgecli` as a standalone CLI tool without requiring the interactive TUI.
> **Source Code**: `createAgentSession()` in [`src/core/sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts); `DefaultResourceLoader` in [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts); `SessionManager` in [`src/core/session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts); `SettingsManager` in [`src/core/settings-manager.ts`](../../pi-mono/packages/coding-agent/src/core/settings-manager.ts); `AuthStorage` in [`src/core/auth-storage.ts`](../../pi-mono/packages/coding-agent/src/core/auth-storage.ts); SDK examples in [`examples/sdk/`](../../pi-mono/packages/coding-agent/examples/sdk/).

## File: `bin/forgecli.ts`

## Overview

The extension works in interactive mode (pi with the forgecli extension loaded). But `forgecli` as a purpose-made tool also needs a headless CLI that doesn't require an interactive TUI. The pi SDK makes this trivial via `createAgentSession()` ([`sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts)).

## Reference Implementation

```typescript
#!/usr/bin/env node
import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const command = process.argv[2];
const args = process.argv.slice(3);

// AuthStorage.create() — see auth-storage.ts:202
const authStorage = AuthStorage.create();
// ModelRegistry.create() — see model-registry.ts:344
const modelRegistry = ModelRegistry.create(authStorage);

// ─── Build ResourceLoader with forgecli extension ──────────────────
// DefaultResourceLoader — see resource-loader.ts
const forgecliExtensionPath = path.resolve(__dirname, "../extensions/forgecli/index.js");

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  additionalExtensionPaths: [forgecliExtensionPath],
  skillsOverride: (current) => {
    // Add forgecli skill if in a Forge-initialized project
    const skillDir = path.resolve(__dirname, "../skills/forgecli");
    if (fs.existsSync(path.join(skillDir, "SKILL.md"))) {
      current.skills.push({
        name: "forgecli",
        description: "Forge AI-SDLC tools and workflows",
        filePath: path.join(skillDir, "SKILL.md"),
        baseDir: skillDir,
        source: "package",
      });
    }
    return current;
  },
});
await loader.reload();

// ─── Create session ─────────────────────────────────────────────────
// SessionManager — see session-manager.ts:1305 (inMemory)
const sessionManager = SessionManager.inMemory();
// SettingsManager — see settings-manager.ts:301 (inMemory)
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: true },
});

// createAgentSession() — see sdk.ts
const { session } = await createAgentSession({
  cwd: process.cwd(),
  // modelRegistry.find() — see model-registry.ts
  model: modelRegistry.find("anthropic", "claude-sonnet-4-5"),
  authStorage,
  modelRegistry,
  sessionManager,
  settingsManager,
  resourceLoader: loader,
});
```

## Command Routing

```typescript
switch (command) {
  // ─── LLM-driven commands ────────────────────────────────────────
  case "init": {
    // session.prompt() — see agent-session.ts:967
    const initPrompt = fs.readFileSync(
      path.resolve(__dirname, "../forge/init/sdlc-init.md"), "utf8"
    );
    await session.prompt(initPrompt);
    break;
  }
  case "run-task": {
    const taskId = args[0];
    if (!taskId) { console.error("Usage: forgecli run-task <TASK_ID>"); process.exit(1); }
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), ".forge/workflows/orchestrate_task.md"), "utf8"
    );
    await session.prompt(`${workflow}\n\nTask ID: ${taskId}`);
    break;
  }
  case "sprint-plan": {
    const sprintId = args[0];
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), ".forge/workflows/architect_sprint_plan.md"), "utf8"
    );
    await session.prompt(`${workflow}\n\nSprint ID: ${sprintId || "new"}`);
    break;
  }

  // ─── Deterministic commands (no LLM needed) ─────────────────────
  case "health": {
    const forgeRoot = discoverForgeRoot();
    const result = execSync(`node ${forgeRoot}/tools/ensure-ready.cjs --all`, { encoding: "utf8" });
    console.log(result);
    break;
  }
  case "collate": {
    const sprintId = args[0];
    const forgeRoot = discoverForgeRoot();
    const collateArgs = sprintId ? sprintId : "";
    const result = execSync(`node ${forgeRoot}/tools/collate.cjs ${collateArgs}`, { encoding: "utf8" });
    console.log(result);
    break;
  }
  // ... other commands
}

session.dispose();
```

## SDK Classes and Methods — Source References

| Class/Function | Source File | Key Method | Notes |
|---|---|---|---|
| `AuthStorage` | [`src/core/auth-storage.ts`](../../pi-mono/packages/coding-agent/src/core/auth-storage.ts) | `.create(authPath?)` | Creates auth storage from JSON file |
| `ModelRegistry` | [`src/core/model-registry.ts`](../../pi-mono/packages/coding-agent/src/core/model-registry.ts) | `.create(authStorage, modelsPath?)` | Finds models, resolves API keys |
| `ModelRegistry` | [`src/core/model-registry.ts`](../../pi-mono/packages/coding-agent/src/core/model-registry.ts) | `.find(provider, modelId)` | Find a specific model |
| `ModelRegistry` | [`src/core/model-registry.ts`](../../pi-mono/packages/coding-agent/src/core/model-registry.ts) | `.hasConfiguredAuth(model)` | Check if API key is available |
| `SessionManager` | [`src/core/session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts) | `.create(cwd, sessionDir?)` | Persistent file-based session |
| `SessionManager` | [`src/core/session-manager.ts`](../../pi-mono/packages/coding-agent/src/core/session-manager.ts) | `.inMemory(cwd?)` | In-memory session (for headless) |
| `SettingsManager` | [`src/core/settings-manager.ts`](../../pi-mono/packages/coding-agent/src/core/settings-manager.ts) | `.create(cwd, agentDir)` | File-based settings |
| `SettingsManager` | [`src/core/settings-manager.ts`](../../pi-mono/packages/coding-agent/src/core/settings-manager.ts) | `.inMemory(settings?)` | In-memory settings (for headless) |
| `DefaultResourceLoader` | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) | `constructor(options)` | Discovers extensions, skills, prompts |
| `DefaultResourceLoader` | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) | `.reload()` | Reloads all resources |
| `createAgentSession()` | [`src/core/sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts) | `(options)` | Main entry point for SDK usage |
| `AgentSession` | [`src/core/agent-session.ts`](../../pi-mono/packages/coding-agent/src/core/agent-session.ts) | `.prompt(text)` | Send a prompt to the agent |
| `getAgentDir()` | [`src/config.ts`](../../pi-mono/packages/coding-agent/src/config.ts) | `()` | Returns `~/.pi/agent` path |

## Command Reference

| Command | LLM Required | Description | Usage |
|---|---|---|---|
| `forgecli init [--fast\|--full]` | Yes | Bootstrap a complete AI-SDLC for the current project | `forgecli init --fast` |
| `forgecli run-task <TASK_ID>` | Yes | Orchestrate full plan→implement→review→approve pipeline | `forgecli run-task ACME-S01-T01` |
| `forgecli sprint-plan [SPRINT_ID]` | Yes | Plan a sprint's worth of tasks | `forgecli sprint-plan S01` |
| `forgecli health` | No | Run `ensure-ready.cjs --all` | `forgecli health` |
| `forgecli collate [SPRINT_ID]` | No | Regenerate markdown views from the JSON store | `forgecli collate S01` |
| `forgecli enhance --phase N` | Yes | Run enhancement phase | `forgecli enhance --phase 1 --auto` |

## LLM vs Deterministic Commands

**LLM-driven** commands create a session and call `session.prompt()`:
- `init`, `run-task`, `sprint-plan`, `enhance`

These require API keys and incur token costs.

**Deterministic** commands invoke `.cjs` tools directly via `execSync`:
- `health`, `collate`, `validate-store`, `config get/set`

These run locally with no LLM required.

## SDK Example References

The `examples/sdk/` directory contains examples that directly inform the forgecli headless implementation:

| Example | Source | Relevance |
|---|---|---|
| Minimal | [`examples/sdk/01-minimal.ts`](../../pi-mono/packages/coding-agent/examples/sdk/01-minimal.ts) | Basic `createAgentSession()` usage |
| Custom Model | [`examples/sdk/02-custom-model.ts`](../../pi-mono/packages/coding-agent/examples/sdk/02-custom-model.ts) | Model selection |
| Custom Prompt | [`examples/sdk/03-custom-prompt.ts`](../../pi-mono/packages/coding-agent/examples/sdk/03-custom-prompt.ts) | System prompt customization |
| Skills | [`examples/sdk/04-skills.ts`](../../pi-mono/packages/coding-agent/examples/sdk/04-skills.ts) | Skill loading |
| Tools | [`examples/sdk/05-tools.ts`](../../pi-mono/packages/coding-agent/examples/sdk/05-tools.ts) | Tool allowlisting |
| Extensions | [`examples/sdk/06-extensions.ts`](../../pi-mono/packages/coding-agent/examples/sdk/06-extensions.ts) | Extension loading with `DefaultResourceLoader` |
| Context Files | [`examples/sdk/07-context-files.ts`](../../pi-mono/packages/coding-agent/examples/sdk/07-context-files.ts) | AGENTS.md/CLAUDE.md loading |
| Prompt Templates | [`examples/sdk/08-prompt-templates.ts`](../../pi-mono/packages/coding-agent/examples/sdk/08-prompt-templates.ts) | Prompt template discovery |
| Sessions | [`examples/sdk/11-sessions.ts`](../../pi-mono/packages/coding-agent/examples/sdk/11-sessions.ts) | Session persistence |
| Full Control | [`examples/sdk/12-full-control.ts`](../../pi-mono/packages/coding-agent/examples/sdk/12-full-control.ts) | Complete SDK configuration |
| Session Runtime | [`examples/sdk/13-session-runtime.ts`](../../pi-mono/packages/coding-agent/examples/sdk/13-session-runtime.ts) | Session runtime management |

## Dual-Mode Architecture

The same extension code powers both modes:

```
┌─────────────────────────────┐
│       forgecli package       │
├─────────────────────────────┤
│  extensions/forgecli/index.ts│ ← Works in BOTH modes
│  extensions/forgecli/tools   │
│  extensions/forgecli/hooks   │
├──────────┬──────────────────┤
│ INTERACTIVE│   HEADLESS      │
│ pi -e ... │  bin/forgecli.ts│
│  (TUI)    │   (SDK session) │
└──────────┴──────────────────┘
```

In **interactive mode**, pi loads the extension and the user invokes `/forge:init`, `/forge:health`, etc.

In **headless mode**, `bin/forgecli.ts` creates an SDK session using `createAgentSession()` ([`sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts)) and drives the same extension programmatically.