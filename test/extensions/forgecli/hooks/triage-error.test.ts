// Unit tests for hooks/triage-error.ts (FORGE-S23-T03).
//
// Coverage:
//   isForgeRelated:
//     1. Returns true for each of the 12 FORGE_PATTERNS (spot-checks key patterns)
//     2. Returns false for a non-Forge command
//     3. Partial match within compound command succeeds
//   buildTriageMessage:
//     4. Contains FORGE_ERROR_TRIAGE prefix
//     5. Contains /forge:report-bug reference
//     6. Includes error snippet when provided
//     7. Omits snippet placeholder when snippet is empty

import { describe, expect, it } from "vitest";
import {
	buildTriageMessage,
	FORGE_PATTERNS,
	isForgeRelated,
} from "../../../../src/extensions/forgecli/hooks/triage-error.js";

describe("FORGE_PATTERNS", () => {
	it("exports 12 patterns", () => {
		expect(FORGE_PATTERNS).toHaveLength(12);
	});
});

describe("isForgeRelated", () => {
	it("1a. returns true for command containing .forge/", () => {
		expect(isForgeRelated("node .forge/tools/store-cli.cjs list tasks")).toBe(true);
	});

	it("1b. returns true for command containing FORGE_ROOT", () => {
		expect(isForgeRelated('FORGE_ROOT=$(node -e "...") && node "$FORGE_ROOT/tools/collate.cjs"')).toBe(true);
	});

	it("1c. returns true for command containing manage-config", () => {
		expect(isForgeRelated("node manage-config.cjs --get paths.forgeRoot")).toBe(true);
	});

	it("1d. returns true for command containing CLAUDE_PLUGIN_ROOT", () => {
		expect(isForgeRelated("ls $CLAUDE_PLUGIN_ROOT/tools/")).toBe(true);
	});

	it("1e. returns true for command containing MANAGE_CONFIG", () => {
		expect(isForgeRelated("MANAGE_CONFIG=1 node tools/build.cjs")).toBe(true);
	});

	it("1f. returns true for command containing engineering/tools/", () => {
		expect(isForgeRelated("node engineering/tools/validate-store.cjs")).toBe(true);
	});

	it("1g. returns true for command containing forge:init", () => {
		expect(isForgeRelated("/forge:init my-project")).toBe(true);
	});

	it("1h. returns true for command containing forge:health", () => {
		expect(isForgeRelated("/forge:health --verbose")).toBe(true);
	});

	it("1i. returns true for command containing forge:regenerate", () => {
		expect(isForgeRelated("/forge:regenerate")).toBe(true);
	});

	it("1j. returns true for command containing forge:update", () => {
		expect(isForgeRelated("/forge:update --dry-run")).toBe(true);
	});

	it("1k. returns true for command containing forge:add-pipeline", () => {
		expect(isForgeRelated("/forge:add-pipeline custom")).toBe(true);
	});

	it("2. returns false for a non-Forge command", () => {
		expect(isForgeRelated("ls -la /tmp && cat /etc/hosts")).toBe(false);
	});

	it("3. returns true for Forge pattern embedded in compound command", () => {
		expect(isForgeRelated("cd /project && node .forge/tools/build-manifest.cjs && echo done")).toBe(true);
	});

	it("4. returns false for empty string", () => {
		expect(isForgeRelated("")).toBe(false);
	});
});

describe("buildTriageMessage", () => {
	it("5. contains FORGE_ERROR_TRIAGE prefix", () => {
		const msg = buildTriageMessage("node .forge/tools/store-cli.cjs", "");
		expect(msg).toContain("FORGE_ERROR_TRIAGE");
	});

	it("6. contains /forge:report-bug reference", () => {
		const msg = buildTriageMessage("node .forge/tools/store-cli.cjs", "");
		expect(msg).toContain("/forge:report-bug");
	});

	it("7. includes error snippet when provided", () => {
		const snippet = "Error: ENOENT no such file";
		const msg = buildTriageMessage("node .forge/tools/store-cli.cjs", snippet);
		expect(msg).toContain(snippet);
	});

	it("8. omits snippet text when snippet is empty", () => {
		const msg = buildTriageMessage("node .forge/tools/store-cli.cjs", "");
		// Should not contain placeholder noise
		expect(msg).not.toContain('""');
		expect(msg).not.toContain("First error line: ");
	});
});
