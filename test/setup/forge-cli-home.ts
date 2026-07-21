// Vitest setup: sandbox the forge-cli user root for every test file.
//
// The transcript-archive call sites in registerRunTask / registerFixBug /
// run-sprint write to ~/.pi/forge-cli/transcripts (via paths.ts userRoot()).
// Pipeline tests that drive those handlers without scoping FORGE_CLI_HOME
// would leak archive writes into the developer's real home — discovered when
// run-sprint suites deposited FORGE-S9x fixture runs in ~/.pi/forge-cli/.
//
// Defence in depth: default FORGE_CLI_HOME to a per-file tmpdir before any
// test runs. Suites that need their own scoped root (run-task.test.ts,
// transcript-archive.test.ts, …) still override it in beforeEach; their
// afterEach restores this sandbox value, never the real home.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cli-home-vitest-"));
process.env.FORGE_CLI_HOME = sandbox;
process.env.FORGE_CLI_SKIP_MIGRATION = process.env.FORGE_CLI_SKIP_MIGRATION ?? "1";

// One sandbox is created per test file, so without this every `npm test` run
// left a dir behind in os.tmpdir(). Hooks in a setupFile apply per test file.
afterAll(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});
