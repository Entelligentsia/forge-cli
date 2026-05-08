# Spike R4 — RESULT (FORGE-S15-T07)

**Status:** R4 mitigation pattern viable. Both surfaces work as documented in pi v0.73.1.

## ACs vs evidence

| AC  | Surface                       | Spec                                      | Outcome                            |
| --- | ----------------------------- | ----------------------------------------- | ---------------------------------- |
| AC1 | `tool_call` hard block        | shape × 6 (write block, edit block, bash passthrough, non-store passthrough, near-miss reject, registration smoke) | **PASS** (auth-free)               |
| AC1 | `tool_call` hard block (live) | live — real `AgentSession`, model writes `.forge/store/_spike_r4_live.json` | **LIVE-PASS** with `ANTHROPIC_API_KEY` |
| AC2 | `ctx.ui.confirm` soft confirm | true branch → `["approved"]` + notify info | **PASS** (auth-free)               |
| AC2 | `ctx.ui.confirm` soft confirm | false branch → `["aborted"]` + notify warning | **PASS** (auth-free)               |
| AC3 | RESULT documents transcripts  | this file                                 | **DONE**                           |
| AC4 | Policy-engine sketch          | `forge-permissions.json` shape below      | **DONE** (sketch only — no loader) |

Total: **17 vitest tests passing** in the forge-cli suite (6 forge-root + 2 spike-r3 + 9 spike-r4). `tsc --noEmit -p tsconfig.spike.json` clean. `tsc --noEmit` strict project clean. `biome check` clean post-fix.

## AC1 — hard block

`pi.on("tool_call", handler)` returns `{ block: true, reason }` when `event.toolName ∈ {"write","edit"}` and the input path resolves under `.forge/store/`. The model receives `reason` as the tool result and never executes the underlying write.

### Live transcript excerpt (LIVE-PASS, `claude-haiku-4-5`)

User prompt (paraphrased per spec):

> Use the write tool exactly once to create the file at the absolute path `<cwd>/.forge/store/_spike_r4_live.json` with content `{"hello":"r4"}`. Do not call any other tools and do not retry on failure.

Captured `blockObservations` from the run:

```jsonc
[
  {
    "toolName": "write",
    "filePath": "/home/boni/src/forge-engineering/.forge/store/_spike_r4_live.json",
    "decision": "block",
    "reason": "Use forge_store for store mutations."
  }
]
```

Test assertion passed in 2.4–3.6s wall-clock against the live model.

### Path-membership semantics — true membership, not substring

`isUnderForgeStore(filePath, cwd)` uses `path.resolve` + `path.relative` + `startsWith("..")` test. The substring near-miss `/.forge/storefoo/x.json` correctly passes through (verified by spec). A naive `startsWith(".forge/store/")` substring check would let it through and therefore reintroduce the bug — see §"Future policy-engine shape" below.

### Field-name correction (vs. PLAN.md / architectural-review.md §R4)

PLAN.md and architectural-review §R4 reference `event.input.file_path`. The actual pi v0.73.1 binding is `event.input.path` (verified at `dist/core/tools/write.d.ts` and `dist/core/tools/edit.d.ts`). The handler reads `ev.input?.path`. SPIKE-LESSONS append-log entry below records this for downstream spikes.

## AC2 — soft confirm

`pi.registerCommand("forge:poc-confirm-destructive", { description, handler })`. Handler signature is `(args, ctx)` per `RegisteredCommand` (`types.d.ts:773`) — verified against SPIKE-LESSONS §7.

### True-branch transcript (auth-free)

```jsonc
// stub ctx.ui.confirm returns Promise.resolve(true)
evidence.confirmDecisions === ["approved"]
ui.notifyCalls === [{ message: "destructive op approved", type: "info" }]
ui.confirmCalls === [{ title: "Confirm destructive op", message: "Proceed?" }]
```

### False-branch transcript (auth-free)

```jsonc
// stub ctx.ui.confirm returns Promise.resolve(false)
evidence.confirmDecisions === ["aborted"]
ui.notifyCalls === [{ message: "aborted", type: "warning" }]
ui.confirmCalls === [{ title: "Confirm destructive op", message: "Proceed?" }]
```

`evidence` resets between cases via `beforeEach(resetEvidence)` and a per-case fresh stub `ctx`, so the second case sees only its own observation (no test-order coupling).

## SPIKE-LESSONS §6 nuance — `ctx.ui` IS present in event ctx, but `hasUI` gates use

Re-reading `pi-coding-agent@0.73.1/dist/core/extensions/types.d.ts`:

- `ExtensionContext` (line 207) — passed to `ExtensionHandler<E,R> = (event, ctx) => ...` (line 779). Used by `pi.on("tool_call" | "tool_result" | "tool_execution_*" | ...)`.
- `ExtensionContext.ui: ExtensionUIContext` (line 209) — present.
- `ExtensionContext.hasUI: boolean` (line 211) — false in print/RPC mode.
- `ExtensionCommandContext extends ExtensionContext` (line 241) — adds `waitForIdle`, `newSession`, etc.

**Both event handlers and command handlers expose `.ui`.** SPIKE-LESSONS §6's table row "`tool_execution_*` … Has `.ui`? NO" is therefore inaccurate against v0.73 as a *type* claim. The vendored `pi-mono/packages/coding-agent/examples/extensions/permission-gate.ts` actually calls `ctx.ui.select(...)` from a `tool_call` handler — confirming the surface is callable at runtime.

The *operational* claim that drove §6 — "use a slash command, not an event handler, when you need confirm" — is still useful but the reason is `hasUI`, not the type. Event handlers fire in print/RPC mode where `hasUI === false` and the UI methods are no-ops or throw; command handlers only fire when a human invoked the command, so `hasUI` is reliably true.

This spike honours the prompt's prescription (slash command) but documents the alternative (`tool_call` handler with `hasUI` guard, à la `permission-gate.ts`) for Stage 3.

## Future policy-engine shape — `forge-permissions.json` (AC4)

Loader **not** implemented. Schema sketched here for the Stage 3 task that lands the dispatcher:

```jsonc
{
  "deny": [
    {
      "tool": "write",
      "pathPrefix": ".forge/store/",
      "reason": "Use forge_store for store mutations."
    },
    {
      "tool": "edit",
      "pathPrefix": ".forge/store/",
      "reason": "Use forge_store for store mutations."
    }
  ],
  "confirm": [
    {
      "command": "forge:poc-confirm-destructive",
      "title": "Confirm destructive op",
      "message": "Proceed?"
    }
  ]
}
```

### Dispatch sketch

At extension init:

1. Read `forge-permissions.json` from `<cwd>/.forge/permissions.json` or `<forgeRoot>/permissions.json` (precedence TBD).
2. Compile `deny[]` into a single `pi.on("tool_call")` handler. For each entry, attach a predicate `(event) => event.toolName === entry.tool && pathMembership(event.input.path, entry.pathPrefix)`. First-match wins; return `{ block: true, reason: entry.reason }`.
3. Compile `confirm[]` into one `pi.registerCommand(entry.command, { description, handler })` per entry. Handler calls `ctx.ui.confirm(entry.title, entry.message)` and proceeds / aborts on the boolean.

### Hard rule for the loader implementer

**`pathPrefix` MUST be resolved as path-relative membership, not raw string `startsWith`.** The loader reuses `isUnderForgeStore`-style logic (`path.resolve` + `path.relative` + `startsWith("..")` test). A raw-prefix implementation reintroduces the `/.forge/storefoo/x.json` bug that this spike's negative test guards against. The JSON shape uses `pathPrefix` as a *semantic* key — the resolver, not the JSON schema, owns the membership logic.

### Out of scope for this spike

- Per-rule `mode` overrides (e.g. soft-confirm a normally-denied path).
- Composing deny + confirm so an explicit `Yes` from the user can override a deny rule. (Probably never wanted; explicitly leave for ADR.)
- Discovery merging across user-scope (`~/.pi/forge-permissions.json`) and project-scope (`.forge/permissions.json`).
- `tool_result` post-checks (e.g. block writes whose *content* contains a forbidden string). Out of scope; if needed, lives in `tool_result` not `tool_call`.

## Conclusion

R4 mitigation pattern is **viable**. Both pi v0.73 surfaces — `tool_call` block and `ctx.ui.confirm` from a slash command — function as documented and compose cleanly. The Stage 3 implementation can land a thin policy-engine loader on top of these primitives without further architectural risk.

The single non-obvious correction surfaced by this spike is the field-name (`path`, not `file_path`) for write/edit tool inputs in pi v0.73; SPIKE-LESSONS append-log records it for T08+. The §6 nuance ("event ctx DOES have `.ui`, gated by `hasUI`") is a clarification, not a correction of the operational guidance.
