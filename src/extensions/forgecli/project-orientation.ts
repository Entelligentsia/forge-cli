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
	].join("\n");
}
