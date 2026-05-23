// forge-init/prompts.ts — phase prompt text builders (FORGE-S25-T23, B-4)
//
// Centralises the LLM prompt strings sent to the agent via `sendToAgent` during init phases.
// Keeping these out of forge-init.ts makes the orchestration logic easier to read and the
// prompt text easier to iterate on independently.

import * as path from "node:path";

/**
 * Build the Phase 1 prompt: instructs the agent to run 5 parallel discovery scans
 * and synthesize results into `.forge/config.json`.
 */
export function buildPhase1PromptText(bundleRoot: string, projectName: string): string {
	const discoveryDir = path.join(bundleRoot, ".init", "discovery");
	const topics = ["stack", "processes", "database", "routing", "testing"];
	const topicLines = topics.map((t) => `  • ${path.join(discoveryDir, `discover-${t}.md`)}`).join("\n");

	return `## /forge:init Phase 1 — Collect: 5 parallel discovery scans

Project: ${projectName}

Run 5 discovery scans concurrently. In a single response, issue 5 parallel tool
calls — one per discovery topic — using whatever read/search tools you have
available (Read, Glob, Grep, Bash). If a \`subagent\` tool is exposed in your
toolset, you MAY dispatch via it (mode: "parallel"); otherwise execute the
scans inline. Do NOT preface with "I don't have a subagent tool" — either path
is acceptable, what matters is concurrency and the resulting deliverable.

For each topic:
1. Read the discovery prompt file at its assigned path (shown below)
2. Analyze the current project codebase
3. Capture structured findings

Discovery prompt files:
${topicLines}

After all 5 complete, synthesize the findings into a unified config and write .forge/config.json.

Required .forge/config.json structure:
{
  "version": "1",
  "project": { "name": "${projectName}", "prefix": "<UPPERCASE_ABBREV>" },
  "stack": { "primary": [...], "test": <framework>, "build": <tool>, "lint": <tool> },
  "commands": { "test": "<test cmd>", "build": "<build cmd>", "lint": "<lint cmd>" },
  "paths": {
    "engineering": "engineering",
    "store": ".forge/store",
    "workflows": ".forge/workflows",
    "commands": ".claude/commands/forge",
    "templates": ".forge/templates"
  }
}

Write the config with: node "${path.join(bundleRoot, "tools/manage-config.cjs")}" set <key> <value>
Or write .forge/config.json directly as valid JSON.`;
}

/**
 * Build the Phase 2 prompt: instructs the agent to generate 7 parallel KB docs
 * under `kbPath/architecture/`.
 */
export function buildPhase2PromptText(bundleRoot: string, kbPath: string, projectName: string): string {
	const generateKbDocPath = path.join(bundleRoot, ".init", "generation", "generate-kb-doc.md");
	const docs = ["stack", "processes", "database", "routing", "deployment", "entity-model", "stack-checklist"];
	const docLines = docs.map((d) => `  • ${kbPath}/architecture/${d}.md`).join("\n");

	return `## /forge:init Phase 2 — Discover: 7 parallel KB doc generation

Project: ${projectName}
KB path: ${kbPath}/
Rulebook: ${generateKbDocPath}

Generate 7 knowledge-base documents concurrently. In a single response, issue
7 parallel tool calls — one per document — using whatever read/search/write
tools you have available (Read, Glob, Grep, Bash, Write). If a \`subagent\`
tool is exposed in your toolset, you MAY dispatch via it (mode: "parallel");
otherwise execute the generation inline. Do NOT preface with "I don't have a
subagent tool" — either path is acceptable, what matters is concurrency and
the 7 output files.

For each document:
1. Read the rulebook at: ${generateKbDocPath}
2. Analyze the project codebase for its assigned topic
3. Write the resulting document to its assigned output file

Documents to generate:
${docLines}

After all complete, check for any that returned "FAILED:" in their output — retry those once.

Also create these index files after generation:
- ${kbPath}/architecture/INDEX.md
- ${kbPath}/business-domain/INDEX.md
- ${kbPath}/MASTER_INDEX.md (scaffold)`;
}
