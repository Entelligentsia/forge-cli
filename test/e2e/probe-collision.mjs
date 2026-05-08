#!/usr/bin/env node
// Synthetic foundry-collision probe (FORGE-S16-T11).
//
// Constructs a temporary PATH segment containing a fake `forge` shim, prepends
// it ahead of the real install, then imports detectFoundryCollision from the
// installed @entelligentsia/forgecli package and asserts that a collision is
// detected.
//
// Exits 0 on detected collision, 1 on miss, 2 on probe error.

import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let tmp = "";
try {
	tmp = mkdtempSync(path.join(tmpdir(), "forgecli-collision-"));
	const shimDir = path.join(tmp, "bin");
	mkdirSync(shimDir, { recursive: true });
	const shim = path.join(shimDir, "forge");
	writeFileSync(shim, "#!/bin/sh\necho fake-forge\n", "utf8");
	chmodSync(shim, 0o755);

	// Prepend shim dir to PATH so `which forge` resolves to the shim.
	process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
	// Fake argv[1] under a different ancestor — the detector compares
	// realpath(argv[1]) ancestor against realpath(`which forge`) ancestor.
	const fakeArgv1 = path.join(tmp, "real-install", "bin", "forge");
	mkdirSync(path.dirname(fakeArgv1), { recursive: true });
	writeFileSync(fakeArgv1, "#!/bin/sh\n", "utf8");
	chmodSync(fakeArgv1, 0o755);
	process.argv[1] = fakeArgv1;

	const installPath = process.env.FORGECLI_INSTALL_PATH;
	if (!installPath) {
		console.error("probe-collision: FORGECLI_INSTALL_PATH must be set to the installed package dir");
		process.exit(2);
	}
	const collisionMod = require(path.join(installPath, "dist", "extensions", "forgecli", "foundry-collision.js"));
	const result = collisionMod.detectFoundryCollision();

	if (result && result.collides === true && typeof result.colliderPath === "string") {
		console.log(`OK collision detected: ${result.colliderPath}`);
		process.exit(0);
	}
	console.error(`MISS no collision: ${JSON.stringify(result)}`);
	process.exit(1);
} catch (err) {
	console.error(`probe-collision error: ${err && err.stack ? err.stack : err}`);
	process.exit(2);
} finally {
	if (tmp) {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
