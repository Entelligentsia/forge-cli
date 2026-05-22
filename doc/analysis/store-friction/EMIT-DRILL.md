# Emit-Failure Deep Drill — 66 failed emits

- Parsed payload: **61**
- Unparsed (rawCmd truncated / multiline / quoting): **5**

## Intended event 'type' values (agent's mental model of event class)

| `type` value | count |
|---|---:|
| `complete` | 2 |
| `task-validated` | 2 |
| `code-review-approved` | 1 |
| `collation` | 1 |
| `task_planned` | 1 |
| `task_implemented` | 1 |
| `task_approved` | 1 |
| `plan` | 1 |

## sprintId argument shape used in failed emits

| sprint arg | count |
|---|---:|
| `S01` | 61 |

## Required schema fields agents OMITTED (failed emits)

| field | omissions |
|---|---:|
| `provider` | 61 |
| `model` | 58 |
| `startTimestamp` | 58 |
| `durationMinutes` | 58 |
| `endTimestamp` | 58 |
| `role` | 55 |
| `action` | 54 |
| `sprintId` | 53 |
| `eventId` | 11 |

## 'phase' values agents passed

| phase | count |
|---|---:|
| `review-code` | 3 |
| `validate` | 2 |
| `plan` | 2 |
| `review-plan` | 1 |
| `implement` | 1 |

## 'action' values agents passed

| action | count |
|---|---:|
| `review-code-token-report` | 1 |
| `validated` | 1 |
| `token-report` | 1 |
| `implemented` | 1 |
| `collated` | 1 |
| `plan-task` | 1 |
| `review-code` | 1 |

## Per intended-type: fields agents WANTED to use

### type=`complete`

| field | times included |
|---|---:|
| `type` | 2 |
| `taskId` | 2 |
| `phase` | 2 |
| `verdict` | 2 |
| `eventId` | 2 |
| `timestamp` | 1 |
| `sprintId` | 1 |
| `role` | 1 |
| `action` | 1 |
| `iteration` | 1 |
| `startTimestamp` | 1 |
| `endTimestamp` | 1 |
| `durationMinutes` | 1 |
| `model` | 1 |
| `notes` | 1 |

### type=`task-validated`

| field | times included |
|---|---:|
| `type` | 2 |
| `task` | 2 |
| `verdict` | 2 |
| `timestamp` | 2 |

### type=`code-review-approved`

| field | times included |
|---|---:|
| `type` | 1 |
| `task` | 1 |
| `verdict` | 1 |
| `timestamp` | 1 |

### type=`collation`

| field | times included |
|---|---:|
| `type` | 1 |
| `taskId` | 1 |
| `persona` | 1 |
| `status` | 1 |
| `summary` | 1 |

### type=`task_planned`

| field | times included |
|---|---:|
| `type` | 1 |
| `taskId` | 1 |
| `timestamp` | 1 |
| `persona` | 1 |

## Sample parsed failed emits

- **engineer** type=`None` sprint=`S01`
  - provided: ['cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUSD', 'eventId', 'inputTokens', 'outputTokens', 'tokenSource']
  - missing: ['action', 'durationMinutes', 'endTimestamp', 'model', 'provider', 'role', 'sprintId', 'startTimestamp']
  - err: `tokenSource: value "missing" not in [reported, estimated] /  /  / Command exited with code 1`
- **supervisor** type=`complete` sprint=`S01`
  - provided: ['eventId', 'phase', 'taskId', 'timestamp', 'type', 'verdict']
  - missing: ['action', 'durationMinutes', 'endTimestamp', 'model', 'provider', 'role', 'sprintId', 'startTimestamp']
  - err: `sprintId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / type: value "complete" not in [friction] / timestamp: undeclared `
- **supervisor** type=`None` sprint=`S01`
  - provided: ['cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUSD', 'eventId', 'inputTokens', 'outputTokens', 'tokenSource']
  - missing: ['action', 'durationMinutes', 'endTimestamp', 'model', 'provider', 'role', 'sprintId', 'startTimestamp']
  - err: `tokenSource: value "missing" not in [reported, estimated] /  /  / Command exited with code 1`
- **supervisor** type=`None` sprint=`S01`
  - provided: ['cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUSD', 'eventId', 'inputTokens', 'outputTokens', 'tokenSource']
  - missing: ['action', 'durationMinutes', 'endTimestamp', 'model', 'provider', 'role', 'sprintId', 'startTimestamp']
  - err: `tokenSource: value "missing" not in [reported, estimated] /  /  / Command exited with code 1`
- **engineer** type=`None` sprint=`S01`
  - provided: ['cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUSD', 'eventId', 'inputTokens', 'outputTokens', 'tokenSource']
  - missing: ['action', 'durationMinutes', 'endTimestamp', 'model', 'provider', 'role', 'sprintId', 'startTimestamp']
  - err: `tokenSource: value "missing" not in [reported, estimated] /  /  / Command exited with code 1`
- **supervisor** type=`None` sprint=`S01`
  - provided: ['phase', 'sprintId', 'status', 'taskId', 'timestamp', 'verdict']
  - missing: ['action', 'durationMinutes', 'endTimestamp', 'eventId', 'model', 'provider', 'role', 'startTimestamp']
  - err: `eventId: missing required field / role: missing required field / action: missing required field / iteration: missing required field / status: undeclared field / timestamp: undeclared field /  /  / Com`
- **supervisor** type=`None` sprint=`S01`
  - provided: ['action', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUSD', 'eventId', 'inputTokens', 'iteration', 'outputTokens', 'phase', 'role', 'sprintId', 'taskId', 'tokenSource']
  - missing: ['durationMinutes', 'endTimestamp', 'model', 'provider', 'startTimestamp']
  - err: `tokenSource: value "missing" not in [reported, estimated] / taskId: undeclared field / sprintId: undeclared field / role: undeclared field / action: undeclared field / phase: undeclared field / iterat`
- **supervisor** type=`code-review-approved` sprint=`S01`
  - provided: ['task', 'timestamp', 'type', 'verdict']
  - missing: ['action', 'durationMinutes', 'endTimestamp', 'eventId', 'model', 'provider', 'role', 'sprintId', 'startTimestamp']
  - err: `eventId: missing required field / taskId: missing required field / sprintId: missing required field / role: missing required field / action: missing required field / phase: missing required field / it`

## Sample unparsed (parser limitation, JSON in cmd may span lines)

- forge-subagent-2026-05-13T03-31-29-828Z__engineer__HLO-S01-T01__implement.json: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit S01 '{"type":"task_completed","taskId"`
- forge-subagent-2026-05-13T03-58-23-415Z__supervisor__HLO-S01-T01__review-code.json: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && TIMEST AMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && node "$FORGE_ROOT/tools/s`
- forge-subagent-2026-05-13T04-34-10-803Z__engineer__HLO-S01-T01__commit.json: `FORGE_ROOT="/home/boni/src/forge-engineering/forge-cli/dist/forge-payload" && node "$FORGE_ROOT/tools/store-cli.cjs" emit --help`
- forge-subagent-2026-05-13T17-43-36-953Z__engineer__S01-T03__plan.json: `FORGE_ROOT=$(node -e "console.log(require('./.forge/config.json').paths.forgeRoot)") && NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ") && node "$FORGE_ROOT/tools/store-cl`
- forge-subagent-2026-05-14T02-22-56-952Z__engineer__HLO-S01-T04__plan.json: `FORGE_ROOT="/home/boni/.nvm/versions/node/v24.3.0/lib/node_modules/@entelligentsia/forgecli/dist/forge-payload" && SIDECAR_JSON=$(cat <<'EOF'
{
  "eventId": "20`
