# Vendored-File Divergence Ledger

Records forge-cli local edits applied on top of vendored upstream files.
The `sync-pi-upstream` skill MUST re-apply each entry on every weekly
pi-mono sync, otherwise the upstream-pristine version will silently
overwrite the divergence.

Each entry lists: file, originating task, the change in one sentence,
and the rationale.

## src/extensions/forgecli/subagent/index.ts

- **Task:** FORGE-S20-T11 (forge-cli v0.10.0)
- **Change:** Replace the local `shortenPath` helper inside
  `formatToolCall` with `shortenPath` imported from
  `../paths/paths.js`. Drop the local `os.homedir()` call.
- **Rationale:** AC #1 (no `os.homedir()` outside the central path
  resolver). Pure implementation refactor — behaviour unchanged.

## src/extensions/forgecli/subagent/agents.ts

- **Task:** FORGE-S20-T11 (forge-cli v0.10.0)
- **Change:** `discoverAgents` derives the user agents directory via
  `getPiAgentAgentsDir()` from `../paths/paths.js` instead of inlining
  `path.join(getAgentDir(), "agents")`. The resolver re-exports pi's
  `getAgentDir` so the resolved path is identical.
- **Rationale:** AC #1 (no `getAgentDir()` call sites in forge-cli
  outside the central path resolver). Pure centralization refactor —
  behaviour unchanged.
