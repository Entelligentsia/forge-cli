#!/usr/bin/env python3
"""Stage 1 — extract store-touching tool ops from forge subagent transcripts.

Emits one JSON record per store op to store-ops.jsonl.
"""
import json, os, re, sys
from pathlib import Path

ROOT = Path("/home/boni/src/forge-engineering/tmp/transcripts/hello")
OUT  = Path("/home/boni/src/forge-engineering/tmp/transcripts-analysis/store-ops.jsonl")

# MCP-tool channels (pi-runtime)
MCP_STORE_TOOLS = {
    "forge_store", "forge_store_template", "forge_store_describe",
    "forge_store_query", "forge_validate_store", "forge_collate", "forge_config",
}

# bash patterns that touch store-cli.cjs
RE_STORECLI_NODE = re.compile(r"store-cli\.cjs[\"']?\s+(\S+)")
RE_FORGE_BIN     = re.compile(r"(?:^|[\s;&|])forge\s+store\s+(\S+)")
RE_BAREWORD_FS   = re.compile(r"forge_store\s+(\S+)\s+(\S+)?")  # discipline workflow text
RE_VALIDATE      = re.compile(r"validate-store\.cjs")
RE_COLLATE       = re.compile(r"collate\.cjs")
RE_CONFIG        = re.compile(r"manage-config\.cjs")

ENTITY_WORDS = {"sprint","task","bug","feature","event","enhancement"}

# error-snippet normalization
RE_MISSING       = re.compile(r"^([a-zA-Z_]+)\s*:\s*missing required field", re.M)
RE_REQUIRED      = re.compile(r"required field\s*['\"]?(\w+)['\"]?", re.I)
RE_ILLEGAL       = re.compile(r"Illegal transition:\s*(\w+)\s+\S+\s+\S+:\s*(\S+)\s*→\s*(\S+)")
RE_ENUM          = re.compile(r"(?:invalid|not in) enum.*?field\s*['\"]?(\w+)", re.I)
RE_UNKNOWN_ENT   = re.compile(r"Unknown entity:?\s*['\"]?(\w+)", re.I)
RE_UNKNOWN_CMD   = re.compile(r"Unknown command:?\s*['\"]?(\w+)", re.I)
RE_JSONERR       = re.compile(r"(Unexpected token|JSON\.parse|SyntaxError)")
RE_ENOENT        = re.compile(r"ENOENT|no such file|not found", re.I)
RE_FORCE         = re.compile(r"--force bypassing illegal transition")

def classify_bash(cmd:str):
    """Return (channel, subcommand, entity_or_none) or None."""
    if not cmd: return None
    m = RE_STORECLI_NODE.search(cmd)
    if m:
        return ("bash-store-cli", m.group(1), None)
    m = RE_FORGE_BIN.search(cmd)
    if m:
        return ("bash-forge-bin", m.group(1), None)
    if RE_VALIDATE.search(cmd):     return ("bash-validate-store", None, None)
    if RE_COLLATE.search(cmd):      return ("bash-collate", None, None)
    if RE_CONFIG.search(cmd):       return ("bash-manage-config", None, None)
    return None

def extract_entity(channel, subcmd, args_list, raw):
    """For write/read/list/delete/update-status/emit, try first positional as entity or sprint."""
    if not args_list:
        # try raw cmd
        toks = (raw or "").split()
        for t in toks:
            if t in ENTITY_WORDS: return t
        return None
    for a in args_list:
        a0 = (a or "").strip().strip("'\"")
        if a0 in ENTITY_WORDS: return a0
    return None

def classify_err(snippet:str):
    """Return list of normalized errKeys."""
    keys=[]
    if not snippet: return keys
    for m in RE_MISSING.finditer(snippet):
        keys.append(f"missing_required_field:{m.group(1)}")
    for m in RE_REQUIRED.finditer(snippet):
        keys.append(f"missing_required_field:{m.group(1)}")
    m = RE_ILLEGAL.search(snippet)
    if m: keys.append(f"illegal_transition:{m.group(1)}:{m.group(2)}->{m.group(3)}")
    m = RE_ENUM.search(snippet)
    if m: keys.append(f"enum_invalid:{m.group(1)}")
    m = RE_UNKNOWN_ENT.search(snippet)
    if m: keys.append(f"unknown_entity:{m.group(1)}")
    m = RE_UNKNOWN_CMD.search(snippet)
    if m: keys.append(f"unknown_subcommand:{m.group(1)}")
    if RE_JSONERR.search(snippet): keys.append("invalid_json")
    if RE_ENOENT.search(snippet):  keys.append("entity_or_path_not_found")
    if RE_FORCE.search(snippet):   keys.append("force_warn")
    if not keys:
        # bucket as generic if we know it errored
        keys.append("other")
    return list(dict.fromkeys(keys))  # dedupe preserve order

def text_of(content):
    """Flatten content list into a single text string."""
    if isinstance(content, str): return content
    if isinstance(content, list):
        parts=[]
        for c in content:
            if isinstance(c,dict):
                if c.get("type")=="text" and c.get("text"): parts.append(c["text"])
                elif c.get("text"): parts.append(c["text"])
        return "\n".join(parts)
    return ""

def process_transcript(path:Path):
    """Yield store-op records."""
    try:
        with open(path) as f: d = json.load(f)
    except Exception as e:
        print(f"WARN unreadable {path.name}: {e}", file=sys.stderr); return
    persona = d.get("persona","?")
    tag     = d.get("tag","?")
    model   = d.get("model","?")
    provider= d.get("provider","?")
    exit_code = d.get("exitCode")
    msgs = d.get("messages", [])
    # index toolCalls by id, then walk results
    calls_by_id={}
    call_order=[]
    for idx,m in enumerate(msgs):
        c = m.get("content")
        if isinstance(c, list):
            for x in c:
                if isinstance(x,dict) and x.get("type")=="toolCall":
                    cid=x.get("id")
                    calls_by_id[cid]=(idx, x)
                    call_order.append(cid)
    # second pass: build results
    for idx,m in enumerate(msgs):
        if m.get("role")!="toolResult": continue
        cid = m.get("toolCallId")
        if cid not in calls_by_id: continue
        call_idx, call = calls_by_id[cid]
        result_text = text_of(m.get("content"))
        is_error = bool(m.get("isError"))
        tool_name = call.get("name") or m.get("toolName") or ""
        args = call.get("arguments") or {}
        if isinstance(args, str):
            try: args=json.loads(args)
            except: args={"_raw":args}

        rec = None
        if tool_name in MCP_STORE_TOOLS:
            # MCP path
            subcommand = args.get("command") or args.get("entity") or args.get("subcommand") or "?"
            arg_list = args.get("args")
            if not isinstance(arg_list, list): arg_list = []
            raw_cmd  = f"{tool_name} {subcommand} {' '.join(map(str,arg_list))}"[:400]
            entity = extract_entity(tool_name, subcommand, arg_list, raw_cmd)
            arg_shape = []
            for a in arg_list:
                a0=(a or "").strip()
                if not a0: arg_shape.append("EMPTY")
                elif a0 in ENTITY_WORDS: arg_shape.append("ENTITY")
                elif a0.startswith("{") and a0.endswith("}"): arg_shape.append("JSON")
                elif re.match(r"^--", a0): arg_shape.append(f"FLAG:{a0}")
                elif re.match(r"^[A-Z0-9-]+-[A-Z0-9-]+", a0): arg_shape.append("ID")
                else: arg_shape.append("STR")
            rec = {
                "transcript": path.name,
                "persona": persona, "tag": tag, "model": model, "provider": provider,
                "callIdx": call_idx,
                "channel": tool_name,
                "subcommand": subcommand,
                "entity": entity,
                "argShape": arg_shape,
                "rawCmd": raw_cmd,
                "isError": is_error,
                "errKeys": classify_err(result_text) if is_error else [],
                "errSnippet": (result_text[:400] if is_error else ""),
            }
        elif tool_name == "bash":
            cmd_text = args.get("command","") if isinstance(args, dict) else ""
            cls = classify_bash(cmd_text)
            if not cls: continue
            channel, subcommand, entity_hint = cls
            # Parse subsequent tokens after store-cli.cjs <subcommand>
            arg_tokens=[]
            if channel == "bash-store-cli":
                m = RE_STORECLI_NODE.search(cmd_text)
                if m:
                    after = cmd_text[m.end():].strip()
                    arg_tokens = after.split(None, 5)
            entity = extract_entity(channel, subcommand, arg_tokens, cmd_text)
            arg_shape=[]
            for a in arg_tokens:
                a0=a.strip().strip("'\"")
                if a0 in ENTITY_WORDS: arg_shape.append("ENTITY")
                elif a0.startswith("{"): arg_shape.append("JSON")
                elif a0.startswith("--"): arg_shape.append(f"FLAG:{a0}")
                elif re.match(r"^[A-Z0-9-]+-[A-Z0-9-]+", a0): arg_shape.append("ID")
                else: arg_shape.append("STR")
            rec = {
                "transcript": path.name,
                "persona": persona, "tag": tag, "model": model, "provider": provider,
                "callIdx": call_idx,
                "channel": channel,
                "subcommand": subcommand or "?",
                "entity": entity,
                "argShape": arg_shape,
                "rawCmd": cmd_text[:400],
                "isError": is_error,
                "errKeys": classify_err(result_text) if is_error else (
                    ["force_warn"] if RE_FORCE.search(result_text) else []),
                "errSnippet": (result_text[:400] if (is_error or RE_FORCE.search(result_text)) else ""),
            }
        if rec is not None:
            yield rec

def main():
    files = sorted(ROOT.rglob("*.json"))
    print(f"scanning {len(files)} transcripts → {OUT}")
    n_recs=0; n_files_with_ops=0
    with open(OUT, "w") as out:
        for p in files:
            count=0
            for rec in process_transcript(p):
                out.write(json.dumps(rec, separators=(",",":")) + "\n")
                count+=1
            if count: n_files_with_ops+=1
            n_recs+=count
    print(f"emitted {n_recs} store-op records from {n_files_with_ops}/{len(files)} transcripts")

if __name__ == "__main__":
    main()
