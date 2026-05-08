# forge-cli Feasibility — Architectural Review

**Reviewer:** Architectural fact-check against `pi-mono` source.
**Inputs:** `forge-cli-feasibility.txt`, `reference-docs/00–11`, `pi-mono/packages/coding-agent` @ `@earendil-works/pi-coding-agent` v0.73.0.
**Date:** 2026-05-07.

---

## Executive Verdict

**Feasible with caveats.** The proposal's central claim — that `pi-coding-agent`'s extension API provides the bridge-bar primitives Forge needs (slash commands, custom tools, hook-style event interceptors, lifecycle events, system-prompt injection, headless SDK) — is **substantively correct and verifiable in source**. The ~880-line size estimate is plausible for the registration glue, hook dispatcher, and headless runner. However, the proposal contains one design-level misreading (how the subagent tool is invoked from an extension), one stability risk it does not flag (the subagent extension lives in `examples/`, not core), and a handful of citation drift in the reference docs. None of these are blocking; the path forward is to tighten the orchestration layer and either vendor or upstream the subagent example.

---

## Verified Claims

The following are confirmed against pi-mono v0.73 source:

- **Package coordinates.** `@earendil-works/pi-coding-agent` v0.73.0 (`packages/coding-agent/package.json:2-3`), CLI binary `pi` (`bin.pi → dist/cli.js`). Sister packages `@earendil-works/pi-ai` and `@earendil-works/pi-tui` exist at the same version. Proposal's `dependencies` block is accurate.
- **Extension API events used by the proposal.** All cited events exist on `ExtensionAPI.on(...)`:
  - `session_start` — `src/core/extensions/types.ts:1090`, event def at `:514`
  - `before_agent_start` — `:1110`, event def at `:625`
  - `tool_call` (mutable input, `block`+`reason` result) — `:1123`, event at `:772`, result at `:984`
  - `tool_result` — `:1124`, event at `:833`, result at `:998`
- **Extension API actions.** `registerTool` (`:1133`), `registerCommand` (`:1142`), `sendUserMessage` (`:1187`, with `deliverAs: "steer" | "followUp" | "nextTurn"` per `:1180`), `appendEntry` (`:1193`).
- **Tool-call blocking.** `ToolCallEventResult { block?: boolean; reason?: string }` at `:984-988`. Proposal's `validate-write` translation (`return { block: true, reason: ... }`) compiles against this contract.
- **`ToolDefinition` shape.** `label`, `description`, `promptSnippet`, `promptGuidelines`, `parameters` (TypeBox `TSchema`), `execute(toolCallId, params, signal, onUpdate, ctx)`, `renderCall`, `renderResult` — all present at `src/core/extensions/types.ts:426-470`. Matches the `forge_collate` / `forge_store` wrappers verbatim.
- **`ExtensionCommandContext`.** `ctx.ui.confirm(...)`, `ctx.ui.notify(...)`, `ctx.ui.setStatus(key, text)`, `ctx.ui.setWidget(...)`, `ctx.waitForIdle()`, `ctx.sendUserMessage(text, { deliverAs })` are all real (`types.ts:124-173`, `:333-380`, `:1509-1510`). The init-orchestrator's "send prompt → waitForIdle → next phase" pattern is supported.
- **SDK headless path.** `createAgentSession`, `AuthStorage`, `ModelRegistry`, `SessionManager` (`.create` + `.inMemory`), `SettingsManager` (`.create` + `.inMemory`), `DefaultResourceLoader`, `getAgentDir`, `createEventBus`, `createAgentSessionRuntime`, `createAgentSessionServices` are all exported (`src/core/sdk.ts:193`, `src/core/index.ts:18-30`). `session.prompt(text, options?)` exists at `src/core/agent-session.ts:967`.
- **`DefaultResourceLoader` options.** `additionalExtensionPaths`, `skillsOverride`, `promptsOverride`, `extensionsOverride` — all on `DefaultResourceLoaderOptions` (`src/core/resource-loader.ts:116-141`). The proposal's `loader.reload()` call is the documented flow (see `sdk.ts:184` doc-example).
- **`pi install` and `pi -e`.** CLI supports `pi install <source>` with `npm:` and `git:` source schemes (`src/cli/args.ts:208`, `src/core/package-manager.ts:1371`, `src/utils/git.ts:131-158`). `--extension, -e <path>` flag exists (`src/cli/args.ts:132,237`). Both lines from "Installation and Distribution" are valid.
- **`pi` field in `package.json`.** `PiManifest { extensions?, skills?, prompts?, themes? }` (`src/core/package-manager.ts:147-152`, read at `:518-525`). Proposal's `package.json` `pi` block is correctly shaped (themes optional and unused).
- **Subagent capabilities.** `examples/extensions/subagent/index.ts` registers a `subagent` tool with three modes — `single` / `parallel` / `chain` (`:432`, `:455-457`, `:501`); `MAX_PARALLEL_TASKS = 8` (`:27`), `MAX_CONCURRENCY = 4` (`:28`); `{previous}` placeholder replacement at `:507`; per-agent `--model` (`:266`), `--tools` (`:267`), `--append-system-prompt` (`:298`). All of `reference-docs/06`'s functional claims are correct.
- **Agent discovery.** `examples/extensions/subagent/agents.ts:97-115` discovers from `getAgentDir()/agents` (user) and `findNearestProjectAgentsDir(cwd)` → `.pi/agents/` (project). YAML frontmatter parsed via `parseFrontmatter` from `@earendil-works/pi-coding-agent`. Proposal's `.pi/agents/*.md` placement is correct **for the subagent extension's discovery rules**.

---

## Inaccurate or Unverified Claims

### 1. Misreading: `pi.sendUserMessage(JSON.stringify({ chain }))` does **not** invoke the subagent tool
- **Severity:** High (architectural).
- **Where:** Feasibility doc lines 757; `reference-docs/06-multi-agent-orchestration.md:88`.
- **Claim:** A custom `forge_run_task` tool implementation can launch a subagent chain by calling `pi.sendUserMessage(JSON.stringify({ chain }))`.
- **What the code shows:** The subagent is registered as a **tool** (`examples/extensions/subagent/index.ts:432` — `pi.registerTool({ name: "subagent", ... })`). It is invoked by the model emitting a tool call with the parameters. `ExtensionAPI.sendUserMessage(text, options)` queues a *user-role message* into the session (`src/core/extensions/types.ts:1187`) — it does not synthesize a tool call. The agent would receive the JSON as user text and choose what (if anything) to do with it.
- **Implication:** The `forge_run_task` tool's `execute()` body needs a different mechanism. Realistic options:
  1. Make `forge_run_task` a thin shim that returns an instruction telling the agent to call the `subagent` tool with a specific chain (i.e., text content the model will act on).
  2. Have `forge_run_task` directly import and invoke the subagent runner internals (the `runChain`/`runParallel` helpers in `subagent/index.ts`) rather than going through tool dispatch.
  3. Drop `forge_run_task` and have `/forge:run-task` (a `registerCommand`) issue `ctx.sendUserMessage("...use subagent in chain mode with [...]...")` then `waitForIdle()`, identical to the init orchestrator pattern.
- **Verdict:** Feasible, but the workflow-runner sketch needs to be redesigned. ~50 lines of redo.

### 2. Stability risk: subagent is `examples/`, not core
- **Severity:** Medium (risk, not blocker).
- **Claim:** Multi-agent orchestration "requires zero new infrastructure — it's pure configuration" (`reference-docs/06:16`).
- **What the code shows:** Subagent lives at `pi-mono/packages/coding-agent/examples/extensions/subagent/` and depends on agent discovery code in the same example dir (`agents.ts`). The `examples/` directory is shipped (`package.json:files: ["dist","docs","examples","CHANGELOG.md"]`) but is not a stable API surface; nothing in `src/core/` exposes the subagent runner. It is governed only by example-package conventions — its tool name, parameter schema, agent file format, and discovery scopes can change between releases without semver implications for `src/core/`.
- **Implication:** forgecli has three options: (a) take a runtime dependency on the example path and pin the pi-coding-agent version tightly; (b) **vendor** the subagent extension into `forgecli/extensions/forgecli/subagent/`; (c) propose upstreaming subagent into `src/core/` so it gains a stable contract. (b) is the lowest-risk default for v1.
- **Verdict:** Not flagged in the proposal. Should be called out in the implementation plan.

### 3. Citation drift in reference docs (line numbers stale)
- **Severity:** Low (cosmetic).
- **Examples:**
  - `reference-docs/06:155` cites `MAX_PARALLEL_TASKS=8, MAX_CONCURRENCY=4` at `subagent/index.ts:14-15`. Actual: lines `27-28`.
  - `reference-docs/00` cites `types.ts:1116` for `registerTool` and `types.ts:1139` for `registerCommand`. Actual: `:1133` and `:1142`.
  - `00:23` cites `types.ts:1158` for `appendEntry`. Actual: `:1193`.
  - `00:27` cites `:1100` for `before_agent_start` handler signature. Actual: `:1110`.
- **Verdict:** All symbols exist; only the line numbers drift (likely against an earlier minor version of types.ts). No semantic errors.

### 4. Hook protocol parity overstated for `PermissionRequest`
- **Severity:** Low.
- **Where:** Feasibility doc lines 693-695; `reference-docs/04` and `11`.
- **Claim:** Claude Code's `PermissionRequest(Bash|Write|...) → forge-permissions.js` maps to `pi.on("tool_call")`.
- **What the code shows:** `tool_call` can `block` with a reason but does not implement an interactive approve/deny dialog. pi has a separate permission UX in `examples/extensions/permission-gate.ts` and `protected-paths.ts` that does this work. The right mapping is `permission-gate` extension or composing `tool_call` with `ctx.ui.confirm()` from `ExtensionUIContext` — not raw `tool_call` filtering.
- **Verdict:** Achievable, but conflates two different hook semantics. Spec the permission flow explicitly in the implementation plan.

### 5. Skill format compatibility — partially asserted, not fully verified
- **Severity:** Low.
- **Where:** Feasibility doc 785-786 says Forge's `SKILL.md` files "work in pi as-is".
- **What the code shows:** pi has its own skill discovery (`src/core/skills.ts`, called via `loadSkills` in `resource-loader.ts:20`). It supports SKILL.md loading. I did not deep-check Forge's specific frontmatter fields against pi's parser; the claim is plausible but unverified at the field level. Cheap follow-up: load `forge/skills/refresh-kb-links/SKILL.md` through pi's loader and assert no diagnostics.

### 6. `before_agent_start` return value
- **Severity:** Informational.
- **Claim:** Handler returns `{ systemPrompt: ... }` (feasibility doc 161-164).
- **What the code shows:** `BeforeAgentStartEventResult` (`types.ts:1009-…`) supports a `message` of `Pick<CustomMessage, "customType" | "content" | "display" | "details">`. The exact shape Forge wants — concatenating onto the system prompt — works, but the field name in the proposal sketch (`systemPrompt`) may not be literal. Treat as pseudocode; confirm exact fields when implementing.

---

## Gaps / Missing Primitives in pi-mono

1. **No first-class subagent in core.** As above. Vendor or upstream.
2. **No declarative permission policy.** Permission decisions require composing `tool_call` + `ui.confirm`, or using `permission-gate` example. Forge currently has structured `forge-permissions.js` rules; translation will need a small policy engine in the extension.
3. **No native "post-tool-bash-with-pattern-matching" hook.** Forge's `post-init.cjs` and `post-sprint.cjs` rely on the Claude Code hook running after specific bash commands match patterns. In pi, the equivalent is `tool_result` filter on `forge_collate`/`forge_store` (custom-tool results). Feasible but means hook semantics shift from "after bash X" to "after custom-tool Y" — a healthier design but it requires that all triggering operations be routed through the wrapped tools, **not** raw bash. Forge currently allows agents to invoke `node forge/tools/store-cli.cjs ...` via bash; under pi this must become `forge_store` tool calls.
4. **No "exec on init" command pre-registration.** pi's command handlers fire when the user types `/forge:init`. In Claude Code, the workflow file content is loaded; in pi, the extension must read the workflow markdown and drive `ctx.sendUserMessage`. The init-orchestrator sketch handles this correctly, but the same pattern must be repeated for every workflow command — that's the bulk of the ~300 lines in `forge-commands.ts`.
5. **No prompt template ↔ command unification.** Forge wants `/forge:plan` to be both a slash command (registered via `registerCommand`) and a prompt template (`.pi/prompts/plan.md`). pi treats these as separate concerns. The proposal's "ship workflows as prompts" is fine for one-shot user invocation but orchestrated workflows that need ctx.waitForIdle / ctx.ui.* must be commands, not prompts. Plan to ship some as commands and some as prompts; the proposal blurs this line.

---

## Risk-Ranked Blockers

| Rank | Risk | Severity | Mitigation |
|------|------|----------|------------|
| R1 | `forge_run_task` design (sendUserMessage ≠ subagent invocation) | High | Redesign workflow-runner to either (a) instruct the agent textually to call the subagent tool, or (b) import the subagent runner directly. ~50 lines. |
| R2 | Subagent example API instability | Medium | Vendor `subagent/{index.ts,agents.ts}` into forgecli; pin pi-coding-agent version. |
| R3 | Bash-pattern hooks require routing through wrapped tools | Medium | Change Forge's post-init/post-sprint triggers to fire on `tool_result` of `forge_collate`/`forge_store`, and discourage raw bash invocations of `.cjs` tools in pi mode (provide guidance in agent system prompts). |
| R4 | Permission semantics ≠ Claude Code 1:1 | Low–Medium | Adopt `permission-gate` extension pattern; spec rules explicitly. |
| R5 | `BeforeAgentStartEventResult` shape (`systemPrompt` vs `message`) | Low | Verify field names during implementation; trivial typo fix. |
| R6 | Skill frontmatter compatibility | Low | One-time load test. |
| R7 | Citation drift in reference docs | Low | Refresh line numbers when docs are next edited; pin to a pi-coding-agent commit SHA. |

---

## Recommended Path Forward

### Build (in `forgecli/`)
1. **`extensions/forgecli/index.ts`** — registration glue (~200 lines). Use the proposal as-is; verify `BeforeAgentStartEventResult` fields.
2. **`extensions/forgecli/forge-tools.ts`** — TypeBox-typed wrappers around the existing `.cjs` tools (~150 lines). Ship `forge_collate`, `forge_store`, `forge_validate_store`, `forge_config`. Keep `execSync` boundary; signal-aware termination.
3. **`extensions/forgecli/hook-dispatcher.ts`** — `tool_call`/`tool_result` filters for write-validation, error triage, post-sprint trigger (~80 lines). Move post-init detection out — it belongs in the `/forge:init` command handler (proposal already notes this).
4. **`extensions/forgecli/forge-commands.ts`** — `/forge:init`, `/forge:run-task`, `/forge:sprint-plan`, `/forge:health`, etc. (~300 lines). Drive each via `ctx.sendUserMessage` + `ctx.waitForIdle` for LLM phases and `execSync` for deterministic phases.
5. **`extensions/forgecli/subagent/`** — **vendor** `subagent/index.ts` and `agents.ts` from pi-mono examples (~700 LOC vendored). Add a single-file fork note. Accept this as a known maintenance debt until upstreaming lands.
6. **`bin/forgecli.ts`** — headless runner (~150 lines). Pattern from proposal is correct.
7. **`agents/*.md`, `prompts/*.md`** — generated by extending Forge's `substitute-placeholders.cjs` with a `pi` output target.

### Reuse (from pi-mono)
- All of `src/core/sdk.ts`, `agent-session.ts`, `resource-loader.ts`, `session-manager.ts`, `settings-manager.ts`, `auth-storage.ts`, `model-registry.ts`, `prompt-templates.ts`, `skills.ts`, built-in tools.
- The `parseFrontmatter` util.
- The `DefaultResourceLoader` override hooks (`skillsOverride`, `promptsOverride`, `extensionsOverride`, `additionalExtensionPaths`).

### Upstream (into pi-mono, post-v1)
- Promote `examples/extensions/subagent/` into `src/core/` with a stable `subagent` API surface and explicit semver. This is the single biggest reduction in forgecli's long-term maintenance cost.
- Optionally: a permission-policy extension contract (declarative rules → `tool_call` block decisions) so Forge can ship `forge-permissions.json` rather than open-coding rules in TypeScript.

### Adapt (in `forge/`)
- `substitute-placeholders.cjs`: add a `pi` output target for personas (→ `.pi/agents/*.md`) and workflows (→ `.pi/prompts/*.md`). Single-line `SUBDIR_OUTPUT_MAP` extension as the proposal sketches.
- `tools/*.cjs`: already accept `--forge-root`. No changes needed beyond confirming this contract is enforced for all callers.
- Document the "no raw bash for store/collate operations under pi" guidance in agent system prompts (the personas).

### Validation gates before declaring v1
- Boot `bin/forgecli.ts init` headlessly in an empty repo → produces identical `.forge/` and `engineering/` outputs as the Claude Code path.
- `forgecli run-task ACME-S01-T01` exercises the full chain through the vendored subagent.
- Side-by-side parity test: same task, run via Claude Code plugin and via forgecli, diff `engineering/` outputs.
- Performance smoke: cold start of `bin/forgecli.ts` < 2 s; first turn latency comparable to interactive `pi`.

---

## Bottom Line

The proposal's core insight is right: pi-coding-agent's extension and SDK surfaces map cleanly onto Forge's bridge-bar requirements, and ~880 lines of new TypeScript is a credible estimate for the glue. Two concrete fixes are needed before implementation begins — redesigning `forge_run_task` to dispatch the subagent tool correctly, and deciding whether to vendor or upstream the subagent example. Neither is blocking; both are well-scoped. Recommend proceeding with the implementation plan, with an explicit ADR covering the subagent vendoring decision.
