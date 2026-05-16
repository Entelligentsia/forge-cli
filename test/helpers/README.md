# Test helpers — scripted-subagent harness

This directory pairs with `../fixtures/sprint-fixture.ts` to provide a
**real-stack** test harness for orchestrator-level forge-cli behaviour. It
replaces the module-level `vi.mock` pattern used in older suites
(`run-sprint.test.ts`, `run-task.test.ts`) for tests that need to verify
state transitions, event emission, and schema conformance — concerns that
mocks can't honestly test because they erase the very seams under test.

Background: [forge-cli#17](https://github.com/Entelligentsia/forge-cli/issues/17).

---

## Why this exists

The legacy run-sprint test pattern mocks five things at module level:

```ts
vi.mock("@entelligentsia/pi-coding-agent");           // createAgentSession
vi.mock("node:child_process");                         // spawnSync
vi.mock("../../../src/.../run-task.js");               // runTaskPipeline
vi.mock("../../../src/.../session-registry.js");       // registry
vi.mock("../../../src/.../forge-subagent.js");         // runForgeSubagent
```

That suite is great for asserting **that the orchestrator calls the right
functions in the right order**, but it cannot detect:

- Schema drift in emitted `sprint-complete` / `sprint-halted` payloads
  (`spawnSync` is mocked → real `store-cli emit` against the real
  `event.schema.json` never runs)
- Verdict-resolution drift (the architect subagent's `update-status` is
  mocked away; the orchestrator's verdict read sees fabricated stdout)
- `session-registry` lifecycle bugs (mocked)
- The `runForgeSubagent → onEvent → registry → emit` wiring as a whole

The end-to-end smoke at `hello-testbench` catches these — but it's manual,
slow, non-deterministic (real LLM), and not part of CI.

---

## The seam

pi exposes a `streamFn` on the `Agent` class (see
`@entelligentsia/pi-agent-core`). Override it and the entire LLM provider is
replaced with a scripted fake — **but the agent loop still executes real
tool calls**. Fake the model, run the tools for real.

`forge-cli/src/extensions/forgecli/forge-subagent.ts` exposes this as
`RunSubagentOptions.streamFn`. `run-task.ts` and `run-sprint.ts` thread a
factory (`streamFnFactory`) so a test can script every dispatch from a
single seam — per-phase task pipeline + ceremony.

In production code, `streamFn` / `streamFnFactory` are always undefined.
Setting them in production code would silently route a real subagent
dispatch through a fake provider — there is no use case for that.

---

## API

### `scripted-subagent.ts`

```ts
scriptArchitectCeremony({ model?, provider?, verdict? }): StreamFn
```

Successful architect-ceremony stream. Emits `start` + `done(stop)`. The
`verdict` field is **documentation only** — the orchestrator resolves the
actual verdict from the sprint status in the store after the subagent
returns. Set sprint status in your fixture with `fixture.updateSprintStatus()`
to drive verdict resolution.

```ts
scriptTaskPipelinePhase({ model?, provider? }): StreamFn
```

Successful pipeline-phase stream. Emits `start` + `done(stop)`. Use directly
or via the factory.

```ts
scriptHalt({ errorMessage?, model?, provider? }): StreamFn
```

Failing stream. Emits `start` + `error`. `runForgeSubagent` returns
`exitCode: 1`. Use to drive halt scenarios in `runTaskPipeline`.

```ts
scriptTaskPipeline({ failAt?, ceremony?, model?, provider? }): StreamFnFactory
```

Factory that scripts both per-phase pipeline and ceremony in one place.
`failAt` is a phase role (`"plan"`, `"implement"`, `"review-code"`, …) — at
that phase, `scriptHalt` is returned. All other phases use a successful
no-op stream. The ceremony defaults to `scriptArchitectCeremony()`.

### `../fixtures/sprint-fixture.ts`

```ts
buildSprintFixture({ sprintId, tasks, sprintStatus? }): SprintFixture
```

Builds a disposable `.forge/` tree in `tmpdir`. Writes sprint + tasks to the
store via the **real** `store-cli.cjs write` (schema-validated). Symlinks
real schemas from `forge/forge/schemas/` so `store-cli emit` validates
events against the live schema. Cleanup via `fixture.cleanup()`.

```ts
fixture.readEmittedEvents() → Record<string, unknown>[]
fixture.updateSprintStatus(status: string) → void   // via real store-cli
fixture.eventSchemaPath                              // real event.schema.json
fixture.forgeRoot                                    // real forge payload
```

---

## Pattern

```ts
import { buildSprintFixture } from "../../fixtures/sprint-fixture.js";
import { scriptArchitectCeremony, scriptHalt } from "../../helpers/scripted-subagent.js";

const fixture = buildSprintFixture({
  sprintId: "FORGE-S99",
  sprintStatus: "completed",                       // drives verdict=complete
  tasks: [
    { id: "FORGE-S99-T01", status: "committed" },  // pre-completed, skip pipeline
    { id: "FORGE-S99-T02", status: "committed" },
  ],
});

const streamFnFactory: StreamFnFactory = (ctx) => {
  if (ctx.kind === "ceremony") return scriptArchitectCeremony();
  return undefined;   // task-phase scripts only if pipeline actually runs
};

registerRunSprint(pi, { cwd: fixture.projDir, streamFnFactory });
await invokeRunSprint(pi, ctx, fixture.sprintId);

const events = fixture.readEmittedEvents();
const sprintComplete = events.find((e) => e.type === "sprint-complete");
expect(sprintComplete?.verdict).toBe("complete");

// Schema validation against the real event.schema.json
const schema = JSON.parse(fs.readFileSync(fixture.eventSchemaPath, "utf8"));
expect(realValidateRecord(sprintComplete, schema)).toEqual([]);

fixture.cleanup();
```

`realValidateRecord` uses forge's dependency-free validator (the same one
`store-cli.cjs` calls on write) — no new test dependency. See
`run-sprint.ceremony.test.ts` for the canonical wiring.

---

## Two patterns for ceremony fidelity

| Pattern | When | Trade-off |
|---|---|---|
| **Pre-completed tasks** (status=committed) | Testing ceremony / event emission only | Bypasses pipeline; can't catch per-phase orchestration bugs |
| **Real pipeline + scripted phases** | Testing pipeline → ceremony flow | Slower; each phase needs a viable scripted stream |

Pick the pattern that isolates the concern you're testing. See
`run-sprint.ceremony.test.ts` for both — clean-complete uses pre-completed
tasks; halt-on-failure runs the real pipeline with a scripted halt.

---

## Verdict resolution — who sets the sprint status?

In production, the architect subagent calls
`store-cli update-status sprint <id> status <status>` via Bash. The
orchestrator then reads sprint.status to resolve `verdict`.

A scripted ceremony emits **no tool calls**, so it doesn't update sprint
status. Two options:

1. **Pre-set in the fixture**: `buildSprintFixture({ sprintStatus: "completed" })`
   — recommended when the test is verifying the orchestrator, not the
   architect.
2. **Call `fixture.updateSprintStatus()` between dispatch and verdict read**:
   not generally possible from outside — the orchestrator reads
   synchronously after the subagent returns. Future enhancement: script the
   ceremony streamFn to emit a `Bash` tool call that runs `update-status`.

---

## Limitations / follow-ups

- **Pipeline coverage in scripted mode is shallow.** A scripted phase emits
  `done(stop)` immediately with no tool calls, so the orchestrator's verdict
  read between phases sees stale store state. This is fine for halt tests
  (failure at first phase) and ceremony-isolated tests (pre-committed
  tasks), but a full real-pipeline test (e.g. T01 walks plan→implement→…→
  commit with scripted streams) would require scripted streams that emit
  `Bash` tool calls to set verdicts at each review phase.

- **No support yet for emitting tool calls from scripts.** The current
  builders emit only `start` + `done`/`error`. A future addition could
  accept a tool-call sequence and emit `toolcall_start` + `toolcall_end` so
  tests can drive real bash sessions through scripted reasoning.

- **The legacy `run-sprint.test.ts` is unchanged.** It retains its
  module-level `vi.mock` blocks; rewriting all of its cases against this
  harness was scoped out of forge-cli#17 because each case needs case-
  specific fixture setup and the legacy mocks would conflict with the
  unmocked approach in the same file. New ceremony cases go in
  `run-sprint.ceremony.test.ts`.

- **`run-sprint.ceremony.test.ts` covers four of the six Plan-12 cases
  listed in forge-cli#17**: clean-complete (with full schema validation
  against the real `event.schema.json`), halt-on-failure (sprint-halted
  emitted, no ceremony), verdict=partial fallback when ceremony doesn't
  transition the sprint, and the streamFnFactory threading seam through
  `runTaskPipeline`. The remaining two cases (user-paused with 0
  completed, user-paused with N completed) require driving real per-task
  pipeline runs to "completed" via scripted streams that emit Bash
  tool calls — they're left to the same follow-up that adds tool-call
  emission support to the script builders.
