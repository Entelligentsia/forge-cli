// Workflow definition (parsed from YAML)
export interface WorkflowDef {
  id:          string;
  version:     number;
  description?: string;
  nodes:       NodeDef[];
  edges:       EdgeDef[];
}

export interface NodeDef {
  id:       string;
  prompt:   string;            // path relative to workflow dir
  loop?:    LoopSpec;
  expects:  ExpectsSpec;
}

export interface LoopSpec {
  over:               string;  // dotted-path into state, e.g. "sources"
  alias:              string;  // e.g. "loop.item"
  alsoEmitsItemId?:   boolean;
}

export interface ExpectsSpec {
  success: {
    writes?: {
      state?:    string[];                          // dotted-paths the node may write
      artifact?: { pattern: string };               // path template the node may write
    };
  };
  failure: {
    // intentionally empty — failure events have a fixed shape (reason/details)
  };
}

export interface EdgeDef {
  from:      string;
  on:        "success" | "failure";
  to?:       string;
  halt?:     string;
  terminal?: "complete";
  advance?:  "loop-or-next";
  next?:     string;    // for advance: loop-or-next, what to go to after loop end
}

// Runtime state (persisted as state.json)
export interface RuntimeState {
  cursor:       string;                            // current node id
  loopCursor:   Record<string, number>;            // per-node loop iter
  entryPrompt?: string;
  [key: string]: unknown;                          // accumulated state writes
}

// Events (parsed from LLM response + emitted by engine)
export interface Event {
  eventId:    string;
  nodeExecId: string;
  type:       "started" | "progress" | "success" | "failure"
            | "workflow.started" | "workflow.completed" | "workflow.halted"
            | "node.dispatched" | "node.committed" | "node.remit-violation";
  ts:         string;     // ISO timestamp
  // optional payload
  writes?: {
    state?:    Record<string, unknown>;
    artifact?: { path: string; content: string };
  };
  summary?: string;
  reason?:  string;
  details?: string;
  // engine-emitted only
  workflowId?:   string;
  instanceId?:   string;
  violatedRule?: string;
}
