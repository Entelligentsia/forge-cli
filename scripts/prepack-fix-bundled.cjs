#!/usr/bin/env node
// prepack-fix-bundled.cjs
//
// Works around an npm bug where `npm pack` walks the full
// dependency tree (incl. optionalDependencies) of every package listed in
// `bundledDependencies` and aborts with a silent exit 1 when an optional
// transitive dep's directory is absent from node_modules
// (ENOENT scandir on e.g. @mariozechner/clipboard-darwin-arm64).
//
// Strategy: before pack, scan every package reachable from this project's
// bundledDependencies; in each manifest, drop any entries from
// `optionalDependencies` whose directory is not actually installed. Back up
// the original package.json next to itself so `--restore` can put it back
// after pack completes.
//
// Usage:
//   node scripts/prepack-fix-bundled.cjs            (rewrite manifests)
//   node scripts/prepack-fix-bundled.cjs --restore  (restore from backups)

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const ROOT          = path.resolve(__dirname, "..");
const NODE_MODULES  = path.join(ROOT, "node_modules");
const BACKUP_SUFFIX = ".prepack-backup";
const RESTORE       = process.argv.includes("--restore");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolvePkgDir(name) {
  // Handles scoped names: @scope/name -> node_modules/@scope/name
  const dir = path.join(NODE_MODULES, ...name.split("/"));
  return fs.existsSync(path.join(dir, "package.json")) ? dir : null;
}

function rewrite() {
  const rootPkg = readJson(path.join(ROOT, "package.json"));
  const bundled = rootPkg.bundledDependencies || rootPkg.bundleDependencies || [];

  const seen    = new Set();
  const queue   = [...bundled];
  let stripped  = 0;

  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const dir = resolvePkgDir(name);
    if (!dir) continue;

    const pkgPath = path.join(dir, "package.json");
    const pkg     = readJson(pkgPath);

    const deps    = pkg.dependencies         || {};
    const optDeps = pkg.optionalDependencies || {};

    // Enqueue regular deps for traversal (their optional subdeps matter too).
    for (const dep of Object.keys(deps)) queue.push(dep);

    if (Object.keys(optDeps).length === 0) continue;

    const keep    = {};
    const dropped = [];
    for (const [dep, range] of Object.entries(optDeps)) {
      if (resolvePkgDir(dep)) {
        keep[dep] = range;
        queue.push(dep);
      } else {
        dropped.push(dep);
      }
    }

    if (dropped.length === 0) continue;

    fs.copyFileSync(pkgPath, pkgPath + BACKUP_SUFFIX);
    if (Object.keys(keep).length === 0) {
      delete pkg.optionalDependencies;
    } else {
      pkg.optionalDependencies = keep;
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    stripped += dropped.length;
    console.error(
      `[prepack-fix-bundled] ${name}: dropped ${dropped.length} missing optional dep(s): ${dropped.join(", ")}`,
    );
  }

  console.error(`[prepack-fix-bundled] total optional entries stripped: ${stripped}`);
}

function restore() {
  let count = 0;
  // Walk node_modules for any leftover backup files. Bounded depth: 4 levels
  // is enough for scoped + nested layouts we use here.
  function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name === "package.json" + BACKUP_SUFFIX) {
        const target = full.slice(0, -BACKUP_SUFFIX.length);
        fs.copyFileSync(full, target);
        fs.unlinkSync(full);
        count++;
      }
    }
  }
  walk(NODE_MODULES, 0);
  console.error(`[prepack-fix-bundled] restored ${count} manifest(s) from backup`);
}

if (RESTORE) restore();
else rewrite();
