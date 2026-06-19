/**
 * spike-mcp-hello — minimal stdio MCP server for FORGE-S34-T01.
 *
 * THROWAWAY SPIKE — lives under test/poc/, excluded from vitest.
 *
 * Purpose:
 *   - Prove esbuild node-only bundle (.cjs) works for MCP SDK.
 *   - Prove the server connects in a real Claude Code session (claude mcp list).
 *   - Prove CLAUDE_PROJECT_DIR is available at runtime.
 *   - Prove /mcp lists at least one tool from this server.
 *
 * Gate criteria (FORGE-S34-T01 AC2–AC4):
 *   - `claude mcp list` shows `forge` server status: connected.
 *   - `/mcp` reports >= 1 tool (hello).
 *   - `node dist/server.cjs` runs without node_modules/ at the call site.
 *   - CLAUDE_PROJECT_DIR value returned in forge_hello response.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Project root resolution (Decision 6) ─────────────────────────────────────

const projectRoot = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
if (!process.env["CLAUDE_PROJECT_DIR"]) {
  process.stderr.write(
    "[spike-mcp-hello] CLAUDE_PROJECT_DIR not set — falling back to cwd: " +
      projectRoot +
      "\n",
  );
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "forge",
    version: "0.0.1-spike",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ── Tool: hello (Decision 3: short name, CC surfaces as mcp__forge__hello) ───

const HELLO_TOOL = {
  name: "hello",
  description:
    "Spike proof tool — returns server info and CLAUDE_PROJECT_DIR. " +
    "Confirms node-only esbuild bundle works and server connected.",
  inputSchema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "Optional greeting message",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

// ── Request handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [HELLO_TOOL],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "hello") {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${request.params.name}`,
        },
      ],
      isError: true,
    };
  }

  const args = request.params.arguments as { message?: string } | undefined;
  const greeting = args?.message ?? "Hello from forge spike!";

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            greeting,
            server: "forge (spike-mcp-hello)",
            version: "0.0.1-spike",
            CLAUDE_PROJECT_DIR: process.env["CLAUDE_PROJECT_DIR"] ?? "(not set — using cwd fallback)",
            resolvedProjectRoot: projectRoot,
            nodeVersion: process.version,
            bundleProof: "Running as node-only bundle — no node_modules/ required at call site.",
          },
          null,
          2,
        ),
      },
    ],
  };
});

// ── Start ──────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[spike-mcp-hello] MCP server started (stdio transport)\n");
}

main().catch((err: unknown) => {
  process.stderr.write(
    "[spike-mcp-hello] Fatal: " + String(err) + "\n",
  );
  process.exit(1);
});
