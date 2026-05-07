/**
 * AC5 sibling-import proof — typechecks via `tsc --noEmit`.
 *
 * NOTE: Plan AC5 names `runChain` and `runParallel`, but pi-mono upstream
 * (SHA 3e5ad67e) does NOT expose these as named exports. Chain/parallel
 * logic lives inline within the default-exported tool's `execute` callback.
 * Only `discoverAgents` (re-exported through index.ts) and the default tool
 * registrar are importable as named symbols. Flagged in PROGRESS.md for
 * supervisor review — plan wording vs upstream reality mismatch.
 */

import registerSubagentTool, { discoverAgents } from "../../src/extensions/forgecli/subagent/index.js";
import type { AgentConfig, AgentScope } from "../../src/extensions/forgecli/subagent/agents.js";

void registerSubagentTool;
void discoverAgents;
const _scope: AgentScope = "user";
void _scope;
const _cfg: AgentConfig | undefined = undefined;
void _cfg;
