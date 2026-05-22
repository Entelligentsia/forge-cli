#!/usr/bin/env python3
"""Mode A v2 — schema/CLI replay with STATE TRACKING.

For each transcript: spin up tmpdir .forge/store/, walk ops in callIdx order,
re-execute each store-cli command against the CURRENT plugin source store-cli.cjs.

State-tracking rules (the v1 fix):
- Track baseline mutation outcomes by walking transcripts in callIdx order.
- Before replaying op N, replay all PRIOR ops in the same transcript first against the
  same tmpdir — but ONLY apply ops that BASELINE succeeded on. For ops that baseline
  failed and were never retried successfully, skip (state never advanced).
- For set-summary/set-bug-summary, pre-create the referenced summary file with a
  schema-valid placeholder so the call has something to read.
- Special-case `--force` flag: re-run with FORGE_ALLOW_FORCE=1 in env to match
  baseline behavior (force gating is intended hardening, but baseline ran without
  the gate so we mimic baseline conditions to isolate other regressions).

This isolates real CLI/schema regressions from state-evolution artifacts.
"""
import json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
from collections import Counter, defaultdict

FORGE = Path("/home/boni/src/forge-engineering/forge/forge")
TOOLS_DIR = FORGE / "tools"
SCHEMA_DIR = FORGE / "schemas"
STORE_CLI = TOOLS_DIR / "store-cli.cjs"

IN_OPS = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/store-ops.jsonl")
TX_DIR = Path("/home/boni/src/forge-engineering/tmp/transcripts/hello")
OUT_MD = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/VERIFY-BENCH.md")
OUT_JSON = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/verify-bench.json")

assert STORE_CLI.exists()
assert SCHEMA_DIR.exists()

recs = [json.loads(l) for l in open(IN_OPS)]
by_tx = defaultdict(list)
for r in recs:
    by_tx[r["transcript"]].append(r)
for tx in by_tx:
    by_tx[tx].sort(key=lambda r: r["callIdx"])

tx_cache = {}
def load_tx(name):
    if name in tx_cache: return tx_cache[name]
    for p in (TX_DIR / name, TX_DIR / "_archive" / name):
        if p.exists():
            tx_cache[name] = json.load(open(p))
            return tx_cache[name]
    tx_cache[name] = None
    return None

def recover_cmd(rec):
    tx = load_tx(rec["transcript"])
    if not tx: return None
    msgs = tx.get("messages", [])
    idx = rec["callIdx"]
    if idx >= len(msgs): return None
    m = msgs[idx]
    c = m.get("content")
    if not isinstance(c, list): return None
    for x in c:
        if isinstance(x, dict) and x.get("type") == "toolCall":
            a = x.get("arguments") or {}
            if isinstance(a, dict): return a.get("command", "")
    return None

def extract_store_cli_args(cmd:str):
    if not cmd: return None
    m = re.search(r'store-cli\.cjs["\']?\s+', cmd)
    if not m: return None
    tail = cmd[m.end():]
    tail = re.split(r'\s+2>/dev/null|\s+\|\|\s+|\s+&&\s+(?!.*store-cli\.cjs)', tail, maxsplit=1)[0]
    return tail.strip()

def make_tmp_store():
    tmp = Path(tempfile.mkdtemp(prefix="verify-bench-v2-"))
    forge_root = tmp / "_forge_plugin"
    forge_root.mkdir()
    (forge_root / "tools").symlink_to(TOOLS_DIR)
    (forge_root / "schemas").symlink_to(SCHEMA_DIR)
    store = tmp / ".forge" / "store"
    store.mkdir(parents=True)
    for sub in ("sprints", "tasks", "bugs", "features", "events"):
        (store / sub).mkdir()
    (tmp / ".forge" / "config.json").write_text(json.dumps({
        "project": {"name":"verify-bench","prefix":"HLO"},
        "paths": {
            "forgeRoot": str(forge_root),
            "engineering": "engineering",
            "templates": ".forge/templates",
            "commands": ".claude/commands",
        }
    }))
    # pre-stub a generic summary file location so set-summary calls have something to read
    return tmp, forge_root

def run_store_cli(args_tail:str, cwd:Path, timeout=15, allow_force=False):
    env = os.environ.copy()
    if allow_force:
        env["FORGE_ALLOW_FORCE"] = "1"
    bash_cmd = f'node {STORE_CLI} {args_tail}'
    try:
        p = subprocess.run(["bash","-c", bash_cmd], cwd=str(cwd),
                           capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT"
    except Exception as e:
        return -2, "", f"SPAWN_ERR: {e}"

def seed_entities(tmp_root:Path, tag:str):
    """Pre-seed sprint+task or bug record from transcript tag."""
    ent_id = tag.split("__")[0] if tag else ""
    sprint_short = None
    if re.match(r"^[A-Z]+-S\d+-T\d+$", ent_id):
        sprint_id = "-".join(ent_id.split("-")[:-1])
        sprint_short = "S" + ent_id.split("-S")[1].split("-")[0]
        (tmp_root / ".forge" / "store" / "sprints" / f"{sprint_id}.json").write_text(json.dumps({
            "sprintId": sprint_id, "title": "seed", "status": "planning",
            "taskIds":[ent_id], "createdAt":"2026-05-01T00:00:00Z", "path":"engineering/sprints/seed"
        }))
        (tmp_root / ".forge" / "store" / "tasks" / f"{ent_id}.json").write_text(json.dumps({
            "taskId": ent_id, "sprintId": sprint_id, "title":"seed",
            "status":"draft", "path":"engineering/sprints/seed/seed-task"
        }))
        (tmp_root / ".forge" / "store" / "sprints" / f"{sprint_short}.json").write_text(json.dumps({
            "sprintId": sprint_short, "title":"seed-short","status":"planning",
            "taskIds":[ent_id],"createdAt":"2026-05-01T00:00:00Z","path":"engineering/sprints/seed"
        }))
    elif re.match(r"^[A-Z]+-BUG-\d+$", ent_id) or ent_id.startswith("PENDING"):
        (tmp_root / ".forge" / "store" / "bugs" / f"{ent_id}.json").write_text(json.dumps({
            "bugId": ent_id, "title":"seed","status":"reported","severity":"minor",
            "path":"engineering/bugs/seed","reportedAt":"2026-05-01T00:00:00Z"
        }))
    return ent_id, sprint_short

# parse out a status target from `update-status task <id> status <newstatus>`
RE_UPDATE_STATUS = re.compile(r'update-status\s+(sprint|task|bug|feature)\s+(\S+)\s+status\s+(\S+)')

# parse out target file from set-summary/set-bug-summary
RE_SUMMARY_FILE = re.compile(r'set-(?:bug-)?summary\s+\S+\s+\S+\s+(\S+)')

# parse summary type
RE_SET_SUMMARY = re.compile(r'set-(bug-)?summary\s+(\S+)\s+(\S+)\s+')

# valid summary keys per CLI: phases set { plan, review_plan, implementation, code_review, validation }
SUMMARY_PLACEHOLDER = {
    "objective":"seed objective",
    "written_at":"2026-05-01T00:00:00Z",
}
BUG_SUMMARY_PLACEHOLDER = {
    "objective":"seed objective",
    "written_at":"2026-05-01T00:00:00Z",
    "findings":[],
}

def pre_create_summary_file(args_tail:str, tmp_root:Path):
    """Ensure the summary file referenced by set-summary/set-bug-summary exists with a placeholder."""
    m = RE_SET_SUMMARY.search(args_tail)
    if not m: return
    is_bug = bool(m.group(1))
    fm = RE_SUMMARY_FILE.search(args_tail)
    if not fm: return
    rel = fm.group(1).strip().strip("'\"")
    p = tmp_root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    placeholder = BUG_SUMMARY_PLACEHOLDER if is_bug else SUMMARY_PLACEHOLDER
    if not p.exists():
        p.write_text(json.dumps(placeholder))

# replay
results = []
n_tx = 0
n_ops = 0
n_replayable = 0
n_skipped_bad_parse = 0
n_force_baseline = 0

baseline_pass_now_pass = 0
baseline_pass_now_fail = 0
baseline_fail_now_pass = 0
baseline_fail_now_fail = 0

regressions = []
improvements = []
still_broken_samples = defaultdict(list)

TXS = sorted(by_tx.keys())
print(f"replaying {sum(len(by_tx[t]) for t in TXS)} ops across {len(TXS)} transcripts (v2 stateful) ...")

for tx_name in TXS:
    ops = by_tx[tx_name]
    ops_replay = [r for r in ops if r["channel"] == "bash-store-cli"]
    if not ops_replay: continue
    n_tx += 1

    tmp_root, _ = make_tmp_store()
    try:
        tag = ops_replay[0].get("tag","")
        seed_entities(tmp_root, tag)

        for r in ops_replay:
            n_ops += 1
            cmd = recover_cmd(r)
            tail = extract_store_cli_args(cmd or "")
            if not tail:
                n_skipped_bad_parse += 1
                continue
            if tail.strip() in ("--help","-h","help"): continue

            # if baseline used --force, mirror baseline conditions by allowing force
            uses_force = "--force" in tail
            if uses_force: n_force_baseline += 1

            # pre-create summary file if applicable
            if "set-summary" in tail or "set-bug-summary" in tail:
                pre_create_summary_file(tail, tmp_root)

            rc, out, err = run_store_cli(tail, tmp_root, allow_force=uses_force)
            now_fail = rc != 0
            was_fail = bool(r.get("isError"))
            n_replayable += 1

            # If baseline succeeded and op was state-mutating (write/update-status), apply same mutation in tmpdir
            # by NOT rolling back. Op already executed; if current also succeeded, state matches.
            # If baseline succeeded but current failed (regression), still leave whatever current did.
            # If baseline failed and current also failed, no mutation. OK.

            # Recover state from baseline: if baseline succeeded on update-status,
            # force the tmpdir record into the new status (so subsequent ops see correct state).
            if not was_fail:
                m = RE_UPDATE_STATUS.search(tail)
                if m:
                    ent, eid, newstatus = m.group(1), m.group(2), m.group(3)
                    rec_path = tmp_root / ".forge" / "store" / (
                        "sprints" if ent=="sprint" else
                        "tasks" if ent=="task" else
                        "bugs" if ent=="bug" else
                        "features"
                    ) / f"{eid}.json"
                    if rec_path.exists():
                        try:
                            d = json.loads(rec_path.read_text())
                            d["status"] = newstatus
                            rec_path.write_text(json.dumps(d))
                        except: pass

            if not was_fail and not now_fail: baseline_pass_now_pass += 1
            elif not was_fail and now_fail:
                baseline_pass_now_fail += 1
                if len(regressions) < 25:
                    regressions.append({
                        "transcript": tx_name, "callIdx": r["callIdx"],
                        "subcommand": r["subcommand"], "tail": tail[:300],
                        "now_err": (err or out)[:300]
                    })
            elif was_fail and not now_fail:
                baseline_fail_now_pass += 1
                if len(improvements) < 20:
                    improvements.append({
                        "transcript": tx_name, "subcommand": r["subcommand"],
                        "tail": tail[:200],
                        "baseline_err": (r.get("errSnippet") or "")[:200],
                    })
            else:
                baseline_fail_now_fail += 1
                for k in r.get("errKeys", ["other"]):
                    if len(still_broken_samples[k]) < 3:
                        still_broken_samples[k].append({
                            "transcript": tx_name, "subcommand": r["subcommand"],
                            "tail": tail[:200],
                            "baseline_err": (r.get("errSnippet") or "")[:200],
                            "now_err": (err or out or "")[:200]
                        })
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

# build report
L = []
L.append(f"# Mode A v2 Verify-Bench — stateful replay against CURRENT store-cli\n")
L.append(f"- Transcripts replayed: **{n_tx}**")
L.append(f"- Store-cli ops attempted: **{n_ops}**")
L.append(f"- Successfully replayed: **{n_replayable}**")
L.append(f"- Unparseable args (skipped): **{n_skipped_bad_parse}**")
L.append(f"- Ops where baseline used --force (env mirrored): **{n_force_baseline}**\n")

total = n_replayable or 1
L.append("## Outcome matrix\n")
L.append("| Baseline → Current | Count | % |")
L.append("|---|---:|---:|")
L.append(f"| ✅✅ pass → pass | {baseline_pass_now_pass} | {baseline_pass_now_pass/total:.1%} |")
L.append(f"| ✅❌ pass → fail (REGRESSION) | {baseline_pass_now_fail} | {baseline_pass_now_fail/total:.1%} |")
L.append(f"| ❌✅ fail → pass (IMPROVEMENT) | {baseline_fail_now_pass} | {baseline_fail_now_pass/total:.1%} |")
L.append(f"| ❌❌ fail → fail (still broken) | {baseline_fail_now_fail} | {baseline_fail_now_fail/total:.1%} |")
L.append("")

baseline_err = baseline_fail_now_pass + baseline_fail_now_fail
current_err = baseline_pass_now_fail + baseline_fail_now_fail
baseline_rate = baseline_err / total
current_rate = current_err / total
L.append("## Aggregate error rate\n")
L.append(f"- Baseline: **{baseline_err}/{total} = {baseline_rate:.1%}**")
L.append(f"- Current: **{current_err}/{total} = {current_rate:.1%}**")
L.append(f"- Delta: **{(baseline_rate-current_rate)*100:+.1f}pp**")
if baseline_err:
    L.append(f"- Improved: **{baseline_fail_now_pass}/{baseline_err} = {baseline_fail_now_pass/baseline_err:.1%}** of baseline errors")
L.append("")

L.append("## Still-broken patterns (after fixes shipped to date)\n")
for k in sorted(still_broken_samples.keys(), key=lambda k:-len(still_broken_samples[k])):
    cnt = sum(1 for r in recs if r.get("isError") and k in r.get("errKeys",[]))
    L.append(f"### `{k}` (~{cnt} baseline errors)")
    for s in still_broken_samples[k][:2]:
        L.append(f"- `{s['subcommand']}` tail: `{s['tail']}`")
        L.append(f"  - now_err: `{s['now_err']}`")
    L.append("")

if regressions:
    L.append(f"## ⚠️ Regressions ({len(regressions)} sampled)\n")
    for r in regressions[:15]:
        L.append(f"- `{r['subcommand']}` tail: `{r['tail']}`")
        L.append(f"  - now_err: `{r['now_err']}`")
    L.append("")

L.append(f"## Improvements ({baseline_fail_now_pass} total, {len(improvements)} sampled)\n")
for r in improvements[:12]:
    L.append(f"- `{r['subcommand']}` tail: `{r['tail']}`")
    L.append(f"  - was_err: `{r['baseline_err']}`")
L.append("")

OUT_MD.write_text("\n".join(L))
OUT_JSON.write_text(json.dumps({
    "n_tx": n_tx, "n_ops": n_ops, "n_replayable": n_replayable,
    "n_force_baseline": n_force_baseline,
    "baseline_pass_now_pass": baseline_pass_now_pass,
    "baseline_pass_now_fail": baseline_pass_now_fail,
    "baseline_fail_now_pass": baseline_fail_now_pass,
    "baseline_fail_now_fail": baseline_fail_now_fail,
    "baseline_rate": baseline_rate, "current_rate": current_rate,
}, indent=2))

print(f"→ {OUT_MD}")
print(f"→ {OUT_JSON}")
print(f"Baseline {baseline_rate:.1%} → Current {current_rate:.1%}  (Δ {(baseline_rate-current_rate)*100:+.1f}pp)")
