#!/usr/bin/env python3
"""Drill into emit failures — extract intended payloads, group by shape, map to fix.

For every failed emit:
- parse JSON payload (if extractable from rawCmd)
- record which fields the agent provided vs missing
- detect 'type' value (event-class indicator) to learn what event class was intended
- output: emit-intent-map.json + EMIT-DRILL.md
"""
import json, re
from pathlib import Path
from collections import Counter, defaultdict

IN  = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/store-ops.jsonl")
OUT_MD   = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/EMIT-DRILL.md")
OUT_JSON = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/emit-intent-map.json")

# need full message corpus to recover entire JSON payload (rawCmd truncated to 400)
TX_DIR = Path("/home/boni/src/forge-engineering/tmp/transcripts/hello")

recs = [json.loads(l) for l in open(IN)]
emit_errs = [r for r in recs if r["subcommand"]=="emit" and r["isError"]]

# index transcripts → messages so we can recover full cmd
tx_cache = {}
def load_tx(name):
    if name in tx_cache: return tx_cache[name]
    # walk both root + _archive
    for p in (TX_DIR / name, TX_DIR / "_archive" / name):
        if p.exists():
            tx_cache[name] = json.load(open(p))
            return tx_cache[name]
    tx_cache[name] = None
    return None

def recover_cmd(rec):
    """Find the toolCall by callIdx in the source transcript and return full bash command."""
    tx = load_tx(rec["transcript"])
    if not tx: return None
    msgs = tx.get("messages",[])
    idx = rec["callIdx"]
    if idx >= len(msgs): return None
    m = msgs[idx]
    c = m.get("content")
    if not isinstance(c, list): return None
    for x in c:
        if isinstance(x,dict) and x.get("type")=="toolCall":
            a = x.get("arguments") or {}
            if isinstance(a, dict): return a.get("command","")
    return None

RE_EMIT_JSON = re.compile(r"emit\s+(\S+)\s+'(.+?)'\s*(?:--sidecar|$|\|)", re.DOTALL)

def extract_payload(cmd):
    """Return (sprintIdArg, payload_dict) or (sprintIdArg, None) on parse fail."""
    if not cmd: return (None, None)
    m = RE_EMIT_JSON.search(cmd)
    if not m: return (None, None)
    sprint_arg = m.group(1)
    raw = m.group(2)
    try:
        return (sprint_arg, json.loads(raw))
    except Exception:
        return (sprint_arg, None)

# aggregate
type_intents     = Counter()           # what 'type' value agents passed when emit failed
field_sets       = Counter()           # frozenset of fields agents DID provide
field_missing    = Counter()           # field name agents OMITTED
type_to_fields   = defaultdict(Counter)  # per intended type, which fields agents tried
sprintid_shapes  = Counter()           # sprint arg shape (e.g. "S01" vs "HLO-S01" vs "FORGE-BUG-002")
phase_intents    = Counter()           # value passed for 'phase'
action_intents   = Counter()           # value passed for 'action'

parsed = 0; unparsed = 0
parsed_examples = []
unparsed_examples = []

REQUIRED = {"eventId","sprintId","role","action","startTimestamp","endTimestamp",
            "durationMinutes","model","provider"}

for r in emit_errs:
    cmd = recover_cmd(r)
    sprint_arg, payload = extract_payload(cmd)
    if sprint_arg:
        sprintid_shapes[sprint_arg] += 1
    if payload is None:
        unparsed += 1
        if len(unparsed_examples) < 5:
            unparsed_examples.append({"transcript": r["transcript"], "cmd": (cmd or "")[:300]})
        continue
    parsed += 1
    fields = frozenset(payload.keys())
    field_sets[fields] += 1
    missing = REQUIRED - fields
    for fm in missing:
        field_missing[fm] += 1
    t = payload.get("type")
    if t: type_intents[str(t)] += 1
    if t:
        for f in payload.keys():
            type_to_fields[str(t)][f] += 1
    if "phase" in payload:
        phase_intents[str(payload["phase"])] += 1
    if "action" in payload:
        action_intents[str(payload["action"])] += 1
    if len(parsed_examples) < 8:
        parsed_examples.append({
            "transcript": r["transcript"],
            "persona": r["persona"],
            "sprint_arg": sprint_arg,
            "type": t,
            "fields_provided": sorted(fields),
            "fields_missing": sorted(missing),
            "errSnippet": r["errSnippet"],
        })

# build markdown
L = []
L.append(f"# Emit-Failure Deep Drill — {len(emit_errs)} failed emits\n")
L.append(f"- Parsed payload: **{parsed}**\n- Unparsed (rawCmd truncated / multiline / quoting): **{unparsed}**\n")

L.append("## Intended event 'type' values (agent's mental model of event class)\n")
L.append("| `type` value | count |")
L.append("|---|---:|")
for t,n in type_intents.most_common(20):
    L.append(f"| `{t}` | {n} |")
L.append("")

L.append("## sprintId argument shape used in failed emits\n")
L.append("| sprint arg | count |")
L.append("|---|---:|")
for s,n in sprintid_shapes.most_common(15):
    L.append(f"| `{s}` | {n} |")
L.append("")

L.append("## Required schema fields agents OMITTED (failed emits)\n")
L.append("| field | omissions |")
L.append("|---|---:|")
for f,n in field_missing.most_common():
    L.append(f"| `{f}` | {n} |")
L.append("")

L.append("## 'phase' values agents passed\n")
L.append("| phase | count |")
L.append("|---|---:|")
for p,n in phase_intents.most_common(15):
    L.append(f"| `{p}` | {n} |")
L.append("")

L.append("## 'action' values agents passed\n")
L.append("| action | count |")
L.append("|---|---:|")
for a,n in action_intents.most_common(15):
    L.append(f"| `{a}` | {n} |")
L.append("")

L.append("## Per intended-type: fields agents WANTED to use\n")
for t,_ in type_intents.most_common(5):
    L.append(f"### type=`{t}`\n")
    L.append("| field | times included |")
    L.append("|---|---:|")
    for f,n in type_to_fields[t].most_common(20):
        L.append(f"| `{f}` | {n} |")
    L.append("")

L.append("## Sample parsed failed emits\n")
for ex in parsed_examples:
    L.append(f"- **{ex['persona']}** type=`{ex['type']}` sprint=`{ex['sprint_arg']}`")
    L.append(f"  - provided: {ex['fields_provided']}")
    L.append(f"  - missing: {ex['fields_missing']}")
    L.append(f"  - err: `{(ex['errSnippet'] or '').replace(chr(10),' / ')[:200]}`")
L.append("")

if unparsed_examples:
    L.append("## Sample unparsed (parser limitation, JSON in cmd may span lines)\n")
    for ex in unparsed_examples:
        L.append(f"- {ex['transcript']}: `{ex['cmd'][:160]}`")
    L.append("")

OUT_MD.write_text("\n".join(L))

OUT_JSON.write_text(json.dumps({
    "total_emit_failures": len(emit_errs),
    "parsed": parsed,
    "unparsed": unparsed,
    "type_intents": type_intents.most_common(),
    "sprintid_shapes": sprintid_shapes.most_common(),
    "field_missing": field_missing.most_common(),
    "phase_intents": phase_intents.most_common(),
    "action_intents": action_intents.most_common(),
    "per_type_fields": {t: c.most_common() for t,c in type_to_fields.items()},
}, indent=2))

print(f"→ {OUT_MD}")
print(f"→ {OUT_JSON}")
