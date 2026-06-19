/**
 * esbuild config for spike-mcp-hello.
 *
 * Produces dist/server.cjs — a self-contained node-only bundle.
 * All dependencies (MCP SDK, etc.) are bundled in.
 * Node built-ins (node:*) remain external — always available via Node.
 *
 * Usage: node esbuild.config.cjs
 * Or:    npm run build
 */

"use strict";

const { build } = require("esbuild");
const path = require("path");
const fs = require("fs");

const distDir = path.join(__dirname, "dist");
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

build({
  entryPoints: [path.join(__dirname, "server.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: path.join(distDir, "server.cjs"),
  // Node built-ins: mark external so the bundle stays lean.
  // They are always available at runtime via Node.js itself.
  external: [
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
  ],
  // Bundle everything else (MCP SDK, etc.)
  // minify: false — keep readable for spike verification
  minify: false,
  sourcemap: false,
  logLevel: "info",
})
  .then(() => {
    const stat = fs.statSync(path.join(distDir, "server.cjs"));
    const kb = Math.round(stat.size / 1024);
    console.log(`[esbuild] bundle complete: dist/server.cjs (${kb} KB)`);
  })
  .catch((err) => {
    console.error("[esbuild] build failed:", err);
    process.exit(1);
  });
