# Multi-Agent Orchestration Reference

> **Purpose**: How Forge's pipeline orchestration maps to pi's subagent extension — run-task chains and parallel sprint execution.
> **Source Code**: Subagent extension in [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts); agent discovery in [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts); frontmatter parsing in [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts).

## The Key Insight

The pi-coding-agent's subagent extension ([`examples/extensions/subagent/`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/)) already implements the Forge orchestrator's core pattern. It supports:

- **Spawning isolated agents** with custom system prompts, model selections, and tool restrictions
- **Chains** (sequential: scout → planner → worker) — this is Forge's run-task pipeline
- **Parallel tasks** — this is Forge's wave-parallel sprint execution
- **Streaming results** back in real-time via `onUpdate`
- **Tracking usage** per agent (turns, tokens, cost)

> **Stability caveat — vendor or upstream the subagent extension.** The subagent lives at [`examples/extensions/subagent/`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/), **not** in `src/core/`. The pi-coding-agent `package.json` `files` field ships `["dist","docs","examples","CHANGELOG.md"]`, so the example is bundled and importable, but `examples/` is not a stable API surface — its tool name, parameter schema, agent file format, discovery scopes, and concurrency constants can change between releases without semver implications for `src/core/`. forge-cli must **vendor** the subagent into `forgecli/extensions/forgecli/subagent/{index.ts,agents.ts}` (recommended for v1) or invest in upstreaming it into `src/core/` with a stable contract. Treat any "zero new infrastructure" framing of this layer as inaccurate — the configuration is small, but the code under it is on a non-load-bearing surface and must be owned by forge-cli or pinned tightly.

## Subagent Modes

From [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts):

| Mode | Parameter | Description |
|---|---|---|
| **Single** | `{ agent: "name", task: "..." }` | Delegate a task to one agent |
| **Parallel** | `{ tasks: [{ agent, task }, ...] }` | Run multiple agents concurrently (max 8, concurrency 4) |
| **Chain** | `{ chain: [{ agent, task }, ...] }` | Run agents sequentially, `{previous}` placeholder passes output forward |

## Pipeline Phase Mapping

### Run-Task Pipeline → Subagent Chain

Forge's `orchestrate_task.md` workflow defines a 6-phase pipeline. Each phase maps to a pi agent:

| Forge Pipeline Phase | Forge Workflow | pi Subagent Agent |
|---|---|---|
| Plan | `engineer_plan_task.md` | `engineer` (model: sonnet, tools: read, grep, find, ls, forge_store) |
| Review Plan | `supervisor_review_plan.md` | `supervisor` (model: opus, tools: read, grep, find, ls) |
| Implement | `engineer_implement_plan.md` | `engineer` (model: sonnet, tools: all) |
| Review Code | `supervisor_review_implementation.md` | `supervisor` (model: opus, tools: read, grep, find, ls) |
| Approve | `architect_approve.md` | `architect` (model: opus, tools: read, grep, find, ls) |
| Commit | `engineer_commit_task.md` | `engineer` (model: haiku, tools: read, bash, write) |

### Sprint Execution → Parallel Subagent Mode

Forge's `run-sprint --parallel` maps directly to subagent's parallel mode:

```
Sprint S01 with 6 tasks:
  Wave 1 (concurrency=4): T01, T02, T03, T04  ← parallel subagent spawns
  Wave 2 (concurrency=2): T05, T06             ← starts as Wave 1 tasks complete
```

The `MAX_CONCURRENCY = 4` constant is defined in [`subagent/index.ts:28`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) (alongside `MAX_PARALLEL_TASKS = 8` at line 27).

## File: `extensions/forgecli/workflow-runner.ts`

### `forge_run_task` Tool

```typescript
pi.registerTool({
  name: "forge_run_task",
  label: "Forge Run Task",
  description: "Orchestrate the full plan→implement→review→approve pipeline for a task",
  promptSnippet: "Use forge_run_task to run a task through the full pipeline",
  promptGuidelines: ["Use forge_run_task for tasks that need the full plan→review→implement→review→approve→commit cycle."],
  parameters: Type.Object({
    task_id: Type.String({ description: "Task ID (e.g. ACME-S01-T01)" }),
    skip_phases: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Read the orchestration workflow
    const orchestration = fs.readFileSync(
      path.join(process.cwd(), ".forge/workflows/orchestrate_task.md"), "utf8"
    );

    // Build the chain — {previous} placeholder is replaced by prior step output
    // See: subagent/index.ts — "task with {previous} placeholder for prior output"
    const chain = [
      { agent: "engineer", task: `Plan task ${params.task_id}. Follow the plan_task workflow.` },
      { agent: "supervisor", task: `Review the plan for task ${params.task_id}. {previous}` },
      { agent: "engineer", task: `Implement task ${params.task_id} following the approved plan. {previous}` },
      { agent: "supervisor", task: `Review the implementation for task ${params.task_id}. {previous}` },
      { agent: "architect", task: `Approve task ${params.task_id}. {previous}` },
      { agent: "engineer", task: `Commit task ${params.task_id}. {previous}` },
    ];

    // ── DO NOT DO THIS ──
    // pi.sendUserMessage(JSON.stringify({ chain }));
    //
    // CORRECTION: An earlier draft of this doc claimed `pi.sendUserMessage(JSON.stringify({chain}))`
    // would invoke the subagent chain. That is wrong. `ExtensionAPI.sendUserMessage()` queues a
    // *user-role message* into the session ([`types.ts:1187`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts));
    // it does NOT synthesize a tool call. The agent receives the JSON as user text and decides
    // what (if anything) to do with it. The subagent is registered as a tool
    // ([`subagent/index.ts:432`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts))
    // — it is invoked by the model emitting a tool-call with the appropriate parameters.
    //
    // Three correct options:
    //   (a) Have `forge_run_task` return a textual instruction (Description-driven) telling the
    //       model to call the `subagent` tool with this specific chain. Returns content to the
    //       model, which then emits the subagent tool call on the next turn.
    //   (b) Import the subagent runner internals (`runChain`/`runParallel` helpers from the
    //       vendored `subagent/index.ts`) and invoke them directly inside `execute()`. This
    //       requires vendoring the subagent module (see stability caveat above) and bypasses the
    //       agent-driven dispatch, which is fine for fully deterministic pipeline phases.
    //   (c) **Recommended for v1.** Drop `forge_run_task` as a custom tool and implement
    //       `/forge:run-task` as a `registerCommand`. The command handler calls
    //       `ctx.sendUserMessage("...use subagent in chain mode with [...]...")` then
    //       `await ctx.waitForIdle()` between phases — identical to the init-orchestrator
    //       pattern. This keeps orchestration in the deterministic command layer and lets the
    //       subagent tool do its normal job.
    throw new Error("forge_run_task: redesign per options (a)/(b)/(c) above");
  },
});
```

### Chain Syntax

The `{previous}` placeholder in task descriptions is replaced by the subagent extension with the output of the previous chain step. This gives each agent context from the prior step.

Source: [`subagent/index.ts:507`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) — `step.task.replace(/\{previous\}/g, previousOutput)`.

### Agent Definitions

Agents are defined as `.pi/agents/*.md` files with YAML frontmatter. The subagent extension discovers them via [`agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts):

```typescript
interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];      // Tool allowlist for this agent
  model?: string;        // Model override (e.g. "claude-sonnet-4-5")
  systemPrompt: string;   // Full system prompt (the Markdown body)
  source: "user" | "project";
  filePath: string;
}
```

Discovery function: `discoverAgents(cwd, scope)` — walks `.pi/agents/` directories, parses frontmatter with `parseFrontmatter()` from [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts).

#### Agent Example

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

When `forgecli init` runs Phase 3 (Materialize), it generates these `.pi/agents/*.md` files from the base-pack personas with `{{KEY}}` substitutions resolved.

### Agent Per-Phase Tool Restrictions

| Phase | Agent | Tools Allowed | Model |
|---|---|---|---|
| Plan | engineer | read, grep, find, ls, forge_store | sonnet |
| Review Plan | supervisor | read, grep, find, ls | opus |
| Implement | engineer | all (read, bash, edit, write, etc.) + forge extensions | sonnet |
| Review Code | supervisor | read, grep, find, ls | opus |
| Approve | architect | read, grep, find, ls | opus |
| Commit | engineer | read, bash, write | haiku |

Tool restrictions are enforced by the subagent extension's `--tools` flag — it passes `agent.tools.join(",")` to the spawned pi process via `--tools` CLI arg. See [`subagent/index.ts:267`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) — `args.push("--tools", agent.tools.join(","))`.

## Source Code References

| Concept | Source File |
|---|---|
| Subagent tool (single/parallel/chain) | [`examples/extensions/subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| Agent discovery & `AgentConfig` type | [`examples/extensions/subagent/agents.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/agents.ts) |
| Frontmatter parsing (`parseFrontmatter`) | [`src/utils/frontmatter.ts`](../../pi-mono/packages/coding-agent/src/utils/frontmatter.ts) |
| `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4` | [`subagent/index.ts:27-28`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| `--tools` flag for agent tool restrictions | [`subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| `--model` flag for agent model override | [`subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| `{previous}` placeholder replacement | [`subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| `--append-system-prompt` for agent system prompts | [`subagent/index.ts`](../../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts) |
| `pi.registerTool()` API | [`types.ts:1133`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |
| `ToolDefinition<TParams, TDetails, TState>` | [`types.ts:426`](../../pi-mono/packages/coding-agent/src/core/extensions/types.ts) |