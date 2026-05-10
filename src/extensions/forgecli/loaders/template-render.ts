// Shared template-render helper — FORGE-S20-T03.
//
// Tiny, dependency-free `{NAME}` substitution helper used by kickoff-message
// composition in forge-cli command handlers (T05 /forge:plan, T06
// /forge:implement, and any future kickoff shim that needs argv-driven seed
// substitution).
//
// API:
//   renderTemplate(templatePath: string, vars: Record<string, string>): string
//
// Substitution rule (frozen):
//   - Token syntax: `{NAME}` where NAME matches /[A-Za-z_][A-Za-z0-9_]*/.
//     Anything else — `{}`, `{ NAME }`, `{1NAME}`, `{lowercase-dashed}` — is
//     a literal and passes through unchanged.
//   - Missing var (token in template, key absent from `vars`): throws
//     TemplateRenderError("missing_var", ...). Never silently renders "".
//     (Iron Law 7: no silent continuation.)
//   - Extra vars (key in `vars` not referenced in template): ignored.
//   - Values are inserted literally — no HTML/regex escaping. Callers handle
//     downstream sanitisation.
//   - Missing template file: throws TemplateRenderError("missing_template_file", ...).
//
// Iron Law 6 (no shell-string interpolation): pure fs.readFileSync, no
// child_process. Iron Law 7 (no silent continuation): every failure mode
// raises a typed TemplateRenderError with an explicit code.

import * as fs from "node:fs";

// ── Errors ───────────────────────────────────────────────────────────────

export type TemplateRenderErrorCode = "missing_template_file" | "missing_var" | "invalid_args";

export class TemplateRenderError extends Error {
	public readonly code: TemplateRenderErrorCode;
	constructor(code: TemplateRenderErrorCode, message: string) {
		super(message);
		this.name = "TemplateRenderError";
		this.code = code;
	}
}

// ── Token grammar ────────────────────────────────────────────────────────
//
// Single regex, global, captures the bare identifier. Anchored on `{` and `}`
// with no whitespace tolerance — `{ NAME }` is a literal, by design.
const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ── Internal: substitute over an in-memory string ────────────────────────

function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(TOKEN_RE, (_match, name: string) => {
		if (!Object.hasOwn(vars, name)) {
			throw new TemplateRenderError(
				"missing_var",
				`template references {${name}} but no value was supplied in vars`,
			);
		}
		const value = vars[name];
		if (typeof value !== "string") {
			throw new TemplateRenderError(
				"invalid_args",
				`vars[${JSON.stringify(name)}] must be a string, got ${typeof value}`,
			);
		}
		return value;
	});
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Render a template file by substituting `{NAME}` tokens with values from `vars`.
 *
 * @param templatePath Absolute or cwd-relative path to a UTF-8 template file.
 * @param vars Map from identifier name to substitution value (string).
 * @returns The rendered template as a string.
 *
 * @throws TemplateRenderError({ code: "missing_template_file" }) if the file
 *         does not exist or cannot be read.
 * @throws TemplateRenderError({ code: "missing_var" }) if the template
 *         references a token whose name is not a key in `vars`.
 * @throws TemplateRenderError({ code: "invalid_args" }) if `templatePath` is
 *         not a non-empty string or any value in `vars` is not a string.
 */
export function renderTemplate(templatePath: string, vars: Record<string, string>): string {
	if (typeof templatePath !== "string" || templatePath.length === 0) {
		throw new TemplateRenderError("invalid_args", "templatePath must be a non-empty string");
	}
	if (vars === null || typeof vars !== "object") {
		throw new TemplateRenderError("invalid_args", "vars must be an object");
	}

	let raw: string;
	try {
		raw = fs.readFileSync(templatePath, "utf8");
	} catch (err) {
		const e = err as { message?: string; code?: string };
		throw new TemplateRenderError(
			"missing_template_file",
			`failed to read template at ${templatePath}: ${e.code ?? ""} ${e.message ?? "unknown error"}`.trim(),
		);
	}

	return substitute(raw, vars);
}
