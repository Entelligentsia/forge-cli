// mcp/index.ts — bundle entry point for the Forge MCP server.
//
// This is the entry used by build-mcp-server.cjs → dist/mcp/server.cjs.

import { main } from "./server.js";

main().catch((err: unknown) => {
	process.stderr.write("[forge-mcp] Fatal: " + String(err) + "\n");
	process.exit(1);
});
