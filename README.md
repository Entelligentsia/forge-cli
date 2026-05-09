## @entelligentsia/forgecli

Forge SDLC on the [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) runtime. Three bin aliases: `forge`, `forgecli`, `4ge`.

Bundled Forge plugin: **v0.40.3**.
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

## Roadmap

| Command                   | Status              |
|---------------------------|---------------------|
| `/forge:init`             | Shipped (0.2.0)     |
| Other `/forge:*` commands | Roadmap             |

Track via [issues](https://github.com/Entelligentsia/forge-cli/issues).

## Links

- Source: <https://github.com/Entelligentsia/forge-cli>
- Issues: <https://github.com/Entelligentsia/forge-cli/issues>
- Forge plugin (Claude Code): <https://github.com/Entelligentsia/forge>
- Changelog: [CHANGELOG.md](./CHANGELOG.md)

## License

MIT — see [LICENSE](./LICENSE).
