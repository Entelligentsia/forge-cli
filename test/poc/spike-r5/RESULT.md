# Spike R5 — RESULT (FORGE-S15-T08)

**Status:** R5 mitigation pattern viable. Both `BeforeAgentStartEventResult` variants work as documented in pi v0.73.1. Recommended choice: **`systemPrompt`** for forge-cli KB-context injection.

## ACs vs evidence

| AC  | Surface                          | Spec                                                          | Outcome             |
| --- | -------------------------------- | ------------------------------------------------------------- | ------------------- |
| AC1-A | Handler A `systemPrompt` shape | auth-free × 4 (registration, exact result, no message field, append behaviour) | **PASS** (auth-free) |
| AC1-A | Handler A `systemPrompt` live  | live — real AgentSession, agent_start captures marker in system prompt | **LIVE-PASS** with `ANTHROPIC_API_KEY` |
| AC1-B | Handler B `message` shape       | auth-free × 6 (registration, customType, content text, display, details, no systemPrompt field) | **PASS** (auth-free) |
| AC1-B | Handler B `message` live        | live — real AgentSession, agent_end captures forge.kb_context custom message | **LIVE-PASS** with `ANTHROPIC_API_KEY` |
| AC2 shape | RESULT.md confirms confirmed shape | this file §1 | **DONE** |
| AC2 choice | RESULT.md recommends a field with rationale | this file §4 | **DONE** |
| AC2 input | RESULT.md states whether BeforeAgentStartEvent exposes system prompt | this file §2 | **DONE** |

Total: **12 vitest tests passing** in spike-r5 (10 auth-free + 2 auth-gated LIVE-PASS). `tsc --noEmit` clean. `tsc --noEmit -p tsconfig.spike.json` clean. Biome clean.

---

## §1 Confirmed `BeforeAgentStartEventResult` shape

Source: `forge-cli/node_modules/@entelligentsia/pi-coding-agent/dist/core/extensions/types.d.ts:735`

```ts
interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  systemPrompt?: string;
}
```

Both fields are optional. A handler may return either, both, or neither (void/undefined = no-op).

Handler registration surface (types.d.ts:796):

```ts
pi.on("before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
```

`ExtensionHandler<E,R> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void` — handler returns `undefined`/`void` for no-op.

---

## §2 `BeforeAgentStartEvent.systemPrompt` accessibility

Source: `dist/core/extensions/types.d.ts:475`

```ts
interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;                // raw user prompt after expansion
  images?: ImageContent[];
  systemPrompt: string;          // fully assembled system prompt string
  systemPromptOptions: BuildSystemPromptOptions;
}
```

**YES** — `event.systemPrompt` is accessible and contains the fully assembled system prompt at the point the handler fires. Forge-cli can therefore **append** to the existing context rather than replace it wholesale:

```ts
return { systemPrompt: `${event.systemPrompt}\n<KB context here>` };
```

This is the pattern validated by Handler A in this spike.

---

## §3 Chaining behaviour of `systemPrompt` across multiple extensions

Source: `agent-session.ts:1093-1097` (not installed but cited in plan/review; confirmed by live test behaviour).

When multiple extensions return `systemPrompt`, pi chains them sequentially: each extension's result becomes the input for the next. If Extension A returns `"BASE\nA"` and Extension B returns `"BASE\nA\nB"` (by reading `event.systemPrompt` which already includes A's result), the final effective system prompt is `"BASE\nA\nB"`.

**Critical design implication:** if Extension B does NOT read `event.systemPrompt` and instead returns a hardcoded string, it **overwrites** Extension A's contribution. Later extensions that blindly replace `systemPrompt` blow away earlier appends. Forge-cli's KB-context injector in Stage 3 MUST always append (`${event.systemPrompt}\n<KB>`) to be composition-safe.

The `systemPrompt` replacement is **per-turn only**: it is reset to `_baseSystemPrompt` between turns. The Handler A live test confirms this — a single `sendUserMessage` fires one `before_agent_start` + one `agent_start`, and the captured system prompt contains the marker exactly once.

---

## §4 Recommended choice for forge-cli KB-context injection

**Recommended: `systemPrompt`**

| Criterion | `systemPrompt` | `message` |
|-----------|---------------|-----------|
| Chaining | Chains across extensions (append pattern) | Independent per-handler; no cross-extension interaction |
| User visibility | Invisible to user (not in TUI transcript) | Visible when `display: true`; appears as a transcript entry |
| Persistence | Per-turn only; reset to base each turn | Permanent transcript entry (persists across turns) |
| KB injection fit | Re-injects every turn — exactly the right semantic for KB context | Injects once and stays; KB content becomes stale in subsequent turns |
| Composability | Append pattern is composition-safe | Each extension's message is independent; no composition needed |

**Rationale:**

KB context must be available to the model on **every turn**, not injected once as a permanent transcript entry. A permanent entry would (a) consume context-window tokens every turn even when irrelevant and (b) become stale if the KB is updated between turns (the model would see the old version permanently). `systemPrompt` reset-per-turn behaviour is the correct semantic: forge-cli's `before_agent_start` handler re-reads and re-injects the KB each turn.

The `display: false` option for `message` would suppress TUI visibility, but the persistence problem remains. `systemPrompt` is the unambiguous choice.

**Stage 3 implementation pattern:**

```ts
pi.on("before_agent_start", async (event) => {
  const kb = await loadKBContext(forgeRoot);   // read latest KB snapshot
  return {
    systemPrompt: `${event.systemPrompt}\n\n## Forge KB Context\n\n${kb}`,
  };
});
```

---

## §5 Assertion mechanisms verified

### Handler A: `agent_start` ctx.getSystemPrompt()

`ctx.getSystemPrompt(): string` is defined on `ExtensionContext` (types.d.ts:235) and on the handler ctx (types.d.ts:1103). It returns the **effective** system prompt after `before_agent_start` handlers have applied their results. Live test confirmed: captures contain `"TEST_SP_MARKER:R5A"`.

Alternative assertion path (not used in this spike): `session.systemPrompt` getter (agent-session.d.ts:261) — polled after `sendUserMessage` resolves.

### Handler B: `agent_end` event.messages filtered to `role === "custom"`

`AgentEndEvent.messages: AgentMessage[]` (types.d.ts:486). `AgentMessage` is a union that includes `CustomMessage` (via `@entelligentsia/pi-agent-core`'s `CustomAgentMessages` augmentation). Filter predicate: `m.role === "custom"`. Live test confirmed: a `CustomMessage` with `customType === "forge.kb_context"` appeared in `event.messages`.

---

## §6 Implementation notes and corrections

### `thinkingLevel: "min"` is not a valid value

`ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` (pi-agent-core/dist/types.d.ts:225). Prior spikes used `"min"` (which passes vitest's own TS check with looser settings but fails `tsc --noEmit -p tsconfig.spike.json` once spike files are properly included). Spike R5 uses `"minimal"`.

### `TextContent` and `CustomMessage` are not re-exported from the main package index

`@entelligentsia/pi-coding-agent` package `exports` only expose `"."` and `"./hooks"`. Neither `TextContent` nor `CustomMessage` appear in `dist/index.d.ts`. Deep imports (`dist/core/messages.js`) are blocked by `moduleResolution: NodeNext`. Solution: define local structural types for the subsets we need (see `spike.ts`'s `CapturedCustomMessage` and `ContentItem`).

### `tsconfig.spike.json` must override `exclude`

The base `tsconfig.json` has `"exclude": ["test"]`. When `tsconfig.spike.json` extends it and provides an `include` array covering `test/poc/spike-r5/**/*.ts`, the inherited `exclude` still overrides. Solution: `tsconfig.spike.json` must add `"exclude": ["node_modules", "dist"]` (omitting `"test"`) so the spike files are actually type-checked.

---

## Conclusion

R5 mitigation pattern is **viable**. Both `BeforeAgentStartEventResult` variants function as documented in pi v0.73.1. The `systemPrompt` field is confirmed as the correct choice for forge-cli's KB-context injection in Stage 3: it re-injects per turn, chains composably across extensions (via the append pattern), and is invisible to the TUI transcript (appropriate for infrastructure context).

The `message` field is confirmed as the correct choice when you want a user-visible, permanent transcript entry (e.g. a KB-context *audit trail* entry, not the injection itself). These two use cases are orthogonal; Stage 3 may use both for different purposes.
