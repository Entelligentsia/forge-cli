/**
 * build-mcp-server.cjs — esbuild bundle script for the Forge MCP server.
 * FORGE-S34-T03.
 *
 * Produces dist/mcp/server.cjs — a self-contained node-only bundle with the
 * MCP SDK and remark/unified/js-yaml bundled in. Node built-ins remain external
 * (always available via Node.js). remark is bundled for forge_markdown (T04).
 *
 * Usage: node scripts/build-mcp-server.cjs
 * Or via npm: npm run build:mcp
 */

"use strict";

const { build } = require("esbuild");
const path = require("path");
const fs = require("fs");

const projectRoot = path.join(__dirname, "..");
const distDir = path.join(projectRoot, "dist", "mcp");

if (!fs.existsSync(distDir)) {
	fs.mkdirSync(distDir, { recursive: true });
}

// Node built-ins — always external (available at runtime via Node.js itself)
const NODE_BUILTINS = [
	"node:*",
	"fs",
	"path",
	"os",
	"net",
	"stream",
	"events",
	"buffer",
	"util",
	"url",
	"crypto",
	"child_process",
	"process",
	"assert",
	"tty",
	"readline",
	"string_decoder",
	"timers",
	"zlib",
	"http",
	"https",
	"querystring",
	"module",
];

build({
	entryPoints: [path.join(projectRoot, "src", "extensions", "forgecli", "mcp", "index.ts")],
	bundle: true,
	platform: "node",
	target: "node18",
	format: "cjs",
	outfile: path.join(distDir, "server.cjs"),
	external: NODE_BUILTINS,
	// @modelcontextprotocol/sdk, tool-contracts.ts, remark/unified/js-yaml are bundled in.
	// remark-parse, remark-gfm, remark-frontmatter, mdast-util-to-string, js-yaml
	// are intentionally bundled for forge_markdown native tool (T04).
	minify: false,
	sourcemap: false,
	logLevel: "info",
})
	.then(() => {
		const stat = fs.statSync(path.join(distDir, "server.cjs"));
		const kb = Math.round(stat.size / 1024);
		console.log(`[build-mcp-server] bundle complete: dist/mcp/server.cjs (${kb} KB)`);
		// Advisory size check — warn (not error) if above 1MB
		if (stat.size > 1024 * 1024) {
			console.warn(
				`[build-mcp-server] WARNING: bundle exceeds 1MB (${kb} KB). Review external list.`,
			);
		}
	})
	.catch((err) => {
		console.error("[build-mcp-server] build failed:", err);
		process.exit(1);
	});
