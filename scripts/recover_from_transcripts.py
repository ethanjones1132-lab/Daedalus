#!/usr/bin/env python3
"""Recover home-base source files from Claude Code session transcripts.

The original tree lived in WSL and was lost. Claude Code recorded every
Write/Edit/Read while it was being built. This walks all transcripts, and for
each project file picks the latest COMPLETE content seen (Write input preferred,
full Read result as fallback), writing the result to a staging tree.
"""
import json, os, re, sys
from pathlib import Path

PROJ = Path(r"C:\Users\ethan\.claude\projects\--wsl-localhost-ubuntu-mnt-wslg-distro-home-ethan--openclaw-agents-coderclaw-workspace-home-base")
OUT = Path(r"C:\Projects\_recovery\from-transcripts")

# Only keep files under these project subdirs (relative to .../home-base/)
KEEP_PREFIXES = ("src-tauri/", "src-ui/", "server-jarvis/", "scripts/",
                 "workspace/", "agents/", "docs/")
KEEP_ROOT_FILES = {"package.json", "README.md", "CONTEXT.md", "HANDOFF.md",
                   "AGENTS.md", "build-optimized.ps1", "build-wsl.sh",
                   ".gitignore", "seed-cron-jobs.sh", "automate_inference_metrics.py"}

def relpath(fp):
    if not fp:
        return None
    s = fp.replace("\\", "/")
    i = s.lower().rfind("/home-base/")
    if i == -1:
        return None
    rel = s[i + len("/home-base/"):]
    if not rel or rel.endswith("/"):
        return None
    if rel in KEEP_ROOT_FILES or any(rel.startswith(p) for p in KEEP_PREFIXES):
        return rel
    return None

LINE_RE = re.compile(r"^\s*\d+(\t|→|→)(.*)$")

def strip_linenums(text):
    """Strip cat -n style prefixes from a Read tool_result. Returns (clean, ok)."""
    lines = text.split("\n")
    out, matched = [], 0
    for ln in lines:
        m = LINE_RE.match(ln)
        if m:
            out.append(m.group(2)); matched += 1
        else:
            # tolerate trailing blank / system-reminder lines
            if ln.strip() == "" or ln.startswith("<system-reminder"):
                continue
            return None, False
    if matched < 1:
        return None, False
    return "\n".join(out), True

def load_external(session_dir, tool_id):
    for cand in (session_dir / "tool-results" / f"{tool_id}.txt",):
        if cand.exists():
            try:
                return cand.read_text(encoding="utf-8", errors="replace")
            except Exception:
                return None
    return None

# events[rel] = list of (ts, kind, payload)
#   kind 'write' -> payload=content ; 'read' -> payload=content (authoritative)
#   kind 'edit'  -> payload=(old,new,replace_all)
from collections import defaultdict
events = defaultdict(list)

jsonls = sorted(PROJ.rglob("*.jsonl"))
read_use = {}   # tool_id -> (rel, ts)  pending Read awaiting its result
for jf in jsonls:
    session_dir = jf.with_suffix("")  # dir holding tool-results for this session
    with open(jf, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            ts = o.get("timestamp", "")
            msg = o.get("message")
            cont = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(cont, list):
                continue
            for c in cont:
                if not isinstance(c, dict):
                    continue
                t = c.get("type")
                if t == "tool_use":
                    name = c.get("name"); inp = c.get("input") or {}
                    if name == "Write":
                        rel = relpath(inp.get("file_path"))
                        if rel and inp.get("content") is not None:
                            events[rel].append((ts, "write", inp["content"]))
                    elif name in ("Edit", "MultiEdit"):
                        rel = relpath(inp.get("file_path"))
                        if rel:
                            if name == "Edit":
                                events[rel].append((ts, "edit",
                                    (inp.get("old_string", ""), inp.get("new_string", ""),
                                     bool(inp.get("replace_all")))))
                            else:
                                for e in inp.get("edits", []):
                                    events[rel].append((ts, "edit",
                                        (e.get("old_string", ""), e.get("new_string", ""),
                                         bool(e.get("replace_all")))))
                    elif name == "Read":
                        rel = relpath(inp.get("file_path"))
                        if rel and not inp.get("offset") and not inp.get("limit"):
                            read_use[c.get("id")] = (rel, ts)
                elif t == "tool_result":
                    tid = c.get("tool_use_id")
                    if tid in read_use:
                        rel, ts0 = read_use.pop(tid)
                        body = c.get("content")
                        if isinstance(body, list):
                            body = "".join(b.get("text", "") for b in body
                                            if isinstance(b, dict))
                        if not isinstance(body, str) or not body.strip():
                            ext = load_external(session_dir, tid)
                            body = ext if ext else None
                        if body:
                            clean, ok = strip_linenums(body)
                            if ok:
                                events[rel].append((ts0, "read", clean))

# Replay each file's events in timestamp order to reconstruct final content.
best = {}
edit_fail = defaultdict(int)
for rel, evs in events.items():
    evs.sort(key=lambda e: e[0])
    state = None; last_src = None; last_ts = ""
    for ts, kind, payload in evs:
        if kind in ("write", "read"):
            state = payload; last_src = kind; last_ts = ts
        elif kind == "edit" and state is not None:
            old, new, allf = payload
            if old and old in state:
                state = state.replace(old, new) if allf else state.replace(old, new, 1)
                last_src = "edit"; last_ts = ts
            else:
                edit_fail[rel] += 1
    if state is not None:
        best[rel] = (last_ts, state, last_src)

# Write staging tree
n = 0
for rel, (ts, content, src) in sorted(best.items()):
    dest = OUT / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")
    n += 1

print(f"recovered {n} files -> {OUT}")
# Summary of key lost files
KEY = ["src-tauri/src/commands/jarvis_commands.rs",
       "src-tauri/src/commands/skills.rs",
       "src-tauri/src/jarvis/hermes/commands.rs",
       "src-tauri/src/jarvis/hermes/state.rs",
       "src-tauri/src/jarvis/hermes/process.rs",
       "src-tauri/src/jarvis/hermes/mod.rs",
       "src-tauri/src/lib.rs",
       "src-ui/src/App.tsx",
       "server-jarvis/src/index.ts"]
print("\nKEY FILES:")
for k in KEY:
    if k in best:
        ts, content, src = best[k]
        print(f"  OK  {len(content):7d}b  src={src:5s}  {k}")
    else:
        print(f"  --  MISSING in transcripts: {k}")
