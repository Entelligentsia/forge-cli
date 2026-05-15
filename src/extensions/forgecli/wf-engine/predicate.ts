export interface PredicateContext {
  state: unknown;
  loop?: { item: unknown };
}

const OP_RE = /^(\S+)\s+(==|!=|<=|>=|<|>)\s+(.+)$/;

export function evalPredicate(expr: string, ctx: PredicateContext): boolean {
  const trimmed = expr.trim();
  const m = trimmed.match(OP_RE);
  if (!m) throw new Error(`predicate: cannot parse '${expr}' — expected '<path> <op> <literal>'`);
  const [, lhsPath, op, rhsLit] = m;

  const lhs = resolvePath({ state: ctx.state, loop: ctx.loop }, lhsPath);
  let rhs: unknown;
  try {
    rhs = JSON.parse(rhsLit);
  } catch {
    throw new Error(`predicate: rhs '${rhsLit}' is not a valid JSON literal`);
  }

  switch (op) {
    case "==": return lhs === rhs;
    case "!=": return lhs !== rhs;
    case "<":  return (lhs as number) <  (rhs as number);
    case "<=": return (lhs as number) <= (rhs as number);
    case ">":  return (lhs as number) >  (rhs as number);
    case ">=": return (lhs as number) >= (rhs as number);
    default:   throw new Error(`predicate: unsupported op '${op}'`);
  }
}

function resolvePath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
