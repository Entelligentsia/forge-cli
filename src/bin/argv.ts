// Forge argv parser — owns the forge/pi flag split.
//
// `parseForgeArgv` is a pure function (no side effects, no process.exit).
// Returns a tagged result so the caller decides how to handle errors.
//
// Flag ownership matrix (FORGE-S16-T02, Q16):
//
// Forge-owned flags:
//   --version                  → forgeAction = "version"
//   --help                     → forgeAction = "help"
//   --no-update-check          → env.FORGE_NO_UPDATE_CHECK = "1"
//   --registry <path>          → env.FORGE_MODEL_REGISTRY = <path>
//
// Unknown flags (rejected with exit 1):
//   Any --<name> flag not in the forge-owned set AND not in the pi
//   passthrough allowlist below. This includes --forge-* patterns.
//
// Pi-passthrough flags (forwarded verbatim):
//   --no-color, --cwd, --session, -p, -r, -c, --fork, --no-session,
//   --model, --tools, --append-system-prompt, --no-tools, --thinking,
//   --no-thinking, and bare non-flag arguments.

/** Parsed result when `--version`, `--help`, or a fast-path subcommand is requested. */
export type ForgeAction = "version" | "help" | "subcommand" | null;

/**
 * Whitelist of bare subcommands that bypass pi and exec a bundled cjs tool
 * directly. Each entry maps the user-typed subcommand to the cjs filename
 * under `dist/forge-payload/.tools/`. Direct exec keeps these <100ms vs the
 * ~26s cold-start an agent loop would incur.
 */
export const FAST_PATH_SUBCOMMANDS: Readonly<Record<string, string>> = Object.freeze({
	store: "store-cli.cjs",
	collate: "collate.cjs",
	"validate-store": "validate-store.cjs",
	"store-query": "store-query.cjs",
});

export interface ParseResult {
	/** Action for forge to handle before invoking pi, or null if pi should run. */
	forgeAction: ForgeAction;
	/** Argv to pass directly to pi's `main()`. */
	piArgv: string[];
	/** Env vars to set before invoking pi. */
	env: Record<string, string>;
	/** When forgeAction === "subcommand", the cjs filename to exec. */
	subcommandTool?: string;
	/** When forgeAction === "subcommand", argv to pass after the cjs filename. */
	subcommandArgs?: string[];
}

export interface ParseError {
	error: string;
}

export type ParseResultOrError = ParseResult | ParseError;

export function isParseError(r: ParseResultOrError): r is ParseError {
	return "error" in r;
}

// Set of flags pi accepts that we forward verbatim (includes value-taking flags).
// Value-taking flags: the next argv token is forwarded too.
const PI_FLAGS_NO_VALUE = new Set([
	"--no-color",
	"--fork",
	"--no-session",
	"--no-tools",
	"--thinking",
	"--no-thinking",
]);

const PI_FLAGS_WITH_VALUE = new Set([
	"--cwd",
	"--session",
	"-p",
	"-r",
	"-c",
	"--model",
	"--tools",
	"--append-system-prompt",
]);

/**
 * Parse forge CLI arguments and split them into forge-owned actions,
 * pi-bound argv, and env overrides.
 *
 * Never calls process.exit — caller is responsible.
 */
export function parseForgeArgv(argv: string[]): ParseResultOrError {
	const piArgv: string[] = [];
	const env: Record<string, string> = {};
	let forgeAction: ForgeAction = null;

	let i = 0;
	while (i < argv.length) {
		const token = argv[i];

		// ── Forge-owned flags ────────────────────────────────────────────────
		if (token === "--version") {
			forgeAction = "version";
			i++;
			continue;
		}

		if (token === "--help" || token === "-h") {
			forgeAction = "help";
			i++;
			continue;
		}

		if (token === "--no-update-check") {
			env.FORGE_NO_UPDATE_CHECK = "1";
			i++;
			continue;
		}

		if (token === "--non-interactive") {
			env.FORGE_NON_INTERACTIVE = "1";
			i++;
			continue;
		}

		if (token === "--registry") {
			if (i + 1 >= argv.length) {
				return { error: "forge: --registry requires a path argument. Run `forge --help` for usage." };
			}
			env.FORGE_MODEL_REGISTRY = argv[i + 1];
			i += 2;
			continue;
		}

		// ── Pi passthrough (no value) ────────────────────────────────────────
		if (PI_FLAGS_NO_VALUE.has(token)) {
			piArgv.push(token);
			i++;
			continue;
		}

		// ── Pi passthrough (with value) ──────────────────────────────────────
		if (PI_FLAGS_WITH_VALUE.has(token)) {
			piArgv.push(token);
			if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
				piArgv.push(argv[i + 1]);
				i += 2;
			} else {
				// Flag without a value — forward as-is; pi will error
				i++;
			}
			continue;
		}

		// ── Fast-path subcommand (forge store, forge collate, etc.) ──────────
		// Only matches the FIRST bare token, and only when no flags have
		// been collected yet (so `forge --cwd /tmp store ...` still treats
		// `store` as a fast-path; forgeAction overrides piArgv in that case).
		if (
			!token.startsWith("-") &&
			Object.hasOwn(FAST_PATH_SUBCOMMANDS, token) &&
			piArgv.length === 0
		) {
			return {
				forgeAction: "subcommand",
				piArgv: [],
				env,
				subcommandTool: FAST_PATH_SUBCOMMANDS[token],
				subcommandArgs: argv.slice(i + 1),
			};
		}

		// ── Bare non-flag argument (project path etc.) ───────────────────────
		if (!token.startsWith("-")) {
			piArgv.push(token);
			i++;
			continue;
		}

		// ── Short flags not covered above — reject unknown ───────────────────
		// Unknown --<flag>: reject
		return {
			error: `forge: unknown flag ${token}. Run \`forge --help\` for usage.`,
		};
	}

	return { forgeAction, piArgv, env };
}
