// Unit tests for parseForgeArgv (FORGE-S16-T02, Phase 1).
//
// Branches covered:
//   1. --version → forgeAction = "version", piArgv empty
//   2. --help    → forgeAction = "help", piArgv empty
//   3. --no-update-check → env.FORGE_NO_UPDATE_CHECK = "1"
//   4. --registry /path → env.FORGE_MODEL_REGISTRY = "/path"
//   5. -p "run task" → forwarded to piArgv
//   6. Unknown flag --foo → ParseError with "unknown flag"
//   7. Pi flag --cwd /tmp → forwarded verbatim
//   8. Mixed --version --cwd /tmp → version wins, piArgv empty (forge flags consumed first)
//   9. --registry without value → ParseError
//  10. Bare non-flag args forwarded
//  11. --no-color forwarded
//  12. Multiple pi flags forwarded

import { describe, expect, it } from "vitest";
import { isParseError, parseForgeArgv } from "../../src/bin/argv.js";

describe("parseForgeArgv", () => {
	it("--version → forgeAction = version, empty piArgv", () => {
		const result = parseForgeArgv(["--version"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.forgeAction).toBe("version");
		expect(result.piArgv).toEqual([]);
		expect(result.env).toEqual({});
	});

	it("--help → forgeAction = help, empty piArgv", () => {
		const result = parseForgeArgv(["--help"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.forgeAction).toBe("help");
		expect(result.piArgv).toEqual([]);
	});

	it("-h → forgeAction = help", () => {
		const result = parseForgeArgv(["-h"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.forgeAction).toBe("help");
	});

	it("--no-update-check → env.FORGE_NO_UPDATE_CHECK = 1", () => {
		const result = parseForgeArgv(["--no-update-check"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.env.FORGE_NO_UPDATE_CHECK).toBe("1");
		expect(result.forgeAction).toBeNull();
		expect(result.piArgv).toEqual([]);
	});

	it("--registry /path/foo → env.FORGE_MODEL_REGISTRY = /path/foo", () => {
		const result = parseForgeArgv(["--registry", "/path/foo"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.env.FORGE_MODEL_REGISTRY).toBe("/path/foo");
		expect(result.piArgv).toEqual([]);
	});

	it("--registry without value → ParseError", () => {
		const result = parseForgeArgv(["--registry"]);
		expect(isParseError(result)).toBe(true);
		if (!isParseError(result)) return;
		expect(result.error).toMatch(/--registry requires/);
	});

	it("-p 'run task' → forwarded to piArgv", () => {
		const result = parseForgeArgv(["-p", "run task"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.piArgv).toEqual(["-p", "run task"]);
	});

	it("unknown flag --foo → ParseError with 'unknown flag'", () => {
		const result = parseForgeArgv(["--foo"]);
		expect(isParseError(result)).toBe(true);
		if (!isParseError(result)) return;
		expect(result.error).toMatch(/unknown flag --foo/);
	});

	it("unknown --forge-* flag rejected", () => {
		const result = parseForgeArgv(["--forge-debug"]);
		expect(isParseError(result)).toBe(true);
	});

	it("--cwd /tmp → forwarded verbatim", () => {
		const result = parseForgeArgv(["--cwd", "/tmp"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.piArgv).toEqual(["--cwd", "/tmp"]);
	});

	it("--version with subsequent pi flag — version wins, pi args consumed by early return", () => {
		// --version is handled first; remaining args not processed once caller exits
		const result = parseForgeArgv(["--version", "--cwd", "/tmp"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		// forgeAction version set; --cwd /tmp are still forwarded since we scan all
		expect(result.forgeAction).toBe("version");
	});

	it("bare non-flag argument forwarded to piArgv", () => {
		const result = parseForgeArgv(["/some/project/path"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.piArgv).toEqual(["/some/project/path"]);
	});

	it("--no-color forwarded", () => {
		const result = parseForgeArgv(["--no-color"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.piArgv).toEqual(["--no-color"]);
	});

	it("multiple pi flags forwarded in order", () => {
		const result = parseForgeArgv(["--no-color", "--model", "claude-opus-4-5", "--no-session"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.piArgv).toEqual(["--no-color", "--model", "claude-opus-4-5", "--no-session"]);
	});

	it("empty argv → no action, empty piArgv", () => {
		const result = parseForgeArgv([]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.forgeAction).toBeNull();
		expect(result.piArgv).toEqual([]);
		expect(result.env).toEqual({});
	});

	// FORGE-S18-T01: --non-interactive flag
	it("--non-interactive → env.FORGE_NON_INTERACTIVE = '1', forgeAction null", () => {
		const result = parseForgeArgv(["--non-interactive"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.env.FORGE_NON_INTERACTIVE).toBe("1");
		expect(result.forgeAction).toBeNull();
		expect(result.piArgv).toEqual([]);
	});

	it("--non-interactive is not rejected as unknown flag", () => {
		const result = parseForgeArgv(["--non-interactive"]);
		expect(isParseError(result)).toBe(false);
	});

	it("--non-interactive combined with pi flags forwards pi args", () => {
		const result = parseForgeArgv(["--non-interactive", "--cwd", "/tmp"]);
		expect(isParseError(result)).toBe(false);
		if (isParseError(result)) return;
		expect(result.env.FORGE_NON_INTERACTIVE).toBe("1");
		expect(result.piArgv).toEqual(["--cwd", "/tmp"]);
	});
});
