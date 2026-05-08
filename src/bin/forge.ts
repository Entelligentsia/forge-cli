#!/usr/bin/env node

// forge — production launcher (FORGE-S16-T02).
//
// Three bin aliases: forge / forgecli / 4ge (all point here via package.json).
// Handles --version, --help, forge-owned flags, then delegates to pi's main().

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "@earendil-works/pi-coding-agent";
import forgecli from "../extensions/forgecli/index.js";
import { isParseError, parseForgeArgv } from "./argv.js";

// ---------------------------------------------------------------------------
// Version information (resolved at startup from package.json files)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ForgePkg {
	version: string;
	forge?: {
		bundledVersion?: string;
	};
}

function readForgeCliPkg(): ForgePkg {
	try {
		// dist/bin/forge.js → dist → forgecli-root → package.json
		const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
		const raw = fs.readFileSync(pkgPath, "utf8");
		return JSON.parse(raw) as ForgePkg;
	} catch {
		return { version: "unknown" };
	}
}

async function readPiVersion(): Promise<string> {
	try {
		// Use import.meta.resolve to find the ESM package, then navigate to package.json
		const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const piDir = path.dirname(fileURLToPath(piEntryUrl));
		const pkgPath = path.resolve(piDir, "..", "package.json");
		const raw = fs.readFileSync(pkgPath, "utf8");
		const pkg = JSON.parse(raw) as { version?: string };
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

async function printVersion(): Promise<void> {
	const pkg = readForgeCliPkg();
	const forgeCliVersion = pkg.version ?? "unknown";
	const bundledVersion = pkg.forge?.bundledVersion ?? "unknown";
	const piVersion = await readPiVersion();
	process.stdout.write(
		`@entelligentsia/forgecli@${forgeCliVersion} (forge-plugin@${bundledVersion}, pi@${piVersion})\n`,
	);
}

function printHelp(): void {
	process.stdout.write(
		`forge — Forge SDLC on pi-coding-agent

Usage:
  forge [options] [pi-options] [project-path]

Forge-owned options:
  --version                Print version triplet and exit
  --help, -h               Print this help message
  --no-update-check        Skip forge update check (sets FORGE_NO_UPDATE_CHECK=1)
  --registry <path>        Override model registry path (sets FORGE_MODEL_REGISTRY=path)

Pi options (forwarded verbatim):
  --no-color               Disable colour output
  --cwd <path>             Set working directory
  --session <id>           Resume a session
  -p <prompt>              Initial prompt
  -r <file>                Read prompt from file
  -c <config>              Config override
  --fork                   Fork session
  --no-session             Disable session persistence
  --model <model>          Model to use
  --tools <list>           Enabled tools
  --append-system-prompt <text>  Append to system prompt
  --no-tools               Disable all tools
  --thinking               Enable extended thinking
  --no-thinking            Disable extended thinking

Unknown flags are rejected — forge performs strict argv ownership.

Slash commands (inside a Forge project):
  /forge:init              Bootstrap a new Forge SDLC project
  /forge:*                 Full Forge command set (when inside a Forge project)

`,
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const parsed = parseForgeArgv(process.argv.slice(2));

if (isParseError(parsed)) {
	process.stderr.write(`${parsed.error}\n`);
	process.exit(1);
}

if (parsed.forgeAction === "version") {
	await printVersion();
	process.exit(0);
}

if (parsed.forgeAction === "help") {
	printHelp();
	// Also forward --help to pi so the pi help section is shown
	await main(["--help"], { extensionFactories: [forgecli] });
	process.exit(0);
}

// Apply forge env overrides
Object.assign(process.env, parsed.env);

// Delegate to pi
await main(parsed.piArgv, { extensionFactories: [forgecli] });
