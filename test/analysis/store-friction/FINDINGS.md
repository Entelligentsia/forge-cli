# Store-Op Friction Analysis — 927 ops across 109 transcripts

Failure rate: **202/927 = 21.8%**

## Channels

| Channel | Ops | Errors | Err% |
|---|---:|---:|---:|
| `bash-store-cli` | 894 | 201 | 22.5% |
| `bash-collate` | 24 | 1 | 4.2% |
| `bash-manage-config` | 9 | 0 | 0.0% |

## Top subcommand failure rates (min 5 ops)

| Channel::Subcommand | Ops | Errors | Err% |
|---|---:|---:|---:|
| `bash-store-cli::get` | 39 | 35 | 89.7% |
| `bash-store-cli::emit` | 168 | 66 | 39.3% |
| `bash-store-cli::update-status` | 170 | 59 | 34.7% |
| `bash-store-cli::list` | 26 | 8 | 30.8% |
| `bash-store-cli::set-bug-summary` | 37 | 10 | 27.0% |
| `bash-store-cli::write` | 9 | 1 | 11.1% |
| `bash-store-cli::set-summary` | 69 | 7 | 10.1% |
| `bash-store-cli::describe` | 69 | 4 | 5.8% |
| `bash-collate::?` | 24 | 1 | 4.2% |
| `bash-store-cli::nlp` | 28 | 1 | 3.6% |
| `bash-store-cli::read` | 187 | 3 | 1.6% |
| `bash-store-cli::--help` | 62 | 0 | 0.0% |
| `bash-manage-config::?` | 9 | 0 | 0.0% |
| `bash-store-cli::2>/dev/null` | 8 | 0 | 0.0% |
| `bash-store-cli::|` | 7 | 0 | 0.0% |

## Top normalized error keys

| Key | Count |
|---|---:|
| `other` | 75 |
| `unknown_subcommand:get` | 39 |
| `missing_required_field:role` | 16 |
| `missing_required_field:iteration` | 16 |
| `missing_required_field:action` | 15 |
| `missing_required_field:sprintId` | 14 |
| `missing_required_field:eventId` | 13 |
| `missing_required_field:phase` | 12 |
| `missing_required_field:type` | 11 |
| `entity_or_path_not_found` | 11 |
| `unknown_entity:type` | 8 |
| `illegal_transition:task:plan-approved->implemented` | 7 |
| `illegal_transition:bug:verified->fixed` | 6 |
| `missing_required_field:taskId` | 5 |
| `missing_required_field:Command` | 4 |
| `illegal_transition:task:plan-revision-required->planned` | 4 |
| `missing_required_field:objective` | 4 |
| `illegal_transition:task:plan-approved->planned` | 3 |
| `illegal_transition:task:code-revision-required->implemented` | 3 |
| `illegal_transition:task:code-revision-required->implementing` | 3 |
| `illegal_transition:task:code-revision-required->review-approved` | 3 |
| `missing_required_field:written_at` | 3 |
| `illegal_transition:task:planned->review-approved` | 2 |
| `illegal_transition:task:plan-revision-required->draft` | 2 |
| `illegal_transition:task:plan-revision-required->plan-approved` | 2 |
| `unknown_subcommand:describe` | 2 |
| `illegal_transition:bug:verified->approved` | 2 |
| `illegal_transition:task:review-approved->implemented` | 1 |
| `illegal_transition:task:review-approved->implementing` | 1 |
| `missing_required_field:status` | 1 |

## Pre-flight pattern per transcript

| Pattern | Transcripts |
|---|---:|
| `no_write_in_transcript` | 50 |
| `preflight_template_or_describe` | 36 |
| `write_without_tpl_or_describe` | 13 |
| `reactive_template_or_describe_after_failure` | 10 |

## Retry behavior

- Retry events (same subcmd succeeded after earlier failure within ≤10 calls): **115**
- Distance min/median/max calls: 0/2/71

### Retries by error key

| errKey | retries succeeded |
|---|---:|
| `other` | 62 |
| `missing_required_field:role` | 16 |
| `missing_required_field:iteration` | 16 |
| `missing_required_field:action` | 15 |
| `missing_required_field:sprintId` | 14 |
| `missing_required_field:eventId` | 13 |
| `missing_required_field:phase` | 12 |
| `missing_required_field:type` | 11 |
| `entity_or_path_not_found` | 7 |
| `illegal_transition:task:plan-approved->implemented` | 7 |
| `missing_required_field:taskId` | 5 |
| `missing_required_field:Command` | 4 |
| `missing_required_field:objective` | 4 |
| `missing_required_field:written_at` | 3 |
| `illegal_transition:task:planned->review-approved` | 2 |

## Shape anti-patterns

- **3-arg write** (`write <entity> <id> <json>` — known-bad shape): **0** occurrences
- **emit with non-ID first positional** (synthetic/bare-string sprintId): **168** occurrences

## Persona breakdown

| Persona | Ops | Errors | Err% |
|---|---:|---:|---:|
| `engineer` | 363 | 77 | 21.2% |
| `supervisor` | 234 | 56 | 23.9% |
| `bug-fixer` | 125 | 17 | 13.6% |
| `architect` | 92 | 24 | 26.1% |
| `qa-engineer` | 60 | 13 | 21.7% |
| `collator` | 53 | 15 | 28.3% |

## Model breakdown

| Model | Ops | Errors | Err% |
|---|---:|---:|---:|
| `glm-5.1:cloud` | 862 | 188 | 21.8% |
| `claude-haiku-4-5` | 38 | 6 | 15.8% |
| `gemma4:31b-cloud` | 27 | 8 | 29.6% |

## Error samples (top keys)

### `other`

- **engineer** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR', 'STR']
  - cmd: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{
  "eventId": "20260513T025850Z_HLO-S01-T01_plan_plan-task",
  "inputTok`
  - err: `tokenSource: value "missing" not in [reported, estimated] /  /  / Command exited with code 1`
- **supervisor** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'ID', 'STR', 'STR']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{
  "eventId": "HLO-S01-T01-review-plan-001",
  "inputTokens": `
  - err: `tokenSource: value "missing" not in [reported, estimated] /  /  / Command exited with code 1`

### `unknown_subcommand:get`

- **engineer** / bash-store-cli::get-task / argShape=['ID']
  - cmd: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" get-task HLO-S01-T01`
  - err: `Unknown command: get-task / Run with --help for usage information. /  /  / Command exited with code 1`
- **supervisor** / bash-store-cli::get-summary / argShape=['ID', 'STR']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" get-summary HLO-S01-T01 review_plan`
  - err: `Unknown command: get-summary / Run with --help for usage information. /  /  / Command exited with code 1`

### `missing_required_field:role`

- **supervisor** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR', 'ID']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "`
  - err: `sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "complete" not in [friction] / timestamp: undeclared `
- **engineer** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR']
  - cmd: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","pha`
  - err: `eventId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "task_completed" no`

### `missing_required_field:iteration`

- **supervisor** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR', 'ID']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "`
  - err: `sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "complete" not in [friction] / timestamp: undeclared `
- **engineer** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR']
  - cmd: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","pha`
  - err: `eventId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "task_completed" no`

### `missing_required_field:action`

- **supervisor** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR', 'ID']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "`
  - err: `sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "complete" not in [friction] / timestamp: undeclared `
- **engineer** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR']
  - cmd: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","pha`
  - err: `eventId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "task_completed" no`

### `missing_required_field:sprintId`

- **supervisor** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR', 'ID']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "`
  - err: `sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "complete" not in [friction] / timestamp: undeclared `
- **engineer** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR']
  - cmd: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","pha`
  - err: `eventId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "task_completed" no`

### `missing_required_field:eventId`

- **engineer** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR', 'STR']
  - cmd: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","pha`
  - err: `eventId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "task_completed" no`
- **supervisor** / bash-store-cli::emit / argShape=['STR', 'JSON', 'STR', 'STR']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"taskId":"HLO-S01-T01","sprintId":"S01","phase":"review-code",`
  - err: `eventId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / status: undeclared field / timestamp: undeclared field /  /  / Com`

### `missing_required_field:phase`

- **supervisor** / bash-store-cli::emit / argShape=['STR', 'JSON']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"code-review-approved","task":"HLO-S01-T01","verdict":"`
  - err: `eventId: missing required field / taskId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / phase: missing required field / it`
- **qa-engineer** / bash-store-cli::emit / argShape=['STR', 'JSON']
  - cmd: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"task-validated","task":"HLO-S01-T01","verdict":"approv`
  - err: `eventId: missing required field / taskId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / phase: missing required field / it`
