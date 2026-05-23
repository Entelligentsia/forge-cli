// shared-parser.ts — Structural interface contract for forge subcommand arg parsers (B-2).
//
// Defines SubcommandArgsParser<T> as a pure structural interface.
// No runtime base class — TypeScript structural typing is sufficient.
// Parsers (argv.ts, config.ts, update-cli.ts) reference this interface
// via JSDoc @implements annotations.
//
// Terminology standard (N-B-D): all parser error messages MUST use
// "unknown option" (not "unknown flag") and the prefix format:
//   "forge <cmd>: unknown option <token>. ..."

/**
 * Structural contract for a subcommand arg parser.
 *
 * `parse` receives the raw argv slice (tokens after the subcommand name)
 * and returns either a parsed result of type T or an error descriptor.
 * The caller is responsible for detecting the error branch via the
 * `"error" in result` guard.
 *
 * @template T — the parsed result type (subcommand-specific)
 */
export interface SubcommandArgsParser<T> {
	parse(args: string[]): T | { error: string };
}

/**
 * Convenience union alias for the return type of `SubcommandArgsParser<T>.parse`.
 *
 * Usage: `function parseArgs(args: string[]): ParseResultOrError<MyResult>`
 */
export type ParseResultOrError<T> = T | { error: string };
