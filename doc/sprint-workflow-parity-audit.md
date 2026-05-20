# Sprint Workflow Parity Audit

**Task:** FORGE-S23-T12
**Date:** 2026-05-20
**Auditor:** forge-cli-engineer (inline)

## Scope

Compare S19-shipped `sprint-intake.ts` and `sprint-plan.ts` handlers against current plugin meta-workflows:

- `forge-cli/src/extensions/forgecli/sprint-intake.ts` (112 lines)
- `forge-cli/src/extensions/forgecli/sprint-plan.ts` (155 lines)
- `forge/forge/meta/workflows/meta-sprint-intake.md`
- `forge/forge/meta/workflows/meta-sprint-plan.md`

Also compared against the generated workflow files the handlers actually read at runtime:

- `.forge/workflows/architect_sprint_intake.md`
- `.forge/workflows/architect_sprint_plan.md`

## Architectural Note

The TS handlers are **thin shims**, not reimplementations. Each handler:

1. Parses argv
2. Reads the generated `.forge/workflows/<name>.md` file from disk at runtime
3. Composes a kickoff message wrapping the workflow content
4. Calls `pi.sendUserMessage()` to inject it into the LLM conversation

This means parity has two layers:
- **Layer A:** Does the TS handler correctly reference the generated workflow file?
- **Layer B:** Does the generated workflow file faithfully reflect what the meta-workflow specifies?

---

## Layer A — TS Handler vs. Generated Workflow File

### sprint-intake.ts

| Axis | TS Handler | Expected (meta spec) | Status |
|------|-----------|---------------------|--------|
| Workflow file path | `.forge/workflows/architect_sprint_intake.md` | `.forge/workflows/architect_sprint_intake.md` | OK |
| Persona reference | None (deferred to workflow) | None at handler level (persona self-load is in generated workflow) | OK |
| Template paths | None at handler level | None at handler level | OK |
| Config fields read | None (uses hardcoded cwd-relative paths) | `project.prefix`, `paths.engineering` (in workflow, not handler) | OK — config fields are workflow concerns |
| Argv modes | `empty`, `@<file>`, `free-form text` | Not specified in meta (handler design) | OK |
| Error handling | `ctx.ui.notify()` with `"warning"` for missing workflow | Not specified in meta | OK |

**Kickoff preamble added by handler (not in meta spec):** The handler's `composeKickoff()` injects a `forge_store` MCP tool usage hint ("call `forge_store` MCP tool with `{command:'write', args:['sprint','<json>']}` — 2-positional, id INSIDE json") that is not prescribed by the meta-workflow. This is an intentional forge-cli augmentation for pi runtime context. **Not a drift issue.**

### sprint-plan.ts

| Axis | TS Handler | Expected (meta spec) | Status |
|------|-----------|---------------------|--------|
| Workflow file path | `.forge/workflows/architect_sprint_plan.md` | `.forge/workflows/architect_sprint_plan.md` | OK |
| Persona reference | None (deferred to workflow) | None at handler level | OK |
| Template paths | None at handler level | None at handler level | OK |
| Config fields read | None (uses hardcoded cwd-relative paths) | `project.prefix`, `paths.engineering` (in workflow, not handler) | OK |
| Argv modes | `<SPRINT_ID> [@<file> | text]` | Not specified in meta | OK |
| Requirements lookup | Tries `SPRINT_REQUIREMENTS.md`, then `REQUIREMENTS.md` | Meta specifies `SPRINT_REQUIREMENTS.md` | MINOR: handler adds `REQUIREMENTS.md` alias (generous, not conflicting) |
| Missing requirements | Emits warning notification, continues | Not specified in meta | OK |
| Error handling | `ctx.ui.notify()` with `"error"` for missing workflow | Not specified in meta | OK |

**Kickoff preamble added by handler:** Same pattern — injects `forge_store` MCP tool usage guidance and task-commit discipline ("commit tasks one at a time"). **Not a drift issue.**

---

## Layer B — Generated Workflow vs. Meta Spec

### architect_sprint_intake.md vs. meta-sprint-intake.md

| Axis | Generated File | Meta Spec Requirement | Status |
|------|---------------|----------------------|--------|
| Algorithm steps (0–5) | Present and faithful | Steps 0–5 as specified | OK |
| Persona self-load (first step reads `.forge/personas/product-manager.md`) | **ABSENT** | "The generated workflow MUST begin by reading `.forge/personas/product-manager.md` as its first step" | **GAP** |
| Token reporting mandate | **ABSENT** | "MUST mandate" `/cost` probe + sidecar write via `store-cli emit --sidecar` | **GAP** |
| Purpose section | **ABSENT** | Present in meta source | Minor (meta purpose is documentation, not executable) |
| SPRINT_REQUIREMENTS_TEMPLATE reference | In YAML frontmatter only | In frontmatter | OK |
| store-cli command in Finalize | Present: `update-status sprint ... status planning` | Matches | OK |
| "Do NOT emit a phase event yourself" note | Present | Present | OK |

### architect_sprint_plan.md vs. meta-sprint-plan.md

| Axis | Generated File | Meta Spec Requirement | Status |
|------|---------------|----------------------|--------|
| Algorithm steps (0–5) | Present and faithful | Steps 0–5 as specified | OK |
| Persona self-load (first step reads `.forge/personas/architect.md`) | **ABSENT** | "The generated workflow MUST begin by reading `.forge/personas/architect.md` as its first step" | **GAP** |
| Token reporting mandate | **ABSENT** | "MUST mandate" `/cost` probe + sidecar write | **GAP** |
| Iron Laws block (Anti-Pattern Guard) | **PRESENT** (verbatim) | Required verbatim after Purpose heading | OK |
| Store-Write Verification section | **PRESENT** (verbatim) | Required | OK |
| Purpose section | **ABSENT** | Present in meta source | Minor |
| nlp store queries in Load Context | Present | Present | OK |
| Task store writes with retry annotation | Present | Present | OK |
| Status transition to `active` | Present | Present | OK |
| "Do NOT emit a phase event yourself" note | Present | Present | OK |

---

## Summary

### Layer A (TS Handler): No Material Drift

Both `sprint-intake.ts` and `sprint-plan.ts` correctly reference the right generated workflow files and do not reimplement any workflow logic. The `REQUIREMENTS.md` alias in `sprint-plan.ts` is a minor additive extension (not conflicting). Persona/skill loading is correctly deferred to the LLM via workflow content. Config fields are workflow concerns, not handler concerns — no drift.

### Layer B (Generated Workflow): Two Gaps

The generated `.forge/workflows/` files are missing two sections the meta spec mandates:

| # | Gap | Affects | Severity |
|---|-----|---------|----------|
| 1 | Persona self-load step absent from both generated workflows | `architect_sprint_intake.md`, `architect_sprint_plan.md` | Medium — LLM may not load persona without explicit instruction |
| 2 | Token reporting mandate absent from both generated workflows | Both files | Medium — missing `/cost` probe and sidecar write instruction |

These gaps are **regeneration issues**, not TS handler drift. They indicate the last `/forge:regenerate` run did not include the Generation Instructions content from the meta files. Re-running `/forge:regenerate` (or manually applying the sections) would close both gaps.

### Disposition

Per FORGE-S23-T12 acceptance criteria:
- Audit document: this file (AC 1 met)
- Drift found in Layer B: filing as separate sub-task (per AC 2 — does not block sprint close)
- Layer A (TS handlers): parity verified at 2026-05-20

**Parity status: Partial — TS handlers verified; generated workflow regeneration gap filed separately.**
