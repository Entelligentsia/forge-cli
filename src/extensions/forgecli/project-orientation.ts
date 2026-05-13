// Project orientation block.
//
// Single source of truth for the orientation prepended to every model system
// prompt forge-cli dispatches to — both subagent (`runForgeSubagent`) and
// main-thread (`pi.on("before_agent_start")`). Philosophy: context, not
// enforcement. We give the model the project context it needs so its work
// stays focused; we do not restrict its tools.
//
// See Entelligentsia/forge-cli#6 and Entelligentsia/forge#83.

export function buildProjectOrientation(cwdAbs: string): string {
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
		"`$FORGE_ROOT` resolves from `.forge/config.json` `paths.forgeRoot`.",
		"",
		'- Store read:   `node "$FORGE_ROOT/tools/store-cli.cjs" read <entity> <id>`',
		"- Store list:   `node \"$FORGE_ROOT/tools/store-cli.cjs\" list <entity>`",
		"- Store write:  `node \"$FORGE_ROOT/tools/store-cli.cjs\" write <entity> '<json>'`  (id INSIDE json)",
		"- Update status: `node \"$FORGE_ROOT/tools/store-cli.cjs\" update-status <entity> <id> <status>`",
		"- Emit event:   `node \"$FORGE_ROOT/tools/store-cli.cjs\" emit <sprintId> '<json>' [--sidecar]`",
		"- Help anytime: `node \"$FORGE_ROOT/tools/store-cli.cjs\" --help`",
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
