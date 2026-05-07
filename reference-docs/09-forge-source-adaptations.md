# Forge Source Adaptations Reference

> **Purpose**: What changes in `forge/` itself — the minimal adaptations required for pi compatibility.
> **Source Code**: Resource discovery in [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts); frontmatter parsing in [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts); agent discovery in [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts).

## The Key Principle

**Zero lines changed in `forge/`**. The entire Forge plugin source tree (commands, hooks, init, meta, schemas, skills, tools) works as-is. The pi package simply wraps it via extension code that lives outside `forge/`.

## Required Adaptations

### 1. Agent Output Format — `substitute-placeholders.cjs`

**Current behavior**: Generates `.forge/personas/*.md` files with persona content.

**Required change**: Add an additional output directory mapping so personas are also emitted to `.pi/agents/` with YAML frontmatter wrapping.

```javascript
// In substitute-placeholders.cjs, add to SUBDIR_OUTPUT_MAP:
"base-pack/personas/": {
  // Existing: output to .forge/personas/
  forge: ".forge/personas/",
  // New: also output to .pi/agents/ with YAML frontmatter wrapping
  pi: ".pi/agents/",
},
```

**Why `.pi/agents/`?** The subagent extension discovers agents from `.pi/agents/` directories via `findNearestProjectAgentsDir()` in [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts). The YAML frontmatter (parsed by [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts) `parseFrontmatter()`) must include:

| Frontmatter Key | Value | Required |
|---|---|---|
| `name` | Agent name (e.g. "engineer") | Yes |
| `description` | Agent description | Yes |
| `tools` | Comma-separated tool allowlist | No |
| `model` | Model override (e.g. "claude-sonnet-4-5") | No |

**What this means in practice**:
- `.forge/personas/engineer.md` continues to be generated as before (Claude Code compatibility)
- `.pi/agents/engineer.md` is additionally generated with YAML frontmatter:
  ```markdown
  ---
  name: engineer
  description: Forge Engineer Agent — implements code, runs tests
  tools: read, bash, edit, write, grep, find, ls, forge_store, forge_collate
  model: claude-sonnet-4-5
  ---

  <persona content with {{KEY}} substitutions resolved>
  ```

### 2. Workflow Output — Also `substitute-placeholders.cjs`

**Current behavior**: Generates `.forge/workflows/*.md` files.

**Required change**: Add another output directory mapping:

```javascript
"base-pack/workflows/": {
  // Existing: output to .forge/workflows/
  forge: ".forge/workflows/",
  // New: also output to .pi/prompts/ with YAML frontmatter
  pi: ".pi/prompts/",
},
```

Each workflow file gets wrapped with `name` and `description` frontmatter fields, which pi's prompt template loader expects. See [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts) for the expected format.

### 3. FORGE_ROOT Resolution

**Current behavior**: Resolved via `` `${CLAUDE_PLUGIN_ROOT}` `` in command Markdown files.

**Required change**: None in `forge/` itself. The extension resolves it from `.forge/config.json`'s `paths.forgeRoot` field. All `.cjs` tools already accept `--forge-root` as a CLI argument, so they work unchanged.

**How it works**:
- In Claude Code: `${CLAUDE_PLUGIN_ROOT}` is resolved by the plugin system
- In pi: The extension calls `discoverForgeRoot()` which reads `.forge/config.json`
- All tool invocations pass `--forge-root <path>` explicitly

### 4. Skill Format

**Current behavior**: Forge's `forge/skills/refresh-kb-links/SKILL.md` and `forge/skills/store-custodian/SKILL.md` follow the Agent Skills standard.

**Required change**: None. pi discovers skills from `skills/` directories automatically via `loadSkills()` ([`src/core/skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts)) and `DefaultResourceLoader.updateSkillsFromPaths()` ([`resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts)).

### 5. Hook Scripts

**Current behavior**: `forge/hooks/*.js` scripts follow the Claude Code hook protocol (JSON stdin/stdout).

**Required change**: None in `forge/`. The pi extension reimplements hook semantics using `pi.on("tool_call")` and `pi.on("tool_result")` event handlers. The original hook scripts are not called from pi — they remain for Claude Code compatibility.

### 6. Command Markdown Files

**Current behavior**: `forge/commands/*.md` files contain slash command definitions for Claude Code.

**Required change**: None. pi doesn't read these directly. The extension registers commands via `pi.registerCommand()` ([`types.ts:1139`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts)) and reads the workflow content from `.forge/workflows/`.

## What Does NOT Change

| Component | Status | Reason |
|---|---|---|
| `forge/init/discovery/*.md` | ✅ No change | Read as LLM prompts by the init orchestrator |
| `forge/init/generation/*.md` | ✅ No change | Read as LLM prompts by the init orchestrator |
| `forge/init/base-pack/` | ✅ No change | Processed by `substitute-placeholders.cjs` |
| `forge/meta/` | ✅ No change | Schema definitions, persona specs — read by tools |
| `forge/schemas/` | ✅ No change | JSON schemas for store validation |
| `forge/tools/ensure-ready.cjs` | ✅ No change | Called via `execSync` |
| `forge/tools/collate.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/store-cli.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/validate-store.cjs` | ✅ No change | Called via `execSync` |
| `forge/tools/manage-config.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/manage-versions.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/generation-manifest.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/build-overlay.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/build-persona-pack.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/build-context-pack.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/build-init-context.cjs` | ✅ No change | Called via `execSync` with args |
| `forge/tools/seed-store.cjs` | ✅ No change | Called via `execSync` |
| `forge/.claude-plugin/plugin.json` | ✅ No change | Claude Code manifest — still needed for Claude Code mode |
| `forge/hooks/*.js` | ✅ No change | Still used by Claude Code; not called from pi |

## Summary of Forge Source Changes

| File | Change | Lines |
|---|---|---|
| `forge/tools/substitute-placeholders.cjs` | Add `pi` output directory mapping to `SUBDIR_OUTPUT_MAP` for `personas/` and `workflows/` | ~10 |

**Total changes to `forge/`: ~10 lines in one file.**

## Source Code References

| Concept | Source File |
|---|---|
| `DefaultResourceLoader` (resource discovery) | [`src/core/resource-loader.ts`](../../pi-mono/packages/coding-agent/src/core/resource-loader.ts) |
| `parseFrontmatter()` (YAML frontmatter parsing) | [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts) |
| `discoverAgents()` / `findNearestProjectAgentsDir()` | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| `loadSkills()` | [`src/core/skills.ts`](../../pi-mono/packages/coding-agent/src/core/skills.ts) |
| `loadPromptTemplates()` | [`src/core/prompt-templates.ts`](../../pi-mono/packages/coding-agent/src/core/prompt-templates.ts) |
| `pi.registerCommand()` | [`types.ts:1139`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |