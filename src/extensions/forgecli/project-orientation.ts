// Project orientation block.
//
// Single source of truth for the orientation prepended to every model system
// prompt forge-cli dispatches to — both subagent (`runForgeSubagent`) and
// main-thread (`pi.on("before_agent_start")`). Philosophy: context, not
// enforcement. We give the model the project context it needs so its work
// stays focused; we do not restrict its tools.
//
// See Entelligentsia/forge-cli#6 and Entelligentsia/forge#83.

import * as fs from "node:fs";
import * as path from "node:path";

// Walk up from cwd to find .forge/config.json. Returns absolute path or undefined.
function findUpConfigJson(cwd: string): string | undefined {
	let dir = cwd;
	for (let i = 0; i < 20; i++) {
		const candidate = path.join(dir, ".forge", "config.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export function buildProjectOrientation(cwdAbs: string): string {
	// Resolve FORGE_ROOT from .forge/config.json so subagent bash sessions
	// get the absolute path instead of the unresolved $FORGE_ROOT variable.
	// Subagent processes do NOT inherit FORGE_ROOT from the parent environment.
	let resolvedForgeRoot = "$FORGE_ROOT";
	try {
		const configPath = findUpConfigJson(cwdAbs);
		if (configPath) {
			const raw = fs.readFileSync(configPath, "utf8");
			const config = JSON.parse(raw);
			const forgeRoot = config?.paths?.forgeRoot;
			if (typeof forgeRoot === "string") {
				resolvedForgeRoot = path.resolve(path.dirname(configPath), forgeRoot);
			}
		}
	} catch {
		// Fall through with $FORGE_ROOT placeholder
	}

	return [
		"## Project Orientation",
		"",
		`Your project root is \`${cwdAbs}\`. Your current working directory is set there.`,
		"",
		"- Forge config: `.forge/config.json` (relative to cwd). The `forge_config` MCP tool returns canonical values.",
		"- Engineering knowledge: `engineering/` (relative to cwd) — MASTER_INDEX.md, architecture/, business-domain/, sprints/, features/.",
		"- Relative paths in your task resolve against this cwd.",
		"",
		"## Forge Tools (canonical shapes)",
		"",
		`$FORGE_ROOT resolves to \`${resolvedForgeRoot}\`.`,
		"",
		`- Store read:   \`node "${resolvedForgeRoot}/tools/store-cli.cjs" read <entity> <id>\``,
		`- Store list:   \`node "${resolvedForgeRoot}/tools/store-cli.cjs" list <entity>\``,
		`- Store write:  \`node "${resolvedForgeRoot}/tools/store-cli.cjs" write <entity> '<json>'\`  (id INSIDE json)`,
		`- Update status: \`node "${resolvedForgeRoot}/tools/store-cli.cjs" update-status <entity> <id> <status>\``,
		`- Emit event:   \`node "${resolvedForgeRoot}/tools/store-cli.cjs" emit <sprintId> '<json>' [--sidecar]\``,
		`- Help anytime: \`node "${resolvedForgeRoot}/tools/store-cli.cjs" --help\``,
		"",
		"store-cli verbs: read | list | write | emit | update-status | set-summary | describe | nlp | query | delete — there is no get/set/find.",
		"",
		"## Forge Paths",
		"",
		"- Workflow fragments: `.forge/workflows/_fragments/` (NOT `.forge/_fragments/`)",
		"- Personas:           `.forge/personas/`",
		"- Templates:          `.forge/templates/`",
		"- Sprint artifacts:   `engineering/sprints/<SPRINT_ID>/<TASK_ID>/`",
		"",
		"## Forge MCP tools",
		"",
		"Prefer named MCP tools over bash where available — they carry typed argument schemas the runtime validates for you:",
		"",
		"- `forge_config` — read/write `.forge/config.json` keys",
		"- `forge_store`  — read / write / list / emit  (id INSIDE json)",
		"",
	].join("\n");
}