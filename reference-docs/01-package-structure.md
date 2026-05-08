# Package Structure Reference

> **Purpose**: Directory layout, package.json manifest, and file-by-file purpose for the `forgecli` pi package.
> **Source Code**: Package discovery and loading logic in [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts).

## Directory Layout

```
forgecli/                              ← A pi package (npm publishable)
├── package.json                       ← pi manifest + npm metadata
├── forge/                             ← THE ENTIRE FORGE PLUGIN, VENDORED AS-IS
│   ├── .claude-plugin/plugin.json
│   ├── commands/
│   ├── hooks/
│   ├── init/
│   ├── meta/
│   ├── schemas/
│   ├── skills/
│   ├── tools/
│   └── ...
├── extensions/
│   └── forgecli/
│       ├── index.ts                   ← Main extension: registers all tools, commands, hooks
│       ├── forge-tools.ts             ← Custom tool wrappers for store-cli, collate, etc.
│       ├── hook-dispatcher.ts         ← Translates pi events into Forge hook semantics
│       ├── init-orchestrator.ts       ← Drives the 4-phase init via session.prompt()
│       └── workflow-runner.ts         ← Drives individual workflows via subagent spawning
├── skills/
│   └── forgecli/                      ← SKILL.md for each Forge skill
│       ├── SKILL.md
│       └── ...
├── agents/                            ← pi agent definitions (Forge personas → pi agents)
│   ├── engineer.md
│   ├── supervisor.md
│   ├── architect.md
│   ├── collator.md
│   ├── bug-fixer.md
│   └── qa-engineer.md
├── prompts/                           ← pi prompt templates (Forge commands → prompts)
│   ├── plan.md
│   ├── implement.md
│   ├── review-code.md
│   ├── run-task.md
│   ├── sprint-plan.md
│   ├── fix-bug.md
│   └── ...
└── bin/
    └── forgecli.ts                    ← Headless CLI entry point (SDK-based)
```

## package.json

```json
{
  "name": "forgecli",
  "version": "0.40.2",
  "description": "AI-SDLC tool — generates and operates project-specific software development lifecycles",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/forgecli"],
    "skills": ["./skills/forgecli"],
    "prompts": ["./prompts"]
  },
  "bin": {
    "forgecli": "./bin/forgecli.ts"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.73.0",
    "@earendil-works/pi-ai": "^0.73.0",
    "@earendil-works/pi-tui": "^0.73.0",
    "typebox": "^1.1.24"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

### Key Fields Explained

| Field | Purpose | Source Reference |
|---|---|---|
| `pi.extensions` | Paths to extension entry points; pi loads these on startup | `DefaultResourceLoader.resolve()` → [`resource-loader.ts:reload()`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `pi.skills` | Paths to skill directories; pi discovers `SKILL.md` in each | `DefaultResourceLoader.updateSkillsFromPaths()` → [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `pi.prompts` | Paths to prompt template directories; pi registers as slash commands | `DefaultResourceLoader.updatePromptsFromPaths()` → [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `bin.forgecli` | Headless CLI entry point; enables `forgecli init`, `forgecli run-task`, etc. | Uses `createAgentSession()` from [`sdk.ts`](../../pi-mono/packages/coding-agent/src/core/sdk.ts) |
| `peerDependencies` | Required at runtime; must be installed alongside (in the pi host) | — |

## Vendored `forge/` Directory

The `forge/` directory is the entire Forge Claude Code plugin, vendored unchanged. It contains:

- `init/` — Discovery prompts, base-pack templates, generation rules
- `tools/` — Deterministic `.cjs` tools (collate, store-cli, validate-store, manage-config, etc.)
- `meta/` — Schema definitions, persona specs, workflow templates
- `commands/` — Slash command Markdown files (Forge's `/sprint-plan`, `/run-task`, etc.)
- `hooks/` — Claude Code hook scripts (validate-write, post-init, post-sprint, etc.)
- `skills/` — Agent skills (refresh-kb-links, store-custodian)

All `.cjs` tools are invoked via `node <path>/tool.cjs` with appropriate arguments — they require no modification for pi use.

## Resource Discovery Flow

When pi loads a forgecli package, the `DefaultResourceLoader` ([`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts)) discovers resources in this order:

1. **Resolve package paths** — `DefaultPackageManager.resolve()` reads `package.json` `pi.*` fields
2. **Load extensions** — `loadExtensions()` processes `./extensions/forgecli` → executes the `ExtensionFactory`
3. **Load skills** — `loadSkills()` finds `SKILL.md` in `./skills/forgecli/`
4. **Load prompts** — `loadPromptTemplates()` finds template `.md` files in `./prompts/`
5. **Extension `resources_discover` event** — After `session_start`, extensions can add more paths via `pi.on("resources_discover")`
6. **Agent files** — `loadProjectContextFiles()` finds `AGENTS.md` / `CLAUDE.md` context files

Source: [`DefaultResourceLoader.reload()`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts)