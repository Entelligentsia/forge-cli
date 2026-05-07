# Agent and Prompt Template Reference

> **Purpose**: How Forge's personas and workflows become pi agent definitions and prompt templates.
> **Source Code**: Agent discovery in [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts); frontmatter parser in [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts); prompt template loading in [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts); skill loading in [`src/core/skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts).

## Agent Definitions — `.pi/agents/`

Forge's generated agent `.md` files (in `.forge/personas/`) inject persona text as the opening section of each workflow. In pi, these become standalone `.pi/agents/*.md` files with the same content in YAML frontmatter format.

### Agent Definition Format

The subagent extension discovers agents using `discoverAgents()` from [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts). It expects YAML frontmatter with `name`, `description`, optional `tools`, and optional `model`:

```markdown
<!-- .pi/agents/engineer.md -->
---
name: engineer
description: Forge Engineer Agent — implements code, runs tests, documents progress
tools: read, bash, edit, write, grep, find, ls, forge_store, forge_collate, forge_validate_store
model: claude-sonnet-4-5
---

You are the Engineer Agent for {{PROJECT_NAME}}.

{{ENGINEER_PERSONA_CONTENT}}
```

The frontmatter is parsed by `parseFrontmatter()` from [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts). The `body` (everything after the closing `---`) becomes the agent's system prompt.

### `AgentConfig` Type

From [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts):

```typescript
interface AgentConfig {
  name: string;           // From frontmatter "name"
  description: string;    // From frontmatter "description"
  tools?: string[];       // From frontmatter "tools" (comma-separated)
  model?: string;         // From frontmatter "model"
  systemPrompt: string;   // The Markdown body (after frontmatter)
  source: "user" | "project";  // Where the agent file was found
  filePath: string;       // Absolute path to the .md file
}
```

### Agent Discovery

`discoverAgents(cwd, scope)` walks agent directories:
- **"user"**: `~/.pi/agent/agents/` — user-level agents
- **"project"**: `.pi/agents/` nearest ancestor — project-level agents
- **"both"**: merges both, project overriding user

Source: [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) → `findNearestProjectAgentsDir(cwd)` → `loadAgentsFromDir(dir, source)`.

### Agent Inventory

| Agent | Model | Tools | Role |
|---|---|---|---|
| `engineer` | claude-sonnet-4-5 | read, bash, edit, write, grep, find, ls, forge_store, forge_collate, forge_validate_store | Implements code, runs tests, documents progress |
| `supervisor` | claude-opus-4 | read, grep, find, ls | Reviews plans and implementations |
| `architect` | claude-opus-4 | read, grep, find, ls | Approves completed work |
| `collator` | claude-sonnet-4-5 | read, write, bash, forge_collate | Collates sprint results, generates views |
| `bug-fixer` | claude-sonnet-4-5 | read, bash, edit, write, grep, find, ls, forge_store | Fixes bugs reported in the store |
| `qa-engineer` | claude-sonnet-4-5 | read, bash, grep, find, ls, forge_store | Writes and runs tests |

### Generation Process

During Phase 3 (Materialize) of `/forge:init`, `substitute-placeholders.cjs` processes the base-pack personas and outputs to two directories:

1. `.forge/personas/` — existing Forge format (for Claude Code compatibility)
2. `.pi/agents/` — pi format with YAML frontmatter (for pi subagent discovery)

The required change to `substitute-placeholders.cjs`:

```javascript
// In substitute-placeholders.cjs, add to SUBDIR_OUTPUT_MAP:
"base-pack/personas/": {
  // Existing: output to .forge/personas/
  forge: ".forge/personas/",
  // New: also output to .pi/agents/ with YAML frontmatter wrapping
  pi: ".pi/agents/",
},
```

### YAML Frontmatter Wrapping

The extension's `ensureAgentsAvailable()` function (called on `session_start`) is responsible for wrapping persona content in YAML frontmatter if the base-pack doesn't already include it. The template:

```markdown
---
name: {{PERSONA_NAME}}
description: {{PERSONA_DESCRIPTION}}
tools: {{PERSONA_TOOLS}}
model: {{PERSONA_MODEL}}
---

{{PERSONA_CONTENT}}
```

Where `PERSONA_CONTENT` is the full generated persona text with all `{{KEY}}` substitutions resolved.

## Prompt Templates — `.pi/prompts/`

These map 1:1 to Forge's command Markdown files, adapted to pi's template format.

### Prompt Template Loading

Prompt templates are loaded by `loadPromptTemplates()` from [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts). They are discovered from:
- `~/.pi/agent/prompts/` — user-level prompts
- `.pi/prompts/` — project-level prompts
- Package `pi.prompts` manifest paths

Each `.md` file with a name frontmatter field becomes a `/name` slash command.

### Prompt Template Format

```markdown
<!-- prompts/plan.md -->
---
name: plan
description: Design and document the implementation plan for a task
---

{{PLAN_WORKFLOW_CONTENT}}
```

### Prompt Inventory

| Prompt | Description | Source Workflow |
|---|---|---|
| `plan` | Design and document implementation plan | `engineer_plan_task.md` |
| `implement` | Implement a task following an approved plan | `engineer_implement_plan.md` |
| `review-code` | Review code for quality, correctness, and style | `supervisor_review_implementation.md` |
| `run-task` | Full orchestrate task pipeline | `orchestrate_task.md` |
| `sprint-plan` | Plan a sprint's worth of tasks | `architect_sprint_plan.md` |
| `fix-bug` | Fix a bug from the store | `bug_fixer_fix.md` |

### Generation Process

When `forgecli init` materializes workflows, it writes them to:
- `.forge/workflows/` — existing Forge format
- `.pi/prompts/` — pi format with YAML frontmatter added

The pi coding-agent discovers them as slash commands: `/plan`, `/implement`, `/review-code`, etc.

## Skills — `.pi/skills/forgecli/`

Forge's skills follow the Agent Skills standard, and pi has its own skill discovery via `loadSkills()` in [`src/core/skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts) (called from `resource-loader.ts`). Compatibility is **plausible but unverified** at the frontmatter-field level — Forge's specific frontmatter keys have not been load-tested against pi's parser. Required follow-up: load a representative Forge skill (e.g. `forge/skills/refresh-kb-links/SKILL.md`) through pi's `loadSkills()` and assert no diagnostics. Treat skills as known-good only after that one-time test passes.

### Skill Discovery

Skills are loaded by `DefaultResourceLoader.updateSkillsFromPaths()` — [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts). Each skill directory must contain a `SKILL.md` file. The `package.json` `pi.skills` field points to the skill directory.

### Skill Inventory

| Skill | Description |
|---|---|
| `refresh-kb-links` | Refreshes knowledge base cross-references (maps to `before_agent_start` KB context injection in pi) |
| `store-custodian` | Manages the Forge store — ensures referential integrity, validates schemas |

## Directory Structure After Init

After running `/forge:init`, the project contains these pi-specific directories alongside the existing Forge structure:

```
project/
├── .forge/                    ← Forge's existing store, config, workflows, personas, templates
│   ├── config.json
│   ├── store/
│   ├── workflows/
│   ├── personas/
│   └── templates/
├── engineering/               ← Forge's knowledge base
│   └── MASTER_INDEX.md
├── .pi/                       ← pi-specific generated output
│   ├── agents/                ← Forge personas as pi agents (discovered by subagent/agents.ts)
│   │   ├── engineer.md
│   │   ├── supervisor.md
│   │   ├── architect.md
│   │   └── ...
│   ├── prompts/               ← Forge commands as pi prompts (loaded by prompt-templates.ts)
│   │   ├── plan.md
│   │   ├── implement.md
│   │   └── ...
│   └── skills/                ← Forge skills (loaded by skills.ts)
│       └── forgecli/
│           └── SKILL.md
```

## Source Code References

| Concept | Source File |
|---|---|
| `AgentConfig` type and `discoverAgents()` | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| `findNearestProjectAgentsDir()` | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| `parseFrontmatter()` for `.md` YAML frontmatter | [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts) |
| Prompt template loading `loadPromptTemplates()` | [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts) |
| Skill loading `loadSkills()` | [`src/core/skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts) |
| Resource loading `DefaultResourceLoader` | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `DefaultResourceLoader.updateSkillsFromPaths()` | [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `DefaultResourceLoader.updatePromptsFromPaths()` | [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `DefaultResourceLoader.reload()` | [`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `getAgentDir()` config function | [`src/config.ts`](../../pi-mono/packages/coding-agent/src/config.ts) |