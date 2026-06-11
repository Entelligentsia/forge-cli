// fixture-manifest.ts — shared payload-manifest.json writer for the synthetic
// bootstrap/uninstall test fixtures (FORGE-S32-T03).
//
// The manifest-driven consumers (bootstrap.ts vendor loop, uninstall.ts removal
// grouping) read payloadRoot/payload-manifest.json. The minimal test payloads
// describe a representative subset of the real layout; this helper writes a
// manifest whose selects reproduce exactly what the legacy hard-coded steps
// vendored, so the existing idempotency / parity assertions hold. The entry
// ORDER preserves the commands-union precedence: the loser `commands/` entry
// precedes the winner `.base-pack/commands/`.

import * as fs from "node:fs";
import * as path from "node:path";

export function writeFixtureManifest(payloadRoot: string): void {
	const manifest = {
		_doc: "Synthetic test manifest (FORGE-S32-T03 fixture).",
		entries: [
			{
				source: "tools",
				kind: "dir",
				bundle: "tools/",
				install: ".forge/tools/",
				owner: "forge-scaffold",
				select: { recursive: false, ext: [".cjs", ".js"] },
			},
			{
				source: "tools/package.json",
				kind: "file",
				bundle: "tools/package.json",
				install: ".forge/tools/",
				owner: "forge-scaffold",
			},
			{
				source: "tools/lib",
				kind: "dir",
				bundle: "tools/lib/",
				install: ".forge/tools/lib/",
				owner: "forge-scaffold",
				select: { recursive: false, ext: [".cjs", ".js"] },
			},
			{
				source: "hooks",
				kind: "dir",
				bundle: "hooks/",
				install: ".forge/tools/hooks/",
				owner: "forge-scaffold",
				select: { recursive: false, ext: [".cjs", ".js"], exclude: ["hooks.json"] },
			},
			{
				source: "hooks/lib",
				kind: "dir",
				bundle: "hooks/lib/",
				install: ".forge/tools/hooks/lib/",
				owner: "forge-scaffold",
				select: { recursive: false, ext: [".cjs", ".js"] },
			},
			{
				source: "schemas",
				kind: "dir",
				bundle: "schemas/",
				install: ".forge/schemas/",
				owner: "forge-scaffold",
				select: { recursive: true, ext: [".json"], exclude: ["__tests__"] },
			},
			{
				source: "commands",
				kind: "dir",
				bundle: "commands/",
				install: ".claude/commands/forge/",
				owner: "claude-commands",
				select: { recursive: false, ext: [".md"] },
			},
			{
				source: "init/base-pack",
				kind: "dir",
				bundle: ".base-pack/",
				install: ".forge/.base-pack/",
				owner: "forge-scaffold",
				select: { recursive: true },
			},
			{
				source: "init/base-pack/commands",
				kind: "dir",
				bundle: ".base-pack/commands/",
				install: ".claude/commands/forge/",
				owner: "claude-commands",
				select: { recursive: false, ext: [".md"] },
			},
			{
				source: "init/base-pack/workflows-js",
				kind: "dir",
				bundle: ".base-pack/workflows-js/",
				install: ".claude/workflows/",
				owner: "workflows",
				select: { recursive: false, ext: [".js"], prefix: ["wfl-"] },
			},
			{
				source: "init/phases",
				kind: "dir",
				bundle: "init/phases/",
				install: ".forge/init/phases/",
				owner: "forge-scaffold",
				select: { recursive: false, ext: [".md"] },
			},
			{
				source: "meta",
				kind: "dir",
				bundle: "meta/",
				install: ".forge/meta/",
				owner: "forge-scaffold",
				select: { recursive: true },
			},
			{
				source: ".claude-plugin/plugin.json",
				kind: "file",
				bundle: ".claude-plugin/plugin.json",
				install: ".forge/.claude-plugin/",
				owner: "forge-scaffold",
			},
			{
				source: "agents",
				kind: "dir",
				bundle: "agents/",
				install: ".claude/agents/",
				owner: "claude-assets",
				select: { recursive: false, ext: [".md"] },
			},
			{
				source: "skills",
				kind: "dir",
				bundle: "skills/",
				install: ".claude/skills/",
				owner: "claude-assets",
				select: { include: ["refresh-kb-links", "store-custodian", "store-query-grammar", "store-query-nlp"] },
			},
			{
				source: "integrity.json",
				kind: "file",
				bundle: "integrity.json",
				bundleOnly: true,
				owner: "forge-scaffold",
			},
		],
	};
	fs.writeFileSync(path.join(payloadRoot, "payload-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
