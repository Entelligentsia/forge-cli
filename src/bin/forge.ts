#!/usr/bin/env node

// forge — production launcher (FORGE-S16-T02).
//
// Three bin aliases: forge / forgecli / 4ge (all point here via package.json).
// Handles --version, --help, forge-owned flags, then delegates to pi's main().

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "@earendil-works/pi-coding-agent";
import forgecli from "../extensions/forgecli/index.js";
import { isParseError, parseForgeArgv } from "./argv.js";
import { runDoctor } from "./doctor.js";
import { applyForgeOwnedEnvDefaults } from "./env-defaults.js";
import { runUpdate } from "./update-cli.js";
import { runConfig } from "./config.js";
import {
	readForgeCliVersion,
	readBundledPluginVersion,
	readPiVersionAsync,
} from "../extensions/forgecli/lib/versions.js";

// ---------------------------------------------------------------------------
// Version information (resolved at startup from package.json files)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package root: dist/bin/forge.js → dist/ → <pkg-root>/
const BIN_PKG_ROOT = path.resolve(__dirname, "..", "..");

async function printVersion(): Promise<void> {
	const forgeCliVersion = readForgeCliVersion(BIN_PKG_ROOT);
	const bundledVersion = readBundledPluginVersion(BIN_PKG_ROOT);
	const piVersion = await readPiVersionAsync();
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
  --strict-models          Treat unavailable/unknown model config entries as errors (sets FORGE_STRICT_MODELS=1)
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
  update [--check] [--yes] [--version <spec>]  Guided upgrade (npm i -g)
  config show [--resolved] [--json]  Model routing config inspector

Slash commands (inside a Forge project):
  /forge:init              Bootstrap a new Forge SDLC project
  /forge:*                 Full Forge command set (when inside a Forge project)

`,
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Wrapped in an async IIFE rather than using top-level await.
// Why: subcommands like `forge update` block on an interactive [y/N]
// readline prompt for arbitrarily long. Node v22+ emits a
// "Detected unsettled top-level await" warning when a top-level await
// has been pending past ~10s with an idle-looking event loop. Pushing
// the await one frame down into a regular async function silences it
// without changing behaviour.
async function run(): Promise<void> {
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
		const exitCode = await runDoctor(parsed.subcommandArgs ?? [], {
			forgeCli: readForgeCliVersion(BIN_PKG_ROOT),
			forgePlugin: readBundledPluginVersion(BIN_PKG_ROOT),
			pi: await readPiVersionAsync(),
		});
		process.exit(exitCode);
	}

	if (parsed.forgeAction === "update") {
		const exitCode = await runUpdate(parsed.subcommandArgs ?? [], { forgeCli: readForgeCliVersion(BIN_PKG_ROOT) });
		process.exit(exitCode);
	}

	if (parsed.forgeAction === "config") {
		const exitCode = await runConfig(parsed.subcommandArgs ?? []);
		process.exit(exitCode);
	}

	// Apply forge env overrides
	Object.assign(process.env, parsed.env);

	applyForgeOwnedEnvDefaults();

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
		if (!existsSync(toolPath)) {
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
}

run().catch((err) => {
	process.stderr.write(`forge: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
