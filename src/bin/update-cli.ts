// forge update — bin-layer subcommand (Plan 15). Mirrors /forge:update slash
// command but runs without a pi session. Shared helpers imported directly from
// forge-update-command.ts.

import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	composeChangelogSummary,
	detectInstallMethod,
	fetchChangelog,
	getNpmGlobalRoot,
	type InstallMethod,
	isUpgrade,
	runUpgrade,
} from "../extensions/forgecli/forge-update-command.js";

const PKG_NAME = "@entelligentsia/forgecli";

// Resolved at module load — bin lives at dist/bin/; package root is two up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_PKG_ROOT = path.resolve(__dirname, "..", "..");

export interface RunUpdateOptions {
	forgeCli: string;
	fetchImpl?: typeof fetch;
	globalRootResolver?: () => Promise<string | null>;
	upgradeRunner?: (spec: string) => ReturnType<typeof runUpgrade>;
	pkgRootOverride?: string;
}

async function askConfirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y");
		});
	});
}

interface ParsedArgs {
	check: boolean;
	yes: boolean;
	versionSpec: string | null;
	bad: string | null;
}

function parseArgs(args: string[]): ParsedArgs {
	let check = false;
	let yes = false;
	let versionSpec: string | null = null;
	let i = 0;
	while (i < args.length) {
		const t = args[i]!;
		if (t === "--check") {
			check = true;
			i++;
		} else if (t === "--yes" || t === "-y") {
			yes = true;
			i++;
		} else if (t === "--version") {
			if (i + 1 >= args.length) {
				return { check, yes, versionSpec, bad: "--version requires a spec argument" };
			}
			versionSpec = args[i + 1]!;
			i += 2;
		} else {
			return {
				check,
				yes,
				versionSpec,
				bad: `forge update: unknown option ${t}. Valid options: --check, --yes, --version <spec>`,
			};
		}
	}
	return { check, yes, versionSpec, bad: null };
}

function printInstallMethodError(method: InstallMethod): void {
	process.stderr.write(
		`forge update: install method '${method}' is not eligible for guided upgrade.\n` +
			`Only globally-installed forgecli supports guided upgrade.\n` +
			`To upgrade manually: npm i -g ${PKG_NAME}@latest\n`,
	);
}

export async function runUpdate(args: string[], opts: RunUpdateOptions): Promise<number> {
	const { check, yes, versionSpec, bad } = parseArgs(args);
	if (bad) {
		process.stderr.write(`${bad}\n`);
		return 1;
	}

	const fetchImpl = opts.fetchImpl ?? fetch;
	const resolveGlobal = opts.globalRootResolver ?? getNpmGlobalRoot;
	const upgrade = opts.upgradeRunner ?? runUpgrade;
	const pkgRoot = opts.pkgRootOverride ?? BIN_PKG_ROOT;

	// 1. Install method detection
	const globalRoot = await resolveGlobal();
	const method = detectInstallMethod({ pkgRoot, globalRoot });
	if (method !== "global") {
		printInstallMethodError(method);
		return 1;
	}

	// 2. Fetch latest release (or use --version override)
	process.stderr.write("forge update: fetching latest release…\n");
	const release = versionSpec
		? { version: versionSpec.startsWith("v") ? versionSpec.slice(1) : versionSpec, body: "", tag: versionSpec }
		: await fetchChangelog(fetchImpl);

	if (!release) {
		process.stderr.write(
			"forge update: could not reach github.com/Entelligentsia/forge-cli releases.\n" +
				`Check your network and retry, or upgrade manually: npm i -g ${PKG_NAME}@latest\n`,
		);
		return 1;
	}

	const current = opts.forgeCli;

	// Up-to-date check (skip when --version override is supplied)
	if (!versionSpec && !isUpgrade(current, release.version)) {
		process.stdout.write(
			`forge update: already at the latest version (${current}; latest published: ${release.version}).\n`,
		);
		return 0;
	}

	// 3. --check: report availability and exit without upgrading (exit 2)
	if (check) {
		process.stdout.write(`forge update: upgrade available ${current} → ${release.version}\n`);
		return 2;
	}

	// 4. Show summary and confirm
	const summary = composeChangelogSummary(current, release.version, release.body);
	process.stdout.write(`\n${summary}\n\n`);

	const doUpgrade =
		yes || process.env.FORGE_NON_INTERACTIVE === "1"
			? true
			: await askConfirm(`Upgrade forgecli ${current} → ${release.version}?`);

	if (!doUpgrade) {
		process.stdout.write("forge update: cancelled.\n");
		return 0;
	}

	// 5. Run npm i -g (execFile argv array — Iron Law 6)
	process.stderr.write(`forge update: running npm i -g ${PKG_NAME}@${release.version}…\n`);
	const result = await upgrade(`${PKG_NAME}@${release.version}`);
	if (!result.ok) {
		process.stderr.write(
			`forge update: npm i -g failed:\n${result.stderr}\n` +
				"Check the error above; you may need elevated permissions to install globally.\n",
		);
		return 1;
	}

	process.stdout.write(
		`forge update: installed ${PKG_NAME}@${release.version}.\n` +
			"Restart your forge session for the new version to take effect.\n",
	);
	return 0;
}
