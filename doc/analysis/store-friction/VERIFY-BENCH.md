# Mode A v2 Verify-Bench — stateful replay against CURRENT store-cli

- Transcripts replayed: **107**
- Store-cli ops attempted: **894**
- Successfully replayed: **837**
- Unparseable args (skipped): **31**
- Ops where baseline used --force (env mirrored): **12**

## Outcome matrix

| Baseline → Current | Count | % |
|---|---:|---:|
| ✅✅ pass → pass | 508 | 60.7% |
| ✅❌ pass → fail (REGRESSION) | 133 | 15.9% |
| ❌✅ fail → pass (IMPROVEMENT) | 22 | 2.6% |
| ❌❌ fail → fail (still broken) | 174 | 20.8% |

## Aggregate error rate

- Baseline: **196/837 = 23.4%**
- Current: **307/837 = 36.7%**
- Delta: **-13.3pp**
- Improved: **22/196 = 11.2%** of baseline errors

## Still-broken patterns (after fixes shipped to date)

### `unknown_subcommand:get` (~39 baseline errors)
- `get-task` tail: `get-task HLO-S01-T01`
  - now_err: `Unknown command: get-task
Run with --help for usage information.
`
- `get-summary` tail: `get-summary HLO-S01-T01 review_plan`
  - now_err: `Unknown command: get-summary
Run with --help for usage information.
`

### `other` (~75 baseline errors)
- `emit` tail: `emit S01 '{
  "eventId": "20260513T025850Z_HLO-S01-T01_plan_plan-task",
  "inputTokens": null,
  "outputTokens": null,
  "cacheReadTokens": null,
  "cacheWriteTokens": null,
  "estimatedCostUSD": null`
  - now_err: `tokenSource: value "missing" not in [reported, estimated]
estimatedCostUSD: undeclared field
`
- `emit` tail: `emit S01 '{
  "eventId": "HLO-S01-T01-review-plan-001",
  "inputTokens": null,
  "outputTokens": null,
  "cacheReadTokens": null,
  "cacheWriteTokens": null,
  "estimatedCostUSD": null,
  "tokenSource`
  - now_err: `tokenSource: value "missing" not in [reported, estimated]
estimatedCostUSD: undeclared field
`

### `missing_required_field:sprintId` (~14 baseline errors)
- `emit` tail: `emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "review-plan",
  "verdict": "approved",
  "timestamp": "2026-05-13T08:30:00Z",
  "eventId": "HLO-S01-T01-review-plan-complete"
}`
  - now_err: `sprintId: missing required field
role: missing required field
action: missing required field
type: value "complete" not in [friction, task-planned, plan-complete, plan-approved, task-implemented, revi`
- `emit` tail: `emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","phase":"implement","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' 2>&1`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "task_completed" not in [friction, task-planned, plan-complete,`

### `missing_required_field:role` (~16 baseline errors)
- `emit` tail: `emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "review-plan",
  "verdict": "approved",
  "timestamp": "2026-05-13T08:30:00Z",
  "eventId": "HLO-S01-T01-review-plan-complete"
}`
  - now_err: `sprintId: missing required field
role: missing required field
action: missing required field
type: value "complete" not in [friction, task-planned, plan-complete, plan-approved, task-implemented, revi`
- `emit` tail: `emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","phase":"implement","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' 2>&1`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "task_completed" not in [friction, task-planned, plan-complete,`

### `missing_required_field:action` (~15 baseline errors)
- `emit` tail: `emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "review-plan",
  "verdict": "approved",
  "timestamp": "2026-05-13T08:30:00Z",
  "eventId": "HLO-S01-T01-review-plan-complete"
}`
  - now_err: `sprintId: missing required field
role: missing required field
action: missing required field
type: value "complete" not in [friction, task-planned, plan-complete, plan-approved, task-implemented, revi`
- `emit` tail: `emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","phase":"implement","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' 2>&1`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "task_completed" not in [friction, task-planned, plan-complete,`

### `missing_required_field:iteration` (~16 baseline errors)
- `emit` tail: `emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "review-plan",
  "verdict": "approved",
  "timestamp": "2026-05-13T08:30:00Z",
  "eventId": "HLO-S01-T01-review-plan-complete"
}`
  - now_err: `sprintId: missing required field
role: missing required field
action: missing required field
type: value "complete" not in [friction, task-planned, plan-complete, plan-approved, task-implemented, revi`
- `emit` tail: `emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","phase":"implement","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' 2>&1`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "task_completed" not in [friction, task-planned, plan-complete,`

### `missing_required_field:type` (~11 baseline errors)
- `emit` tail: `emit S01 '{
  "type": "complete",
  "taskId": "HLO-S01-T01",
  "phase": "review-plan",
  "verdict": "approved",
  "timestamp": "2026-05-13T08:30:00Z",
  "eventId": "HLO-S01-T01-review-plan-complete"
}`
  - now_err: `sprintId: missing required field
role: missing required field
action: missing required field
type: value "complete" not in [friction, task-planned, plan-complete, plan-approved, task-implemented, revi`
- `emit` tail: `emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","phase":"implement","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' 2>&1`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "task_completed" not in [friction, task-planned, plan-complete,`

### `missing_required_field:eventId` (~13 baseline errors)
- `emit` tail: `emit S01 '{"type":"task_completed","taskId":"HLO-S01-T01","persona":"engineer","phase":"implement","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' 2>&1`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "task_completed" not in [friction, task-planned, plan-complete,`
- `emit` tail: `emit S01 '{"taskId":"HLO-S01-T01","sprintId":"S01","phase":"review-code","status":"review-approved","verdict":"approved","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'`
  - now_err: `eventId: missing required field
role: missing required field
action: missing required field
status: undeclared field
timestamp: undeclared field
`

### `missing_required_field:taskId` (~5 baseline errors)
- `emit` tail: `emit S01 '{"type":"code-review-approved","task":"HLO-S01-T01","verdict":"approved","timestamp":"2026-05-13T09:35:00Z"}'`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "code-review-approved" not in [friction, task-planned, plan-com`
- `emit` tail: `emit S01 '{"type":"task-validated","task":"HLO-S01-T01","verdict":"approved","timestamp":"2026-05-13T03:59:12Z"}'`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
task: undeclared field
timestamp: undeclared field
`

### `missing_required_field:phase` (~12 baseline errors)
- `emit` tail: `emit S01 '{"type":"code-review-approved","task":"HLO-S01-T01","verdict":"approved","timestamp":"2026-05-13T09:35:00Z"}'`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
type: value "code-review-approved" not in [friction, task-planned, plan-com`
- `emit` tail: `emit S01 '{"type":"task-validated","task":"HLO-S01-T01","verdict":"approved","timestamp":"2026-05-13T03:59:12Z"}'`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
task: undeclared field
timestamp: undeclared field
`

### `entity_or_path_not_found` (~11 baseline errors)
- `emit` tail: `emit S01 "{\"eventId\":\"20260513T035700Z_FORGE-S01-T01_code-review_complete\",\"taskId\":\"HLO-S01-T01\",\"sprintId\":\"S01\",\"role\":\"supervisor\",\"action\":\"code-review-complete\",\"phase\":\"r`
  - now_err: `endTimestamp: missing required field
endTimestamp: value "" is not a valid date-time
`
- `read` tail: `read task S01-T03`
  - now_err: `Entity not found: task S01-T03
`

### `illegal_transition:task:plan-approved->implemented` (~7 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T02 status implemented`
  - now_err: `Illegal transition: task HLO-S01-T02 status: draft → implemented
`
- `update-status` tail: `update-status task HLO-S01-T03 status implemented`
  - now_err: `Illegal transition: task HLO-S01-T03 status: draft → implemented
`

### `unknown_entity:type` (~8 baseline errors)
- `list` tail: `list S01`
  - now_err: `Unknown entity type: S01
`
- `list` tail: `list events`
  - now_err: `Unknown entity type: events
`

### `illegal_transition:task:code-revision-required->implemented` (~3 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T05 status implemented`
  - now_err: `Illegal transition: task HLO-S01-T05 status: draft → implemented
`
- `update-status` tail: `update-status task HLO-S01-T05 status implemented`
  - now_err: `Illegal transition: task HLO-S01-T05 status: draft → implemented
`

### `illegal_transition:task:code-revision-required->implementing` (~3 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T05 status implementing`
  - now_err: `Illegal transition: task HLO-S01-T05 status: draft → implementing
`
- `update-status` tail: `update-status task HLO-S01-T05 status implementing`
  - now_err: `Illegal transition: task HLO-S01-T05 status: draft → implementing
`

### `illegal_transition:task:code-revision-required->review-approved` (~3 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T05 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T05 status: draft → review-approved
`
- `update-status` tail: `update-status task HLO-S01-T05 status review-approved --dry-run`
  - now_err: `Illegal transition: task HLO-S01-T05 status: draft → review-approved
`

### `illegal_transition:bug:verified->fixed` (~6 baseline errors)
- `update-status` tail: `update-status bug PENDING-1778832175720 status fixed`
  - now_err: `Illegal transition: bug PENDING-1778832175720 status: verified → fixed
`
- `update-status` tail: `update-status bug FORGE-BUG-001 status fixed`
  - now_err: `Illegal transition: bug FORGE-BUG-001 status: verified → fixed
`

### `illegal_transition:task:planned->review-approved` (~2 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T01 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → review-approved
`
- `update-status` tail: `update-status task HLO-S01-T02 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T02 status: draft → review-approved
`

### `illegal_transition:task:plan-approved->planned` (~3 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T03 status planned`
  - now_err: `Entity not found: task HLO-S01-T03
`
- `update-status` tail: `update-status task HLO-S01-T03 status planned`
  - now_err: `Entity not found: task HLO-S01-T03
`

### `illegal_transition:task:plan-revision-required->draft` (~2 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T03 status draft`
  - now_err: `Illegal transition: task HLO-S01-T03 status: planned → draft
`
- `update-status` tail: `update-status task HLO-S01-T04 status draft`
  - now_err: `Illegal transition: task HLO-S01-T04 status: planned → draft
`

### `illegal_transition:bug:verified->approved` (~2 baseline errors)
- `update-status` tail: `update-status bug FORGE-BUG-001 status approved`
  - now_err: `Illegal transition: bug FORGE-BUG-001 status: reported → approved
`
- `update-status` tail: `update-status bug FORGE-BUG-001 status approved`
  - now_err: `Illegal transition: bug FORGE-BUG-001 status: reported → approved
`

### `illegal_transition:task:review-approved->implemented` (~1 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T01 status implemented 2>&1`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → implemented
`

### `illegal_transition:task:review-approved->implementing` (~1 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T01 status implementing 2>&1`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → implementing
`

### `missing_required_field:status` (~1 baseline errors)
- `emit` tail: `emit S01 '{"taskId":"HLO-S01-T01","sprintId":"S01","phase":"review-code","status":"review-approved","verdict":"approved","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'`
  - now_err: `eventId: missing required field
role: missing required field
action: missing required field
status: undeclared field
timestamp: undeclared field
`

### `missing_required_field:event` (~1 baseline errors)
- `emit` tail: `emit S01 '{"event":"task.approved","taskId":"HLO-S01-T01","timestamp":"2026-05-13T02:45:00Z"}'`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
event: undeclared field
timestamp: undeclared field
`

### `missing_required_field:eventType` (~1 baseline errors)
- `emit` tail: `emit S01 '{"eventId":"HLO-S01-T01-commit-001","eventType":"commit","taskId":"HLO-S01-T01","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","summary":"Task HLO-S01-T01 committed: added --shout regression`
  - now_err: `sprintId: missing required field
role: missing required field
action: missing required field
eventType: undeclared field
timestamp: undeclared field
summary: undeclared field
`

### `illegal_transition:task:plan-approved->review-approved` (~1 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T02 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T02 status: plan-approved → review-approved
`

### `illegal_transition:task:plan-approved->in-progress` (~1 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T02 status in-progress`
  - now_err: `Illegal transition: task HLO-S01-T02 status: draft → in-progress
`

### `missing_required_field:Command` (~4 baseline errors)
- `emit` tail: `emit S01 '{"eventId":"HLO-S01-T02-impl","role":"engineer","action":"implemented","phase":"implement","iteration":1,"taskId":"HLO-S01-T02"}'`
  - now_err: `sprintId: missing required field
`

### `missing_required_field:task` (~1 baseline errors)
- `emit` tail: `emit S01 '{"task":"HLO-S01-T02","action":"collated","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"}'`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
task: undeclared field
timestamp: undeclared field
`

### `missing_required_field:taskCompleted` (~1 baseline errors)
- `emit` tail: `emit S01 '{"taskCompleted":"HLO-S01-T02","status":"committed","timestamp":"2026-05-13T05:15:00Z"}'`
  - now_err: `eventId: missing required field
sprintId: missing required field
role: missing required field
action: missing required field
taskCompleted: undeclared field
status: undeclared field
timestamp: undecla`

### `illegal_transition:task:plan-revision-required->plan-approved` (~2 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T03 status plan-approved`
  - now_err: `Illegal transition: task HLO-S01-T03 status: draft → plan-approved
`

### `illegal_transition:task:code-revision-required->plan-approved` (~1 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T05 status plan-approved`
  - now_err: `Illegal transition: task HLO-S01-T05 status: draft → plan-approved
`

### `illegal_transition:task:approved->completed` (~1 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T06 status completed`
  - now_err: `Illegal transition: task HLO-S01-T06 status: draft → completed
`

### `illegal_transition:task:approved->in_progress` (~1 baseline errors)
- `update-status` tail: `update-status task HLO-S01-T06 status in_progress`
  - now_err: `Illegal transition: task HLO-S01-T06 status: draft → in_progress
`

### `illegal_transition:sprint:planning->completed` (~1 baseline errors)
- `update-status` tail: `update-status sprint S02 status completed 2>&1`
  - now_err: `Entity not found: sprint S02
`

### `illegal_transition:bug:fixed->verified` (~1 baseline errors)
- `update-status` tail: `update-status bug PENDING-1778832410317 status verified 2>&1`
  - now_err: `Illegal transition: bug PENDING-1778832410317 status: fixed → verified
`

### `illegal_transition:bug:verified->review-approved` (~1 baseline errors)
- `update-status` tail: `update-status bug FORGE-BUG-001 status review-approved 2>&1`
  - now_err: `Illegal transition: bug FORGE-BUG-001 status: reported → review-approved
`

### `illegal_transition:bug:fixed->plan-approved` (~1 baseline errors)
- `update-status` tail: `update-status bug FORGE-BUG-002 status plan-approved`
  - now_err: `Illegal transition: bug FORGE-BUG-002 status: reported → plan-approved
`

## ⚠️ Regressions (25 sampled)

- `read` tail: `read feature HLO-S01-T01 --json`
  - now_err: `Entity not found: feature HLO-S01-T01
`
- `emit` tail: `emit S01 '{
  "eventId": "20260513T025850Z_HLO-S01-T01_plan_plan-task",
  "inputTokens": null,
  "outputTokens": null,
  "cacheReadTokens": null,
  "cacheWriteTokens": null,
  "estimatedCostUSD": null,
  "tokenSource": "estimated"
}' --sidecar`
  - now_err: `estimatedCostUSD: undeclared field
`
- `emit` tail: `emit S01 '{
  "eventId": "HLO-S01-T01-review-plan-001",
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "estimatedCostUSD": 0,
  "tokenSource": "estimated"
}' --sidecar`
  - now_err: `estimatedCostUSD: undeclared field
`
- `update-status` tail: `update-status task HLO-S01-T01 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → review-approved
`
- `emit` tail: `emit S01 '{
  "eventId": "HLO-S01-T01-review-plan-001",
  "inputTokens": null,
  "outputTokens": null,
  "cacheReadTokens": null,
  "cacheWriteTokens": null,
  "estimatedCostUSD": null,
  "tokenSource": "estimated"
}' --sidecar`
  - now_err: `estimatedCostUSD: undeclared field
`
- `emit` tail: `emit S01 "{\"eventId\":\"evt-HLO-S01-T01-impl-001\",\"taskId\":\"HLO-S01-T01\",\"sprintId\":\"S01\",\"role\":\"engineer\",\"action\":\"implement\",\"phase\":\"implement\",\"iteration\":1,\"startTimestamp\":\"2026-05-13T08:50:00Z\",\"endTimestamp\":\"$END_TS\",\"durationMinutes\":10,\"model\":\"claud`
  - now_err: `endTimestamp: missing required field
endTimestamp: value "" is not a valid date-time
`
- `emit` tail: `emit S01 '{"eventId":"evt-HLO-S01-T01-impl-001","inputTokens":null,"outputTokens":null,"cacheReadTokens":null,"cacheWriteTokens":null,"estimatedCostUSD":null,"tokenSource":"estimated"}' --sidecar 2>&1`
  - now_err: `estimatedCostUSD: undeclared field
`
- `update-status` tail: `update-status task HLO-S01-T01 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → review-approved
`
- `emit` tail: `emit S01 '{"eventId":"HLO-S01-T01-review-impl-001-tokens","inputTokens":null,"outputTokens":null,"cacheReadTokens":null,"cacheWriteTokens":null,"estimatedCostUSD":null,"tokenSource":"estimated"}' --sidecar`
  - now_err: `estimatedCostUSD: undeclared field
`
- `update-status` tail: `update-status task HLO-S01-T01 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → review-approved
`
- `emit` tail: `emit S01 '{"eventId":"evt-HLO-S01-T01-code-review-1","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"estimatedCostUSD":0.0,"tokenSource":"estimated"}' --sidecar`
  - now_err: `estimatedCostUSD: undeclared field
`
- `update-status` tail: `update-status task HLO-S01-T01 status review-approved 2>&1`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → review-approved
`
- `emit` tail: `emit S01 "{\"eventId\":\"20260513T035700Z_FORGE-S01-T01_code-review_complete\",\"taskId\":\"HLO-S01-T01\",\"sprintId\":\"S01\",\"role\":\"supervisor\",\"action\":\"code-review-complete\",\"phase\":\"review-code\",\"iteration\":1,\"startTimestamp\":\"2026-05-13T03:57:00Z\",\"endTimestamp\":\"$TIMESTA`
  - now_err: `endTimestamp: missing required field
endTimestamp: value "" is not a valid date-time
`
- `emit` tail: `emit S01 '{"eventId":"20260513T035700Z_FORGE-S01-T01_code-review_complete","inputTokens":null,"outputTokens":null,"cacheReadTokens":null,"cacheWriteTokens":null,"estimatedCostUSD":null,"tokenSource":"estimated"}' --sidecar 2>&1`
  - now_err: `estimatedCostUSD: undeclared field
`
- `update-status` tail: `update-status task HLO-S01-T01 status review-approved`
  - now_err: `Illegal transition: task HLO-S01-T01 status: draft → review-approved
`

## Improvements (22 total, 20 sampled)

- `update-status` tail: `update-status task HLO-S01-T03 status planned`
  - was_err: `Illegal transition: task HLO-S01-T03 status: plan-approved → planned


Command exited with code 1`
- `update-status` tail: `update-status task HLO-S01-T03 status planned`
  - was_err: `Illegal transition: task HLO-S01-T03 status: plan-revision-required → planned


Command exited with code 1`
- `update-status` tail: `update-status task HLO-S01-T03 status planned 2>&1`
  - was_err: `Illegal transition: task HLO-S01-T03 status: plan-revision-required → planned


Command exited with code 1`
- `update-status` tail: `update-status task HLO-S01-T03 status planned`
  - was_err: `Illegal transition: task HLO-S01-T03 status: plan-revision-required → planned


Command exited with code 1`
- `update-status` tail: `update-status task HLO-S01-T03 status plan-approved`
  - was_err: `Illegal transition: task HLO-S01-T03 status: plan-revision-required → plan-approved


Command exited with code 1`
- `describe` tail: `describe event 2>&1`
  - was_err: `node:internal/modules/cjs/loader:1372
  throw err;
  ^

Error: Cannot find module '/tools/store-cli.cjs'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1369:15)
    at defaultResolve`
- `get` tail: `describe event 2>&1`
  - was_err: `node:internal/modules/cjs/loader:1372
  throw err;
  ^

Error: Cannot find module '/tools/store-cli.cjs'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1369:15)
    at defaultResolve`
- `update-status` tail: `update-status task HLO-S01-T04 status planned`
  - was_err: `Illegal transition: task HLO-S01-T04 status: plan-revision-required → planned


Command exited with code 1`
- `update-status` tail: `update-status task HLO-S01-T05 status review-approved --force 2>&1`
  - was_err: `--force is operator-gated: re-run with FORGE_ALLOW_FORCE=1 in the environment to bypass the FSM. Subagents must not invoke --force; surface the illegal transition to the orchestrator instead.


Comman`
- `update-status` tail: `update-status task HLO-S01-T05 status review-approved --force`
  - was_err: `--force is operator-gated: re-run with FORGE_ALLOW_FORCE=1 in the environment to bypass the FSM. Subagents must not invoke --force; surface the illegal transition to the orchestrator instead.


Comman`
- `set-summary` tail: `set-summary HLO-S01-T05 approve /tmp/HLO-S01-T05-approve-summary.json`
  - was_err: `Unknown phase "approve". Valid phases: plan, review_plan, implementation, code_review, validation


Command exited with code 1`
- `describe` tail: `describe task HLO-S02-T01`
  - was_err: `Unknown command: describe
Run with --help for usage information.


Command exited with code 1`
