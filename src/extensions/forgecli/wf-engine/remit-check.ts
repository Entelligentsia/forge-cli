import type { Event, NodeDef } from "./types.js";

export interface RemitCheckResult {
  ok: boolean;
  violations: string[];
}

export function checkRemit(
  emitted: Event[],
  node: NodeDef,
  loopItemId?: string
): RemitCheckResult {
  const violations: string[] = [];

  // Must have started + exactly one terminal
  const startedCount = emitted.filter(e => e.type === "started").length;
  if (startedCount !== 1) violations.push(`expected exactly 1 'started' event, got ${startedCount}`);

  const terminals = emitted.filter(e => e.type === "success" || e.type === "failure");
  if (terminals.length !== 1) violations.push(`expected exactly 1 terminal event (success/failure), got ${terminals.length}`);

  if (terminals.length === 1) {
    const term = terminals[0];
    if (term.type === "success" && term.writes?.artifact) {
      const pattern = node.expects.success.writes?.artifact?.pattern;
      if (!pattern) {
        violations.push(`node emitted artifact but expects.success.writes.artifact not declared`);
      } else {
        const resolved = pattern.replace(/\{loop\.item\.id\}/g, loopItemId ?? "");
        if (term.writes.artifact.path !== resolved) {
          violations.push(`artifact path '${term.writes.artifact.path}' does not match declared pattern '${resolved}'`);
        }
      }
    }

    if (term.type === "success" && term.writes?.state) {
      const allowed = node.expects.success.writes?.state ?? [];
      for (const key of Object.keys(term.writes.state)) {
        const matched = allowed.some(a => {
          const resolved = a.replace(/\{loop\.item\.id\}/g, loopItemId ?? "");
          return resolved === key;
        });
        if (!matched) {
          violations.push(`state write '${key}' not in declared expects.success.writes.state`);
        }
      }
    }

    if (term.type === "failure" && (!term.reason || typeof term.reason !== "string")) {
      violations.push(`failure event missing 'reason' string`);
    }
  }

  return { ok: violations.length === 0, violations };
}
