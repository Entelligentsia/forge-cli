# Illegal-Transition Drill — 59 failed update-status calls

Parsed illegal transitions: **48**

## Top illegal task-transitions attempted

| From | To | Count | Shortest legal path |
|---|---|---:|---|
| `plan-approved` | `implemented` | 7 | `plan-approved → implementing → implemented` |
| `bug::verified` | `fixed` | 6 | (non-task) |
| `plan-revision-required` | `planned` | 4 | `plan-revision-required → planned` |
| `plan-approved` | `planned` | 3 | `plan-approved → plan-revision-required → planned` |
| `code-revision-required` | `implemented` | 3 | `code-revision-required → implementing → implemented` |
| `code-revision-required` | `implementing` | 3 | `code-revision-required → implementing` |
| `code-revision-required` | `review-approved` | 3 | `code-revision-required → implementing → implemented → review-approved` |
| `planned` | `review-approved` | 2 | `planned → implemented → review-approved` |
| `plan-revision-required` | `draft` | 2 | `**NO LEGAL PATH**` |
| `plan-revision-required` | `plan-approved` | 2 | `plan-revision-required → planned → plan-approved` |
| `bug::verified` | `approved` | 2 | (non-task) |
| `review-approved` | `implemented` | 1 | `review-approved → plan-revision-required → planned → implemented` |
| `review-approved` | `implementing` | 1 | `review-approved → code-revision-required → implementing` |
| `plan-approved` | `review-approved` | 1 | `plan-approved → implementing → implemented → review-approved` |
| `plan-approved` | `in-progress` | 1 | `**NO LEGAL PATH**` |
| `code-revision-required` | `plan-approved` | 1 | `code-revision-required → implementing → plan-revision-required → planned → plan-approved` |
| `approved` | `completed` | 1 | `**NO LEGAL PATH**` |
| `approved` | `in_progress` | 1 | `**NO LEGAL PATH**` |
| `sprint::planning` | `completed` | 1 | (non-task) |
| `bug::fixed` | `verified` | 1 | (non-task) |

## Per source-state: where agents try to go

### From `approved`

- Legal destinations: `committed`, `plan-revision-required`, `code-revision-required`, `blocked`, `escalated`, `abandoned`
- Agent attempts (illegal):
  - `completed` × 1 — fix: `NO_PATH`
  - `in_progress` × 1 — fix: `NO_PATH`

### From `code-revision-required`

- Legal destinations: `implementing`, `blocked`, `escalated`, `abandoned`
- Agent attempts (illegal):
  - `implemented` × 3 — fix: `code-revision-required → implementing → implemented`
  - `implementing` × 3 — fix: `code-revision-required → implementing`
  - `review-approved` × 3 — fix: `code-revision-required → implementing → implemented → review-approved`
  - `plan-approved` × 1 — fix: `code-revision-required → implementing → plan-revision-required → planned → plan-approved`

### From `plan-approved`

- Legal destinations: `implementing`, `plan-revision-required`, `code-revision-required`, `blocked`, `escalated`, `abandoned`
- Agent attempts (illegal):
  - `implemented` × 7 — fix: `plan-approved → implementing → implemented`
  - `planned` × 3 — fix: `plan-approved → plan-revision-required → planned`
  - `review-approved` × 1 — fix: `plan-approved → implementing → implemented → review-approved`
  - `in-progress` × 1 — fix: `NO_PATH`

### From `plan-revision-required`

- Legal destinations: `planned`, `blocked`, `escalated`, `abandoned`
- Agent attempts (illegal):
  - `planned` × 4 — fix: `plan-revision-required → planned`
  - `draft` × 2 — fix: `NO_PATH`
  - `plan-approved` × 2 — fix: `plan-revision-required → planned → plan-approved`

### From `planned`

- Legal destinations: `plan-approved`, `implemented`, `plan-revision-required`, `code-revision-required`, `blocked`, `escalated`, `abandoned`
- Agent attempts (illegal):
  - `review-approved` × 2 — fix: `planned → implemented → review-approved`

### From `review-approved`

- Legal destinations: `approved`, `plan-revision-required`, `code-revision-required`, `blocked`, `escalated`, `abandoned`
- Agent attempts (illegal):
  - `implemented` × 1 — fix: `review-approved → plan-revision-required → planned → implemented`
  - `implementing` × 1 — fix: `review-approved → code-revision-required → implementing`

## Recovery behaviour after illegal-transition failure

- Walked intermediate state(s) to legal destination: **13**
- Used `--force` to bypass: **20**
- No recovery (gave up or sprint ended): **26**
