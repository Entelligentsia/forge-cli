#!/usr/bin/env node

// forge — production launcher (FORGE-S16-T02).
//
// Three bin aliases: forge / forgecli / 4ge (all point here via package.json).
// Handles --version, --help, forge-owned flags, then delegates to pi's main().

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "@earendil-works/pi-coding-agent";
import forgecli from "../extensions/forgecli/index.js";
import { isParseError, parseForgeArgv } from "./argv.js";
import { runDoctor } from "./doctor.js";

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
  --non-interactive        Bypass all Y/N gates with defaults, e.g. for CI (sets FORGE_NON_INTERACTIVE=1)
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

Subcommands:
  doctor [--json]          Preflight check — pi auth, model availability, settings

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

if (parsed.forgeAction === "doctor") {
	const pkg = readForgeCliPkg();
	const exitCode = await runDoctor(parsed.subcommandArgs ?? [], {
		forgeCli: pkg.version ?? "unknown",
		forgePlugin: pkg.forge?.bundledVersion ?? "unknown",
		pi: await readPiVersion(),
	});
	process.exit(exitCode);
}

// Apply forge env overrides
Object.assign(process.env, parsed.env);

// Default prompt-cache retention to "long" for all Forge sessions.
//
// Rationale: Forge subagent phases (plan, review_plan, implement, review_code,
// approve, commit) routinely run ~10 minutes per phase, and a sprint chains
// 4–8 such phases per task across the same persona/system-prompt prefix.
// Anthropic's default 5-minute cache TTL expires mid-phase; OpenAI's default
// in-memory cache evicts between phases. "long" gives Anthropic a 1h TTL and
// OpenAI 24h retention — comfortably covering a phase and the gap to the next.
//
// Cost: on Anthropic, 1h cache writes cost 25% more than 5m writes — but a
// single subsequent cache read (90% cheaper than fresh input) repays that
// premium ~3.6×, and every Forge phase reads the same prefix many times. On
// OpenAI, 24h retention is free. On proxies/compat backends, pi-ai ignores
// this env var, so this default is safe everywhere.
//
// Users who want the upstream pi-ai default keep an explicit value:
//   PI_CACHE_RETENTION=short forge ...
if (!process.env.PI_CACHE_RETENTION) {
	process.env.PI_CACHE_RETENTION = "long";
}

// Fast-path subcommand: spawn the bundled cjs tool directly. This skips
// the entire pi/agent boot and turns 26s cold-starts into <100ms shells.
if (parsed.forgeAction === "subcommand" && parsed.subcommandTool) {
	const toolPath = path.resolve(__dirname, "..", "forge-payload", "tools", parsed.subcommandTool);
	if (!fs.existsSync(toolPath)) {
		process.stderr.write(
			`forge: fast-path tool not found at ${toolPath}. Bundle may be corrupt — try \`forge --version\` and reinstall.\n`,
		);
		process.exit(1);
	}
	const result = spawnSync(process.execPath, [toolPath, ...(parsed.subcommandArgs ?? [])], {
		stdio: "inherit",
	});
	process.exit(result.status ?? 1);
}

// Delegate to pi
await main(parsed.piArgv, { extensionFactories: [forgecli] });
