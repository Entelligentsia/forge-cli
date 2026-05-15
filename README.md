## @entelligentsia/forgecli

Forge SDLC on the [pi-coding-agent](https://www.npmjs.com/package/@entelligentsia/pi-coding-agent) runtime. Three bin aliases: `forge`, `forgecli`, `4ge`.

Bundled Forge plugin: **v0.43.16**.
Bundled pi runtime: pinned in `package.json`.

## Install

```sh
npm install -g @entelligentsia/forgecli
```

Requires Node 20+.

## Quick start

```sh
cd your-project
forge                # launch interactive session (forge | forgecli | 4ge)
> /forge:init        # bootstrap Forge SDLC — 4 phases, ~45s
```

`/forge:init` is idempotent and resumable via `.forge/init-progress.json`. Re-running picks up where the previous run stopped.

## What `/forge:init` does

1. **Collect** — 5 parallel discovery scans → `.forge/config.json`
2. **Discover** — KB doc generation + `.forge/project-context.json`
3. **Materialize** — substitute placeholders → fully functional workflows
4. **Register** — versioning, manifest, cache, store entries

Outputs land in `.forge/{personas,skills,workflows,templates,config.json,project-context.json}` and the configured KB folder (default `engineering/`).

## CLI flags

```
forge --version              Print version triplet (forgecli, forge, pi)
forge --help                 Show forge + pi help
forge --no-update-check      Skip update check
forge --non-interactive      Bypass all Y/N gates with defaults (CI/scripted use)
forge --registry <path>      Override model registry
```

Pi flags (`-p`, `--cwd`, `--session`, `--model`, `--tools`, `--thinking`, …) are forwarded verbatim. Run `forge --help` for the full list.

## Non-interactive mode

For CI, scripts, or any context where the model cannot answer Y/N prompts:

```sh
# Using the flag
forge --non-interactive

# Using the environment variable
FORGE_YES=1 forge
```

Both activate the same bypass. When active, every Y/N gate in `/forge:init` resolves to its documented default:

| Gate | Default resolution |
|------|--------------------|
| Resume previous init? | No — delete checkpoint, start fresh |
| Pre-flight phase selector (Phase 1–4 prompt) | Skip prompt — proceed from Phase 1 |
| Knowledge base folder name | Use default `engineering/` |
| Create CLAUDE.md? | Yes — create with KB links |

## Hook safety net

forge-cli intercepts `store-cli write` and `store-cli update-status` bash calls and validates them before they reach the store. This prevents malformed payloads and illegal status transitions from corrupting the project's engineering knowledge base.

### Default-on enforcement

When enforcement is active (default), the hook dispatcher:

1. **Schema validation** — every `store-cli write <entity> '<json>'` invocation is validated against the entity schema. If the payload is invalid, the model receives a structured error via `{ block: true, reason: <error> }` and is expected to self-correct on the next attempt.

2. **Transition guard** — every `store-cli update-status <entity> <id> status <value>` invocation is checked against the legal transition table for the entity. Illegal transitions (e.g. `draft → committed`, skipping required intermediate states) are blocked with an explanatory message naming both `from` and `to` states and the legal next states.

Both checks are enforced by default. The hooks fire synchronously before the tool executes, so the model sees the error as the tool result and retries with a corrected payload.

### `--force` scope

When `--force` is present in the `store-cli` argv:

- **Transition guard** is bypassed — `--force` is an explicit operator override for status transitions.
- **Schema validation still runs** — a malformed payload is always invalid regardless of intent.

### `FORGE_HOOK_AUDIT=1` — audit-only mode

Set `FORGE_HOOK_AUDIT=1` to observe hook decisions without taking action. In audit mode:

- Every decision (would-block, would-allow, lookup-failed) is logged to `.forge/logs/hooks.log`.
- Nothing is blocked — all calls proceed regardless of validation outcome.
- Useful for calibrating the false-positive rate before enabling enforcement in a new project.

Log format (one entry per line):

```
[store-cli-intercept] subcmd=write entity=task payload={"taskId":"..."}
[store-cli-intercept] decision=would-block reason=missing required field: taskId
[store-cli-intercept] decision=would-allow
[store-cli-intercept] decision=lookup-failed entity=task entityId=FORGE-S18-T03
```

### Interpreting block messages

When the model emits a malformed `store-cli` call and the hook blocks it, the tool result will contain:

```
block: true
reason: <error text>
```

The model should read the `reason` field and self-correct the payload or transition before retrying. Common block reasons:

| Reason pattern | Cause | Fix |
|---|---|---|
| `missing required field: <field>` | Schema validation — required field absent | Add the missing field to the payload |
| `<from> → <to> is not a legal transition...` | Transition guard — illegal status jump | Use the listed legal next states |
| `store-cli validate exited with code 1` | Schema validation — malformed JSON or unknown entity | Fix the JSON payload |

## Custom tools

### `forge:ask_user` — interactive prompt

The `forge_ask_user` custom tool allows Forge workflows to request user input
during model execution. It presents the appropriate TUI prompt and blocks the
model loop until the user responds.

**Schema:**

```typescript
{
  question: string;         // The prompt shown to the user
  type: "confirm"           // Y/N boolean confirmation
       | "choice"           // Select from a list
       | "text";            // Free-form single-line input
  options?: string[];       // Required when type === "choice"
  default?: string;         // Returned in non-interactive mode
}
```

**Returns:** A string — `"Y"` or `"N"` for `confirm`, the selected option for
`choice`, or the entered text for `text`. On cancellation (user dismisses the
dialog), the tool returns `isError: true` with a structured message.

**Examples:**

```
// Confirm
forge_ask_user({ question: "Overwrite existing files?", type: "confirm" })
// → "Y" or "N"

// Choice
forge_ask_user({
  question: "Select environment:",
  type: "choice",
  options: ["development", "staging", "production"]
})
// → "development" | "staging" | "production"

// Text
forge_ask_user({ question: "Enter project name:", type: "text", default: "myproject" })
// → user-entered string (or "myproject" in non-interactive mode)
```

**Non-interactive behaviour:** When `FORGE_YES=1`, `--non-interactive` is set,
or pi is running in headless/RPC mode, the tool returns the `default` immediately
without rendering any TUI. Fallback defaults when no explicit `default` is
provided: `confirm` → `"Y"`, `choice` → `options[0]`, `text` → `""`.

## Publishing

After every `npm publish`, run the post-publish verifier to confirm the registry reflects the new version and `dist-tags.latest` is updated:

```sh
node scripts/verify-publish.cjs --version <VERSION>
```

Options:

```
--version <VERSION>   Required. The version just published.
--package <PKG>       Package name (default: reads from package.json).
--allow-non-latest    Warn instead of fail when dist-tags.latest != VERSION.
--root <path>         Root directory for package.json lookup (default: cwd).
```

The script runs two checks:
1. `npm view <PKG>@<VERSION> version` — asserts the trimmed output matches `<VERSION>`.
2. `npm view <PKG> dist-tags --json` — asserts `latest === <VERSION>` (hard fail unless `--allow-non-latest`).

On any npm error or version mismatch the script logs a `[warn] registry check failed` message and exits 1.

## Roadmap

| Command                                    | Status              |
|--------------------------------------------|---------------------|
| `/forge:enhance` (Phase 2)                 | Shipped (0.6.6)     |
| `/forge:plan`                              | Shipped (0.5.0)     |
| `/forge:implement`                         | Shipped (0.5.0)     |
| FS-level two-layer boundary guard          | Shipped (0.5.0)     |
| Bundled-tools layout regression coverage   | Shipped (0.5.0)     |
| `/forge:sprint-intake`                     | Shipped (0.4.0)     |
| `/forge:sprint-plan`                       | Shipped (0.4.0)     |
| Pi-runtime token telemetry (`usage-hook`)  | Shipped (0.4.0)     |
| forge-packager README↔CHANGELOG verifier   | Shipped (0.4.0)     |
| forge-releaser post-publish npm-view check | Shipped (0.4.0)     |
| `/forge:init`                              | Shipped (0.3.0)     |
| Other `/forge:*` commands                  | Roadmap             |

Track via [issues](https://github.com/Entelligentsia/forge-cli/issues).

## Release history

| Version | Headline |
|---------|----------|
| 0.6.6   | Sprint finalization ceremony — `dispatchSprintCeremony` + `sprint-complete`/`sprint-halted` event variants. Pairs with forge-plugin 0.43.16 |
| 0.6.5   | Telemetry contract Slice 2 — runtime emit site. Pairs with forge-plugin 0.43.14 |
| 0.6.4   | Fixes: orchestrator runtime-attribution and event-emission regressions |
| 0.6.3   | Thread-switcher UX — single-viewport subagent tail browsing |
| 0.6.2   | Bundled forge plugin bumped to v0.43.12 — fixes silent fragment drop |
| 0.6.1   | HLO-S01 friction-fix sweep — bundled forge plugin bumped to v0.43.11 |
| 0.5.7   | `/forge:sprint-plan` completion-gap fix (paired with forge plugin v0.43.3) |
| 0.5.6   | Pack-06 materialization-marker regression fix (paired with forge plugin v0.43.2) |
| 0.5.5   | Hot-fix: lands the `/forge:init` per-phase verify+retry+recover implementation that 0.5.4 shipped without |
| 0.5.4   | `/forge:init` per-phase verify + retry + recover |
| 0.5.3   | UX: KB-folder confirm question rephrased so default-Yes is the safe path |
| 0.5.2   | Hot-patch: `forge_ask_user` UI rendering — text/choice prompts now show the question |
| 0.5.1   | Hot-patch: direct-exec contract for forge tools. Pairs with forge-plugin v0.43.1 |
| 0.5.0   | Foundation finish — central loaders + 3 native kickoff handlers + FS-level boundary guard |
| 0.4.0   | Native sprint-intake + sprint-plan handlers — SDLC entry path self-hosted |
| 0.3.0   | Pi-runtime parity adapters — `forge:ask_user` TUI tool + hook safety net |
| 0.2.1   | Non-interactive mode — `--non-interactive` flag and `FORGE_YES=1` env var |
| 0.2.0   | `/forge:init` real implementation — full 4-phase port with payload trim |
| 0.1.0   | First stable release — three bin aliases, bundled pi runtime, 5 slash commands |

## Links

- Source: <https://github.com/Entelligentsia/forge-cli>
- Issues: <https://github.com/Entelligentsia/forge-cli/issues>
- Forge plugin (Claude Code): <https://github.com/Entelligentsia/forge>
- Changelog: [CHANGELOG.md](./CHANGELOG.md)

## License

MIT — see [LICENSE](./LICENSE).
