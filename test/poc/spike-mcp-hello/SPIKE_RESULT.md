# SPIKE RESULT — spike-mcp-hello (FORGE-S34-T01)

**Date:** 2026-06-19
**Status:** GATE PASSED ✓
**Sprint task:** FORGE-S34-T01 — ADR + spike GATE

---

## Gate Criteria

| AC | Criterion | Result |
|----|-----------|--------|
| AC2 | `claude mcp list` shows `forge` server **Connected** | ✓ PASSED |
| AC3 | `/mcp` (tools/list) reports ≥ 1 tool from spike server | ✓ PASSED — `hello` tool returned |
| AC4 | Bundle runs with only `node` (no `node_modules/` at call site) | ✓ PASSED |
| AC6 | `CLAUDE_PROJECT_DIR` confirmed available at runtime | ✓ PASSED |

---

## AC2 — `claude mcp list` Output

Ran in `/tmp/forge-mcp-spike-test/` (project dir with `.mcp.json` and `claude mcp add-json` registration):

```
Checking MCP server health…

claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication
forge: node /home/boni/src/forge-engineering/forge-cli/test/poc/spike-mcp-hello/dist/server.cjs - ✔ Connected
```

**`forge` server status: Connected**

---

## AC3 — MCP tools/list Response

Direct protocol test (stdin/stdout, no Claude Code interactive session required):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/server.cjs
```

Response (tools/list result):
```json
{
  "result": {
    "tools": [
      {
        "name": "hello",
        "description": "Spike proof tool — returns server info and CLAUDE_PROJECT_DIR. Confirms node-only esbuild bundle works and server connected.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "message": {
              "type": "string",
              "description": "Optional greeting message"
            }
          },
          "required": [],
          "additionalProperties": false
        }
      }
    ]
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

**Tool `hello` returned — `mcp__forge__hello` in Claude Code session.**

---

## AC4 — Node-Only Bundle Proof

```bash
cp dist/server.cjs /tmp/mcp-nodeonly-test/
cd /tmp/mcp-nodeonly-test
# No node_modules/ present:
ls
# → server.cjs

timeout 3 node server.cjs
# → [spike-mcp-hello] CLAUDE_PROJECT_DIR not set — falling back to cwd: /tmp
# → [spike-mcp-hello] MCP server started (stdio transport)
# (hangs waiting for stdio input — correct MCP server behaviour)
```

No `Cannot find module` errors. Bundle is self-contained.

**Bundle size: 534 KB** (MCP SDK bundled in with esbuild node-only build)

---

## AC6 — CLAUDE_PROJECT_DIR Available

tools/call with `CLAUDE_PROJECT_DIR` set in environment:

```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hello","arguments":{}}}' \
  | env CLAUDE_PROJECT_DIR=/tmp/forge-mcp-spike-test node dist/server.cjs
```

Tool response:
```json
{
  "greeting": "FORGE-S34-T01 gate verification",
  "server": "forge (spike-mcp-hello)",
  "version": "0.0.1-spike",
  "CLAUDE_PROJECT_DIR": "/tmp/forge-mcp-spike-test",
  "resolvedProjectRoot": "/tmp/forge-mcp-spike-test",
  "nodeVersion": "v24.3.0",
  "bundleProof": "Running as node-only bundle — no node_modules/ required at call site."
}
```

`CLAUDE_PROJECT_DIR` value `/tmp/forge-mcp-spike-test` correctly returned.

---

## Build Evidence

```
$ node esbuild.config.cjs
  dist/server.cjs  534.4kb
⚡ Done in 45ms
[esbuild] bundle complete: dist/server.cjs (534 KB)
```

esbuild command:
```
--bundle --platform=node --target=node18 --format=cjs --outfile=dist/server.cjs
external: [node:*, fs, path, os, net, stream, events, buffer, util, ...]
```

---

## ADR Decisions Confirmed

| Decision | ADR | Spike evidence |
|----------|-----|----------------|
| 1. Server in forge-cli TS | ADR-S34-01 §1 | `server.ts` compiles via esbuild TS loader |
| 2. Node-only esbuild .cjs | ADR-S34-01 §2 | `dist/server.cjs` runs with only `node` |
| 3. Drop `forge_` prefix → `hello` not `forge_hello` | ADR-S34-01 §3 | tools/list returns `"name":"hello"` |
| 4. serverInstructions (not alwaysLoad) | ADR-S34-01 §4 | N/A for spike; confirmed in T03 |
| 5. MCP elicitation | ADR-S34-01 §5 | N/A for spike; confirmed in T03 |
| 6. CLAUDE_PROJECT_DIR | ADR-S34-01 §6 | Value returned in tool response |

---

## Next Steps

All gates pass. T02–T08 may proceed in dependency order per the sprint plan.
T02 first: create `tool-contracts.ts` shared SSOT module per ADR Decision 1.
