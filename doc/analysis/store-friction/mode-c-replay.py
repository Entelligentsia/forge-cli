#!/usr/bin/env python3
"""Mode C replay — re-execute fresh corpus store-ops against current store-cli.

Unlike verify-bench.py (which uses hardcoded absolute paths and the T01 SHA256-pinned fixture),
mode-c-replay.py:
  - Uses portable path resolution via parents[4] (script lives at:
      forge-cli/test/analysis/store-friction/ → project_root/forge/forge/tools/store-cli.cjs)
  - Accepts CLI args for all input/output paths
  - Does NOT assert SHA256 (fresh corpus is not pinned)
  - For probe records: preserves expectedIsError/expectedErrSnippet alongside observed values
  - Accepts an optional --store-cli override for cross-machine use

Sprint FORGE-S22 / Task FORGE-S22-T06
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile
from collections import Counter, defaultdict
from pathlib import Path

# ─── Path resolution (portable) ───────────────────────────────────────────────
# Script lives at: <project_root>/forge-cli/test/analysis/store-friction/mode-c-replay.py
# parents[0] = analysis/         (store-friction's parent)
# parents[1] = test/
# parents[2] = forge-cli/
# parents[3] = <project_root>/   (forge-engineering/)
#
# Note: PLAN.md §Path portability says parents[4] but that resolves to /home/boni/src/.
# The correct depth is parents[3] — verified by counting directory levels from script location.
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[3]
DEFAULT_STORE_CLI = PROJECT_ROOT / "forge" / "forge" / "tools" / "store-cli.cjs"
DEFAULT_SCHEMA_DIR = PROJECT_ROOT / "forge" / "forge" / "schemas"
DEFAULT_CORPUS_DIR = PROJECT_ROOT / "tmp" / "mode-c-corpus"
DEFAULT_OPS_FILE   = DEFAULT_CORPUS_DIR / "store-ops-fresh.jsonl"
DEFAULT_OUT_MD     = DEFAULT_CORPUS_DIR / "VERIFY-BENCH-FRESH.md"
DEFAULT_OUT_JSON   = DEFAULT_CORPUS_DIR / "verify-bench-fresh.json"

def parse_args():
    p = argparse.ArgumentParser(description="Mode C replay: re-execute fresh corpus ops against current store-cli")
    p.add_argument("--store-cli",   type=Path, default=DEFAULT_STORE_CLI,   help="Path to store-cli.cjs (default: local dev source)")
    p.add_argument("--schema-dir",  type=Path, default=DEFAULT_SCHEMA_DIR,  help="Path to forge schemas dir")
    p.add_argument("--corpus-dir",  type=Path, default=DEFAULT_CORPUS_DIR,  help="Corpus directory (for context only)")
    p.add_argument("--ops-file",    type=Path, default=DEFAULT_OPS_FILE,    help="JSONL ops input file")
    p.add_argument("--out-md",      type=Path, default=DEFAULT_OUT_MD,      help="Output Markdown report")
    p.add_argument("--out-json",    type=Path, default=DEFAULT_OUT_JSON,    help="Output JSON summary")
    p.add_argument("--probes-file", type=Path, default=None,                help="Optional probes.jsonl to also replay (probe records)")
    p.add_argument("--verbose",     action="store_true",                    help="Print per-op details")
    return p.parse_args()

def make_tmp_store(store_cli: Path, schema_dir: Path):
    """Create a fresh tmpdir store for stateful replay."""
    tmp = Path(tempfile.mkdtemp(prefix="mode-c-replay-"))
    forge_root = tmp / "_forge_plugin"
    forge_root.mkdir()
    (forge_root / "tools").symlink_to(store_cli.parent)
    (forge_root / "schemas").symlink_to(schema_dir)
    store = tmp / ".forge" / "store"
    store.mkdir(parents=True)
    for sub in ("sprints", "tasks", "bugs", "features", "events"):
        (store / sub).mkdir()
    (tmp / ".forge" / "config.json").write_text(json.dumps({
        "project": {"name": "mode-c-replay", "prefix": "MCR"},
        "paths": {
            "forgeRoot": str(forge_root),
            "engineering": "engineering",
            "templates": ".forge/templates",
            "commands": ".claude/commands",
        }
    }))
    return tmp

def seed_entities(tmp_root: Path, tag: str):
    """Pre-seed sprint+task or bug record from transcript tag."""
    ent_id = tag.split("__")[0] if tag else ""
    if re.match(r"^[A-Z]+-S\d+-T\d+$", ent_id):
        sprint_id = "-".join(ent_id.split("-")[:-1])
        sprint_short = "S" + ent_id.split("-S")[1].split("-")[0]
        (tmp_root / ".forge" / "store" / "sprints" / f"{sprint_id}.json").write_text(json.dumps({
            "sprintId": sprint_id, "title": "seed", "status": "planning",
            "taskIds": [ent_id], "createdAt": "2026-05-01T00:00:00Z", "path": "engineering/sprints/seed"
        }))
        (tmp_root / ".forge" / "store" / "tasks" / f"{ent_id}.json").write_text(json.dumps({
            "taskId": ent_id, "sprintId": sprint_id, "title": "seed",
            "status": "draft", "path": "engineering/sprints/seed/seed-task"
        }))
        (tmp_root / ".forge" / "store" / "sprints" / f"{sprint_short}.json").write_text(json.dumps({
            "sprintId": sprint_short, "title": "seed-short", "status": "planning",
            "taskIds": [ent_id], "createdAt": "2026-05-01T00:00:00Z", "path": "engineering/sprints/seed"
        }))
    elif re.match(r"^[A-Z]+-BUG-\d+$", ent_id) or ent_id.startswith("PENDING"):
        (tmp_root / ".forge" / "store" / "bugs" / f"{ent_id}.json").write_text(json.dumps({
            "bugId": ent_id, "title": "seed", "status": "reported", "severity": "minor",
            "path": "engineering/bugs/seed", "reportedAt": "2026-05-01T00:00:00Z"
        }))

def extract_store_cli_args(cmd: str):
    """Extract args tail after store-cli.cjs invocation."""
    if not cmd:
        return None
    m = re.search(r'store-cli\.cjs["\']?\s+', cmd)
    if not m:
        return None
    tail = cmd[m.end():]
    tail = re.split(r'\s+2>/dev/null|\s+\|\|\s+|\s+&&\s+(?!.*store-cli\.cjs)', tail, maxsplit=1)[0]
    return tail.strip()

RE_UPDATE_STATUS = re.compile(r'update-status\s+(sprint|task|bug|feature)\s+(\S+)\s+status\s+(\S+)')
RE_SUMMARY_FILE  = re.compile(r'set-(?:bug-)?summary\s+\S+\s+\S+\s+(\S+)')
RE_SET_SUMMARY   = re.compile(r'set-(bug-)?summary\s+(\S+)\s+(\S+)\s+')

SUMMARY_PLACEHOLDER = {"objective": "seed objective", "written_at": "2026-05-01T00:00:00Z"}
BUG_SUMMARY_PLACEHOLDER = {"objective": "seed objective", "written_at": "2026-05-01T00:00:00Z", "findings": []}

def pre_create_summary_file(args_tail: str, tmp_root: Path):
    m = RE_SET_SUMMARY.search(args_tail)
    if not m:
        return
    is_bug = bool(m.group(1))
    fm = RE_SUMMARY_FILE.search(args_tail)
    if not fm:
        return
    rel = fm.group(1).strip().strip("'\"")
    p = tmp_root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    placeholder = BUG_SUMMARY_PLACEHOLDER if is_bug else SUMMARY_PLACEHOLDER
    if not p.exists():
        p.write_text(json.dumps(placeholder))

def run_store_cli(store_cli: Path, args_tail: str, cwd: Path, timeout=15, allow_force=False):
    env = os.environ.copy()
    if allow_force:
        env["FORGE_ALLOW_FORCE"] = "1"
    bash_cmd = f"node {store_cli} {args_tail}"
    try:
        proc = subprocess.run(
            ["bash", "-c", bash_cmd], cwd=str(cwd),
            capture_output=True, text=True, timeout=timeout, env=env
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT"
    except Exception as e:
        return -2, "", f"SPAWN_ERR: {e}"

def replay_probe(store_cli: Path, probe_rec: dict, verbose=False):
    """Re-execute a probe record's rawCmd against the live project store.

    For probes we re-execute against the local project store (not a tmpdir)
    since P1-P3, P5 need real entity IDs. We capture exit code and stderr,
    overwrite isError/errSnippet with observed values, preserve expected* fields.
    """
    raw_cmd = probe_rec.get("rawCmd", "")
    # Replace any hardcoded store-cli path in rawCmd with the provided one
    # rawCmd from mode-c-capture.sh already uses $NODE '$CLI' which resolves to actual path
    tail = extract_store_cli_args(raw_cmd)
    if not tail:
        # Try to parse as direct node invocation
        m = re.search(r"node\s+['\"]?(\S+store-cli\.cjs['\"]?)\s+(.*)", raw_cmd)
        if m:
            tail = m.group(2).strip()
        else:
            return {**probe_rec, "replayStatus": "skipped-unparseable"}

    rc, out, err = run_store_cli(store_cli, tail, store_cli.parent.parent.parent.parent.parent, timeout=15)
    observed_is_error = rc != 0

    result = {
        **probe_rec,
        "isError": observed_is_error,
        "errSnippet": (err or out)[:400] if observed_is_error else "",
        "expectedIsError": probe_rec.get("expectedIsError", probe_rec.get("isError")),
        "expectedErrSnippet": probe_rec.get("expectedErrSnippet", probe_rec.get("errSnippet", "")),
        "replayStatus": "ok",
        "observedExitCode": rc,
    }
    if verbose:
        match = result["isError"] == result["expectedIsError"]
        print(f"  [{probe_rec.get('probeId','?')}] {'PASS' if match else 'FAIL'} isError={result['isError']} expected={result['expectedIsError']}")
    return result

def replay_fresh_ops(store_cli: Path, schema_dir: Path, ops_file: Path, verbose=False):
    """Replay fresh corpus ops (stateful, per-transcript tmpdir). Returns results dict."""
    if not ops_file.exists():
        return None, f"Ops file not found: {ops_file}"

    recs = [json.loads(l) for l in ops_file.open() if l.strip()]
    by_tx = defaultdict(list)
    for r in recs:
        by_tx[r["transcript"]].append(r)
    for tx in by_tx:
        by_tx[tx].sort(key=lambda r: r["callIdx"])

    baseline_pass_now_pass = 0
    baseline_pass_now_fail = 0
    baseline_fail_now_pass = 0
    baseline_fail_now_fail = 0
    n_tx = 0
    n_ops = 0
    n_replayable = 0
    n_skipped = 0
    n_force = 0
    regressions = []
    improvements = []
    still_broken = defaultdict(list)

    TXS = sorted(by_tx.keys())
    print(f"Replaying {sum(len(by_tx[t]) for t in TXS)} ops across {len(TXS)} transcripts ...")

    for tx_name in TXS:
        ops = by_tx[tx_name]
        ops_replay = [r for r in ops if r.get("channel") == "bash-store-cli"]
        if not ops_replay:
            continue
        n_tx += 1

        tmp_root = make_tmp_store(store_cli, schema_dir)
        try:
            tag = ops_replay[0].get("tag", "")
            seed_entities(tmp_root, tag)

            for r in ops_replay:
                n_ops += 1
                raw_cmd = r.get("rawCmd", "")
                tail = extract_store_cli_args(raw_cmd)
                if not tail:
                    n_skipped += 1
                    continue
                if tail.strip() in ("--help", "-h", "help"):
                    continue

                uses_force = "--force" in tail
                if uses_force:
                    n_force += 1

                if "set-summary" in tail or "set-bug-summary" in tail:
                    pre_create_summary_file(tail, tmp_root)

                rc, out, err = run_store_cli(store_cli, tail, tmp_root, allow_force=uses_force)
                now_fail = rc != 0
                was_fail = bool(r.get("isError"))
                n_replayable += 1

                # State tracking: recover baseline update-status mutations
                if not was_fail:
                    m = RE_UPDATE_STATUS.search(tail)
                    if m:
                        ent, eid, newstatus = m.group(1), m.group(2), m.group(3)
                        store_subdir = {
                            "sprint": "sprints", "task": "tasks",
                            "bug": "bugs", "feature": "features"
                        }.get(ent, "tasks")
                        rec_path = tmp_root / ".forge" / "store" / store_subdir / f"{eid}.json"
                        if rec_path.exists():
                            try:
                                d = json.loads(rec_path.read_text())
                                d["status"] = newstatus
                                rec_path.write_text(json.dumps(d))
                            except Exception:
                                pass

                if not was_fail and not now_fail:
                    baseline_pass_now_pass += 1
                elif not was_fail and now_fail:
                    baseline_pass_now_fail += 1
                    if len(regressions) < 25:
                        regressions.append({
                            "transcript": tx_name, "callIdx": r["callIdx"],
                            "subcommand": r.get("subcommand"), "tail": tail[:300],
                            "now_err": (err or out)[:300]
                        })
                elif was_fail and not now_fail:
                    baseline_fail_now_pass += 1
                    if len(improvements) < 20:
                        improvements.append({
                            "transcript": tx_name, "subcommand": r.get("subcommand"),
                            "tail": tail[:200],
                            "baseline_err": (r.get("errSnippet") or "")[:200],
                        })
                else:
                    baseline_fail_now_fail += 1
                    for k in r.get("errKeys", ["other"]):
                        if len(still_broken[k]) < 3:
                            still_broken[k].append({
                                "transcript": tx_name, "subcommand": r.get("subcommand"),
                                "tail": tail[:200],
                                "baseline_err": (r.get("errSnippet") or "")[:200],
                                "now_err": (err or out or "")[:200]
                            })

                if verbose:
                    mark = "✅" if not now_fail else "❌"
                    was = "FAIL" if was_fail else "PASS"
                    print(f"  {mark} [{tx_name}/{r['callIdx']}] was={was} now={'FAIL' if now_fail else 'PASS'}")

        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)

    total = n_replayable or 1
    baseline_err = baseline_fail_now_pass + baseline_fail_now_fail
    current_err = baseline_pass_now_fail + baseline_fail_now_fail
    baseline_rate = baseline_err / total
    current_rate = current_err / total

    return {
        "n_tx": n_tx, "n_ops": n_ops, "n_replayable": n_replayable,
        "n_skipped": n_skipped, "n_force": n_force,
        "baseline_pass_now_pass": baseline_pass_now_pass,
        "baseline_pass_now_fail": baseline_pass_now_fail,
        "baseline_fail_now_pass": baseline_fail_now_pass,
        "baseline_fail_now_fail": baseline_fail_now_fail,
        "baseline_rate": baseline_rate,
        "current_rate": current_rate,
        "regressions": regressions,
        "improvements": improvements,
        "still_broken": dict(still_broken),
    }, None

def build_report(data: dict, ops_file: Path, store_cli: Path) -> str:
    """Build a Markdown report in VERIFY-BENCH.md format."""
    L = []
    L.append("# Mode C Fresh Corpus Replay — VERIFY-BENCH-FRESH\n")
    L.append("> **Disclaimer:** This corpus is NOT SHA256-pinned and is NOT the basis for a regression test.")
    L.append("> It is a one-time measurement artifact for Sprint FORGE-S22 Measurement A.\n")
    L.append(f"- Store-cli: `{store_cli}`")
    L.append(f"- Ops file: `{ops_file}`")
    L.append(f"- Transcripts replayed: **{data['n_tx']}**")
    L.append(f"- Store-cli ops attempted: **{data['n_ops']}**")
    L.append(f"- Successfully replayed: **{data['n_replayable']}**")
    L.append(f"- Skipped (unparseable): **{data['n_skipped']}**")
    L.append(f"- Ops with --force (env mirrored): **{data['n_force']}**\n")

    total = data['n_replayable'] or 1
    L.append("## Outcome matrix\n")
    L.append("| Baseline → Current | Count | % |")
    L.append("|---|---:|---:|")
    L.append(f"| ✅✅ pass → pass | {data['baseline_pass_now_pass']} | {data['baseline_pass_now_pass']/total:.1%} |")
    L.append(f"| ✅❌ pass → fail (REGRESSION) | {data['baseline_pass_now_fail']} | {data['baseline_pass_now_fail']/total:.1%} |")
    L.append(f"| ❌✅ fail → pass (IMPROVEMENT) | {data['baseline_fail_now_pass']} | {data['baseline_fail_now_pass']/total:.1%} |")
    L.append(f"| ❌❌ fail → fail (still broken) | {data['baseline_fail_now_fail']} | {data['baseline_fail_now_fail']/total:.1%} |")
    L.append("")

    L.append("## Aggregate error rate\n")
    L.append(f"- Fresh corpus (baseline): **{data['baseline_rate']:.1%}**")
    L.append(f"- After fix replay (current): **{data['current_rate']:.1%}**")
    L.append(f"- Sprint gate target: **≤12.0%**")
    verdict = "PASS" if data['current_rate'] <= 0.12 else "FAIL"
    L.append(f"- **Verdict: {verdict}**\n")

    if data.get("regressions"):
        L.append(f"## ⚠️ Regressions ({len(data['regressions'])} sampled)\n")
        for r in data["regressions"][:15]:
            L.append(f"- `{r['subcommand']}` tail: `{r['tail']}`")
            L.append(f"  - now_err: `{r['now_err']}`")
        L.append("")

    if data.get("improvements"):
        L.append(f"## Improvements ({data['baseline_fail_now_pass']} total, {len(data['improvements'])} sampled)\n")
        for r in data["improvements"][:12]:
            L.append(f"- `{r['subcommand']}` tail: `{r['tail']}`")
            L.append(f"  - was_err: `{r['baseline_err']}`")
        L.append("")

    return "\n".join(L)

def main():
    args = parse_args()
    store_cli = args.store_cli.resolve()
    schema_dir = args.schema_dir.resolve()

    if not store_cli.exists():
        print(f"ERROR: store-cli not found: {store_cli}", file=sys.stderr)
        sys.exit(1)
    if not schema_dir.exists():
        print(f"ERROR: schema dir not found: {schema_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Mode C replay")
    print(f"  store-cli : {store_cli}")
    print(f"  ops-file  : {args.ops_file}")
    print(f"  out-md    : {args.out_md}")
    print(f"  out-json  : {args.out_json}")

    # Replay probes if provided
    if args.probes_file and args.probes_file.exists():
        print(f"\nReplaying probes from: {args.probes_file}")
        probe_recs = [json.loads(l) for l in args.probes_file.open() if l.strip()]
        probe_results = []
        for rec in probe_recs:
            result = replay_probe(store_cli, rec, verbose=args.verbose)
            probe_results.append(result)
        # Overwrite probes file with observed values
        with open(args.probes_file, "w") as f:
            for r in probe_results:
                f.write(json.dumps(r, separators=(",", ":")) + "\n")
        print(f"Probe results written back to: {args.probes_file}")

    # Replay fresh corpus ops
    if not args.ops_file.exists():
        print(f"\nWARN: ops-file not found: {args.ops_file}", file=sys.stderr)
        print("Fresh corpus capture not yet performed. Run mode-c-capture.sh first.")
        print("Producing stub output.")
        data = {
            "n_tx": 0, "n_ops": 0, "n_replayable": 0, "n_skipped": 0, "n_force": 0,
            "baseline_pass_now_pass": 0, "baseline_pass_now_fail": 0,
            "baseline_fail_now_pass": 0, "baseline_fail_now_fail": 0,
            "baseline_rate": 0.0, "current_rate": 0.0,
            "regressions": [], "improvements": [], "still_broken": {},
            "_note": "No fresh corpus available. Run mode-c-capture.sh then filter-store-ops.py first."
        }
    else:
        data, err = replay_fresh_ops(store_cli, schema_dir, args.ops_file, verbose=args.verbose)
        if err:
            print(f"ERROR: {err}", file=sys.stderr)
            sys.exit(1)

    # Write outputs
    args.out_md.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_md.write_text(build_report(data, args.ops_file, store_cli))
    # Serialize data (strip non-serializable)
    json_data = {k: v for k, v in data.items() if not isinstance(v, defaultdict)}
    args.out_json.write_text(json.dumps(json_data, indent=2))

    print(f"\n→ {args.out_md}")
    print(f"→ {args.out_json}")
    if data.get("n_replayable", 0) > 0:
        print(f"Current error rate: {data['current_rate']:.1%} (gate: ≤12.0%)")
        verdict = "PASS" if data["current_rate"] <= 0.12 else "FAIL"
        print(f"Sprint gate verdict: {verdict}")

if __name__ == "__main__":
    main()
