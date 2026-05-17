#!/usr/bin/env python3
"""Stage 2 — aggregate analysis of store-ops.jsonl.

Emits FINDINGS.md + top-failures.json.
"""
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median

IN  = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/store-ops.jsonl")
OUT_MD = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/FINDINGS.md")
OUT_JSON = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/top-failures.json")

recs = [json.loads(l) for l in open(IN)]

total = len(recs)
errors = [r for r in recs if r.get("isError")]
err_total = len(errors)
err_rate = err_total/total if total else 0

# channel breakdown
by_channel = Counter(r["channel"] for r in recs)
err_by_channel = Counter(r["channel"] for r in errors)

# subcommand breakdown
def sub_key(r): return f"{r['channel']}::{r['subcommand']}"
by_sub = Counter(sub_key(r) for r in recs)
err_by_sub = Counter(sub_key(r) for r in errors)

# error key breakdown
err_keys = Counter()
for r in errors:
    for k in r.get("errKeys", []):
        err_keys[k] += 1

# per-persona
by_persona = Counter(r["persona"] for r in recs)
err_by_persona = Counter(r["persona"] for r in errors)

# per-model
by_model = Counter(r["model"] for r in recs)
err_by_model = Counter(r["model"] for r in errors)

# template/describe pre-flight analysis
# group records per transcript in callIdx order; for each transcript:
#   note when first template/describe call appears vs first write/emit (success/failure)
preflight = defaultdict(lambda: {"first_template": None, "first_describe": None, "first_write": None, "first_failure": None})
by_tx = defaultdict(list)
for r in recs:
    by_tx[r["transcript"]].append(r)
for tx, ops in by_tx.items():
    ops.sort(key=lambda r: r["callIdx"])
    for r in ops:
        sub = r["subcommand"]
        idx = r["callIdx"]
        st = preflight[tx]
        if sub == "template" and st["first_template"] is None:
            st["first_template"] = idx
        if sub == "describe" and st["first_describe"] is None:
            st["first_describe"] = idx
        if sub in ("write","emit") and st["first_write"] is None:
            st["first_write"] = idx
        if r.get("isError") and st["first_failure"] is None:
            st["first_failure"] = idx

# tabulate pre-flight categories
pf_cat = Counter()
for tx, st in preflight.items():
    has_write = st["first_write"] is not None
    has_tpl   = st["first_template"] is not None
    has_desc  = st["first_describe"] is not None
    if not has_write:
        pf_cat["no_write_in_transcript"] += 1
        continue
    if not (has_tpl or has_desc):
        pf_cat["write_without_tpl_or_describe"] += 1
        continue
    if (st["first_template"] is not None and st["first_template"] < st["first_write"]) or \
       (st["first_describe"] is not None and st["first_describe"] < st["first_write"]):
        pf_cat["preflight_template_or_describe"] += 1
    elif st["first_failure"] is not None and (
        (st["first_template"] is not None and st["first_template"] > st["first_failure"]) or
        (st["first_describe"] is not None and st["first_describe"] > st["first_failure"])):
        pf_cat["reactive_template_or_describe_after_failure"] += 1
    else:
        pf_cat["tpl_or_describe_after_write_no_failure"] += 1

# retry pattern: per transcript, find consecutive (callIdx asc) error→success on same channel::subcommand
retry_events = []
for tx, ops in by_tx.items():
    ops_sorted = sorted(ops, key=lambda r: r["callIdx"])
    for i, r in enumerate(ops_sorted):
        if not r.get("isError"): continue
        key = sub_key(r)
        # search forward up to 10 calls for same key success
        for j in range(i+1, min(len(ops_sorted), i+11)):
            s = ops_sorted[j]
            if sub_key(s) == key and not s.get("isError"):
                retry_events.append({
                    "transcript": tx, "persona": r["persona"],
                    "key": key, "errKeys": r["errKeys"],
                    "distance": s["callIdx"] - r["callIdx"],
                })
                break

retry_distances = [e["distance"] for e in retry_events]

# sample bad-input examples per top errKey
err_samples = defaultdict(list)
for r in errors:
    for k in r["errKeys"]:
        if len(err_samples[k]) < 3:
            err_samples[k].append({
                "transcript": r["transcript"],
                "persona": r["persona"],
                "channel": r["channel"],
                "subcommand": r["subcommand"],
                "argShape": r["argShape"],
                "rawCmd": r["rawCmd"],
                "errSnippet": r["errSnippet"],
            })

# 3-arg write detection (bash-store-cli write entity ID json shape)
three_arg_write = []
for r in recs:
    if r["subcommand"] == "write" and r["argShape"]:
        if len(r["argShape"]) >= 3 and r["argShape"][0]=="ENTITY" and r["argShape"][1]=="ID":
            three_arg_write.append(r)

# emit-with-bare-string sprintId (synthetic) — find emit calls where first positional is not S-pattern ID
emit_bare = []
for r in recs:
    if r["subcommand"] == "emit" and r["argShape"]:
        first = r["argShape"][0] if r["argShape"] else None
        if first not in ("ID", None):
            emit_bare.append(r)

# Compose markdown
lines = []
lines.append(f"# Store-Op Friction Analysis — {total} ops across {len(by_tx)} transcripts\n")
lines.append(f"Failure rate: **{err_total}/{total} = {err_rate:.1%}**\n")

lines.append("## Channels\n")
lines.append("| Channel | Ops | Errors | Err% |")
lines.append("|---|---:|---:|---:|")
for ch,n in by_channel.most_common():
    e = err_by_channel.get(ch,0)
    lines.append(f"| `{ch}` | {n} | {e} | {(e/n if n else 0):.1%} |")
lines.append("")

lines.append("## Top subcommand failure rates (min 5 ops)\n")
lines.append("| Channel::Subcommand | Ops | Errors | Err% |")
lines.append("|---|---:|---:|---:|")
rows=[]
for k,n in by_sub.most_common():
    if n<5: continue
    e=err_by_sub.get(k,0)
    rows.append((k,n,e,(e/n if n else 0)))
rows.sort(key=lambda x:-x[3])
for k,n,e,p in rows[:25]:
    lines.append(f"| `{k}` | {n} | {e} | {p:.1%} |")
lines.append("")

lines.append("## Top normalized error keys\n")
lines.append("| Key | Count |")
lines.append("|---|---:|")
for k,n in err_keys.most_common(30):
    lines.append(f"| `{k}` | {n} |")
lines.append("")

lines.append("## Pre-flight pattern per transcript\n")
lines.append("| Pattern | Transcripts |")
lines.append("|---|---:|")
for k,n in pf_cat.most_common():
    lines.append(f"| `{k}` | {n} |")
lines.append("")

lines.append("## Retry behavior\n")
if retry_distances:
    lines.append(f"- Retry events (same subcmd succeeded after earlier failure within ≤10 calls): **{len(retry_events)}**")
    lines.append(f"- Distance min/median/max calls: {min(retry_distances)}/{int(median(retry_distances))}/{max(retry_distances)}")
else:
    lines.append("- No retry events detected within 10 calls.")
lines.append("")

# retry per errKey
retry_per_key = Counter()
for e in retry_events:
    for k in e["errKeys"]:
        retry_per_key[k] += 1
if retry_per_key:
    lines.append("### Retries by error key\n")
    lines.append("| errKey | retries succeeded |")
    lines.append("|---|---:|")
    for k,n in retry_per_key.most_common(15):
        lines.append(f"| `{k}` | {n} |")
    lines.append("")

lines.append("## Shape anti-patterns\n")
lines.append(f"- **3-arg write** (`write <entity> <id> <json>` — known-bad shape): **{len(three_arg_write)}** occurrences")
lines.append(f"- **emit with non-ID first positional** (synthetic/bare-string sprintId): **{len(emit_bare)}** occurrences")
lines.append("")

lines.append("## Persona breakdown\n")
lines.append("| Persona | Ops | Errors | Err% |")
lines.append("|---|---:|---:|---:|")
for p,n in by_persona.most_common():
    e=err_by_persona.get(p,0)
    lines.append(f"| `{p}` | {n} | {e} | {(e/n if n else 0):.1%} |")
lines.append("")

lines.append("## Model breakdown\n")
lines.append("| Model | Ops | Errors | Err% |")
lines.append("|---|---:|---:|---:|")
for m,n in by_model.most_common():
    e=err_by_model.get(m,0)
    lines.append(f"| `{m}` | {n} | {e} | {(e/n if n else 0):.1%} |")
lines.append("")

lines.append("## Error samples (top keys)\n")
for k,_ in err_keys.most_common(8):
    lines.append(f"### `{k}`\n")
    for s in err_samples[k][:2]:
        lines.append(f"- **{s['persona']}** / {s['channel']}::{s['subcommand']} / argShape={s['argShape']}")
        lines.append(f"  - cmd: `{s['rawCmd'][:200]}`")
        snip=(s['errSnippet'] or "").replace("\n"," / ")[:200]
        lines.append(f"  - err: `{snip}`")
    lines.append("")

OUT_MD.write_text("\n".join(lines))

# also dump top-failures.json for downstream
out={
    "total": total, "errors": err_total, "errRate": err_rate,
    "byChannel": dict(by_channel), "errByChannel": dict(err_by_channel),
    "topSubcommandFailures": [{"key":k,"ops":n,"errors":e,"errRate":p} for k,n,e,p in rows[:25]],
    "errKeys": err_keys.most_common(50),
    "preflightPattern": dict(pf_cat),
    "retryEvents": len(retry_events),
    "retryByErrKey": dict(retry_per_key),
    "threeArgWriteOccurrences": len(three_arg_write),
    "emitBareSprintOccurrences": len(emit_bare),
    "byPersona": [(p,by_persona[p],err_by_persona.get(p,0)) for p in by_persona],
    "byModel":   [(m,by_model[m],  err_by_model.get(m,0)) for m in by_model],
}
OUT_JSON.write_text(json.dumps(out, indent=2))

print(f"→ {OUT_MD} ({OUT_MD.stat().st_size} bytes)")
print(f"→ {OUT_JSON} ({OUT_JSON.stat().st_size} bytes)")
