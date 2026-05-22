#!/usr/bin/env python3
"""Drill into illegal-transition failures + analyze update-status retry behaviour."""
import json, re
from pathlib import Path
from collections import Counter, defaultdict

IN = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/store-ops.jsonl")
OUT_MD = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/TRANSITION-DRILL.md")
TX_DIR = Path("/home/boni/src/forge-engineering/tmp/transcripts/hello")

# legal task transitions (mirror store-cli.cjs:161)
LEGAL_TASK = {
    "draft":                 ["planned","plan-revision-required","code-revision-required","blocked","escalated","abandoned"],
    "planned":               ["plan-approved","implemented","plan-revision-required","code-revision-required","blocked","escalated","abandoned"],
    "plan-approved":         ["implementing","plan-revision-required","code-revision-required","blocked","escalated","abandoned"],
    "implementing":          ["implemented","plan-revision-required","code-revision-required","blocked","escalated","abandoned"],
    "implemented":           ["review-approved","plan-revision-required","code-revision-required","blocked","escalated","abandoned"],
    "review-approved":       ["approved","plan-revision-required","code-revision-required","blocked","escalated","abandoned"],
    "approved":              ["committed","plan-revision-required","code-revision-required","blocked","escalated","abandoned"],
    "plan-revision-required":["planned","blocked","escalated","abandoned"],
    "code-revision-required":["implementing","blocked","escalated","abandoned"],
}

recs = [json.loads(l) for l in open(IN)]
us_errs = [r for r in recs if r["subcommand"]=="update-status" and r["isError"]]

RE_ILLEGAL = re.compile(r"Illegal transition:\s*(\w+)\s+\S+\s+\w+:\s*(\S+)\s*→\s*(\S+)")

# parse each illegal-transition error
attempts = []  # {entity, from, to, transcript, persona, callIdx}
for r in us_errs:
    m = RE_ILLEGAL.search(r["errSnippet"] or "")
    if not m: continue
    ent, frm, to = m.group(1), m.group(2), m.group(3)
    attempts.append({
        "entity": ent, "from": frm, "to": to,
        "transcript": r["transcript"], "persona": r["persona"],
        "callIdx": r["callIdx"],
    })

# top attempts
attempt_keys = Counter((a["entity"], a["from"], a["to"]) for a in attempts)
# group by FROM state — what's the agent in vs trying to reach
by_from = defaultdict(Counter)
for a in attempts:
    if a["entity"] == "task":
        by_from[a["from"]][a["to"]] += 1

# correlate: agents in plan-approved trying to reach implemented — should be implementing instead
def shortest_path(start, end):
    """BFS through LEGAL_TASK to find minimum sequence."""
    if start == end: return [start]
    from collections import deque
    q = deque([(start, [start])])
    seen = {start}
    while q:
        node, path = q.popleft()
        for nxt in LEGAL_TASK.get(node, []):
            if nxt == end: return path + [nxt]
            if nxt in seen: continue
            seen.add(nxt)
            q.append((nxt, path + [nxt]))
    return None

L = []
L.append(f"# Illegal-Transition Drill — {len(us_errs)} failed update-status calls\n")
L.append(f"Parsed illegal transitions: **{len(attempts)}**\n")

L.append("## Top illegal task-transitions attempted\n")
L.append("| From | To | Count | Shortest legal path |")
L.append("|---|---|---:|---|")
for (ent,frm,to),n in attempt_keys.most_common(20):
    if ent != "task":
        L.append(f"| `{ent}::{frm}` | `{to}` | {n} | (non-task) |")
        continue
    path = shortest_path(frm, to)
    path_s = " → ".join(path) if path else "**NO LEGAL PATH**"
    L.append(f"| `{frm}` | `{to}` | {n} | `{path_s}` |")
L.append("")

L.append("## Per source-state: where agents try to go\n")
for frm in sorted(by_from.keys()):
    L.append(f"### From `{frm}`")
    L.append("")
    L.append(f"- Legal destinations: `{'`, `'.join(LEGAL_TASK.get(frm,[]))}`")
    L.append("- Agent attempts (illegal):")
    for to,n in by_from[frm].most_common():
        L.append(f"  - `{to}` × {n} — fix: `{' → '.join(shortest_path(frm,to) or ['NO_PATH'])}`")
    L.append("")

# specifically: how often did agent succeed AFTER illegal-transition fail?
# Did they walk the intermediate state, or did they use --force?
forced = 0
walked = 0
unresolved = 0
for r in us_errs:
    tx_recs = [x for x in recs if x["transcript"]==r["transcript"]]
    tx_recs.sort(key=lambda x: x["callIdx"])
    # find subsequent update-status on same entity after this one
    idx = r["callIdx"]
    later = [x for x in tx_recs if x["callIdx"]>idx and x["subcommand"]=="update-status"][:5]
    # crude: look for --force flag in rawCmd of subsequent, OR successful chain of single-step transitions
    saw_force = any("--force" in (x["rawCmd"] or "") for x in later)
    saw_success_chain = any((not x["isError"]) for x in later)
    if saw_force: forced += 1
    elif saw_success_chain: walked += 1
    else: unresolved += 1

L.append("## Recovery behaviour after illegal-transition failure\n")
L.append(f"- Walked intermediate state(s) to legal destination: **{walked}**")
L.append(f"- Used `--force` to bypass: **{forced}**")
L.append(f"- No recovery (gave up or sprint ended): **{unresolved}**")
L.append("")

OUT_MD.write_text("\n".join(L))
print(f"→ {OUT_MD}")
