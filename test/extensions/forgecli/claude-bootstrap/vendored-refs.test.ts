// vendored-refs.test.ts — no dead vendored references gate (forge#112 class).
//
// Bootstraps a project from the REAL dist/forge-payload and asserts every
// .forge/… / $FORGE_ROOT/… path referenced by vendored content exists.
// Four 2026-06-07 field failures shared one root cause: a runtime reference
// whose target wasn't carried through the payload→vendor pipeline. This gate
// makes that class unshippable.
//
// Skips silently when dist/forge-payload is absent (CI builds it before
// vitest — see .github/workflows/tests.yml "Build payload bundle").

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapClaudeProject } from "../../../../src/extensions/forgecli/claude-bootstrap/bootstrap.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkVendoredRefs } = require("../../../../tools/check-vendored-refs.cjs") as {
	checkVendoredRefs: (projectDir: string) => {
		scannedFiles: number;
		refCount: number;
		missing: Map<string, Set<string>>;
	};
};

const REAL_PAYLOAD = path.resolve(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"..",
	"..",
	"..",
	"dist",
	"forge-payload",
);

let tmpRoot: string;

beforeAll(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-refs-"));
});

afterAll(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe("checkVendoredRefs scanner", () => {
	it("detects a dead reference in a minimal fixture", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "fixture-"));
		fs.mkdirSync(path.join(dir, ".claude", "commands", "forge"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".forge", "tools"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude", "commands", "forge", "x.md"),
			"Run `node .forge/tools/does-not-exist.cjs` now.\n",
			"utf8",
		);

		const { missing } = checkVendoredRefs(dir);
		expect(missing.has(".forge/tools/does-not-exist.cjs")).toBe(true);
	});

	it("resolves $FORGE_ROOT and $CLAUDE_PROJECT_DIR/.forge forms, skips placeholders", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "fixture-"));
		fs.mkdirSync(path.join(dir, ".claude", "commands", "forge"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".forge", "tools"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".forge", "tools", "real.cjs"), "// ok\n", "utf8");
		fs.writeFileSync(
			path.join(dir, ".claude", "commands", "forge", "x.md"),
			[
				'node "$FORGE_ROOT/tools/real.cjs"',
				'node "$CLAUDE_PROJECT_DIR/.forge/tools/real.cjs"',
				// placeholder forms must not be flagged
				"node .forge/tools/hooks/<name>.cjs",
				"record {paths.commands}/.forge/tools/{filename}.md",
				// biome-ignore lint: template literal example in prose
				"read .forge/init/discovery/discover-${domain}.md",
			].join("\n"),
			"utf8",
		);

		const { missing, refCount } = checkVendoredRefs(dir);
		expect(missing.size).toBe(0);
		expect(refCount).toBe(2);
	});
});

describe("real payload bootstrap has no dead vendored references", () => {
	it("every .forge/… reference in vendored content resolves post-bootstrap", () => {
		if (!fs.existsSync(path.join(REAL_PAYLOAD, "tools", "store-cli.cjs"))) {
			// dist/forge-payload not built — CI builds it before vitest; locally
			// run `npm run build` first. Nothing to assert against.
			return;
		}

		const dir = fs.mkdtempSync(path.join(tmpRoot, "real-"));
		const result = bootstrapClaudeProject({ dir, payloadRoot: REAL_PAYLOAD });
		expect(result.ok).toBe(true);

		const { missing, refCount, scannedFiles } = checkVendoredRefs(dir);
		const report = [...missing.entries()].map(([ref, sources]) => `${ref}  ← ${[...sources].join(", ")}`).join("\n");
		expect(missing.size, `dead vendored references:\n${report}`).toBe(0);
		expect(refCount).toBeGreaterThan(100);
		expect(scannedFiles).toBeGreaterThan(50);
	});
});
