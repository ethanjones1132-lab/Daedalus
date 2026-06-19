#!/usr/bin/env python3
"""Unified home-base recovery from Claude Code + Antigravity (Gemini) transcripts.

For every project file, collect a timestamped event stream from both tools:
  - write  : full content (Claude Write input / Antigravity write_to_file CodeContent)
  - edit   : old->new replacement (Claude Edit / Antigravity replace_file_content)
  - view   : full file content observed (Claude full Read / Antigravity VIEW_FILE)
  - vpart  : a ranged view (line N..M) used to stitch a checkpoint for big files

Replay in timestamp order (write/view = authoritative reset, edit = patch,
stitched vpart coverage = checkpoint). Latest state wins. Output a merged tree.
"""
import json, os, re, glob
from collections import defaultdict
from pathlib import Path

OUT = Path(r"C:\Projects\_recovery\from-transcripts-all")
KEEP_PREFIXES = ("src-tauri/", "src-ui/", "server-jarvis/", "scripts/",
                 "workspace/", "agents/", "docs/")
KEEP_ROOT = {"package.json", "README.md", "CONTEXT.md", "HANDOFF.md", "AGENTS.md",
             "build-optimized.ps1", "build-wsl.sh", ".gitignore", "seed-cron-jobs.sh",
             "automate_inference_metrics.py", "tauri.conf.json"}

def relpath(fp):
    if not fp:
        return None
    s = fp.replace("\\", "/")
    i = s.lower().rfind("/home-base/")
    if i == -1:
        return None
    rel = s[i + len("/home-base/"):].lstrip("/")
    # strip stray quotes/backticks/whitespace and anything after them
    rel = re.split(r'[`"\'\s]', rel, 1)[0]
    if not rel or rel.endswith("/"):
        return None
    if any(ch in rel for ch in '<>:"|?*'):
        return None
    if rel in KEEP_ROOT or any(rel.startswith(p) for p in KEEP_PREFIXES):
        return rel
    return None

# events[rel] = list of (ts, kind, payload)
events = defaultdict(list)

# ---------- Claude Code transcripts ----------
CLAUDE = Path(r"C:\Users\ethan\.claude\projects\--wsl-localhost-ubuntu-mnt-wslg-distro-home-ethan--openclaw-agents-coderclaw-workspace-home-base")
CLINE = re.compile(r"^\s*\d+(?:\t|→)(.*)$")

def strip_ln(text):
    out, matched = [], 0
    for ln in text.split("\n"):
        m = CLINE.match(ln)
        if m:
            out.append(m.group(1)); matched += 1
        elif ln.strip() == "" or ln.startswith("<system-reminder"):
            continue
        else:
            return None
    return "\n".join(out) if matched else None

def mine_claude():
    read_use = {}
    for jf in sorted(CLAUDE.rglob("*.jsonl")):
        sess = jf.with_suffix("")
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
                        nm = c.get("name"); inp = c.get("input") or {}
                        if nm == "Write":
                            rel = relpath(inp.get("file_path"))
                            if rel and inp.get("content") is not None:
                                events[rel].append((ts, "write", inp["content"]))
                        elif nm == "Edit":
                            rel = relpath(inp.get("file_path"))
                            if rel:
                                events[rel].append((ts, "edit", (inp.get("old_string", ""),
                                    inp.get("new_string", ""), bool(inp.get("replace_all")))))
                        elif nm == "Read":
                            rel = relpath(inp.get("file_path"))
                            if rel and not inp.get("offset") and not inp.get("limit"):
                                read_use[c.get("id")] = (rel, ts)
                    elif t == "tool_result":
                        tid = c.get("tool_use_id")
                        if tid in read_use:
                            rel, ts0 = read_use.pop(tid)
                            body = c.get("content")
                            if isinstance(body, list):
                                body = "".join(b.get("text", "") for b in body if isinstance(b, dict))
                            if isinstance(body, str) and body.strip():
                                clean = strip_ln(body)
                                if clean is not None:
                                    events[rel].append((ts0, "view", clean))

# ---------- Antigravity transcripts ----------
AG = glob.glob(r"C:\Users\ethan\.gemini\antigravity\brain\*\.system_generated\logs\transcript_full.jsonl")
AG += glob.glob(r"C:\Users\ethan\.gemini\antigravity\brain\*\.system_generated\logs\transcript.jsonl")
VHEAD = re.compile(r"File Path:\s*`?file://([^`\n]+)`?")
VRANGE = re.compile(r"Showing lines\s+(\d+)\s+to\s+(\d+)")
VTOTAL = re.compile(r"Total Lines:\s*(\d+)")
VLINE = re.compile(r"^(\d+):\ ?(.*)$")

def parse_view(content):
    m = VHEAD.search(content)
    if not m:
        return None
    rel = relpath("/" + m.group(1).lstrip("/"))
    if not rel:
        return None
    total = VTOTAL.search(content)
    total = int(total.group(1)) if total else None
    lines = {}
    for ln in content.split("\n"):
        lm = VLINE.match(ln)
        if lm:
            lines[int(lm.group(1))] = lm.group(2)
    if not lines:
        return None
    return rel, total, lines

def mine_antigravity():
    for jf in AG:
        try:
            fh = open(jf, encoding="utf-8", errors="replace")
        except Exception:
            continue
        with fh:
            for line in fh:
                if "home-base" not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                ts = o.get("created_at", "")
                # writes/edits
                for tc in (o.get("tool_calls") or []):
                    if not isinstance(tc, dict):
                        continue
                    nm = tc.get("name"); a = tc.get("args") or {}
                    if nm == "write_to_file":
                        rel = relpath(a.get("TargetFile"))
                        if rel and a.get("CodeContent") is not None:
                            events[rel].append((ts, "write", a["CodeContent"]))
                    elif nm in ("replace_file_content", "multi_replace_file_content"):
                        rel = relpath(a.get("TargetFile"))
                        if rel and a.get("TargetContent"):
                            events[rel].append((ts, "edit", (a.get("TargetContent", ""),
                                a.get("ReplacementContent", ""), str(a.get("AllowMultiple")) == "True")))
                # view results
                if o.get("type") == "VIEW_FILE" and isinstance(o.get("content"), str):
                    pv = parse_view(o["content"])
                    if pv:
                        rel, total, lines = pv
                        events[rel].append((ts, "vpart", (total, lines)))

mine_claude()
mine_antigravity()

# ---------- replay ----------
best = {}
for rel, evs in events.items():
    evs.sort(key=lambda e: e[0])
    state = None
    linebuf = {}  # for stitching vpart
    buf_total = None
    for ts, kind, payload in evs:
        if kind == "write" or kind == "view":
            state = payload
            linebuf = {}; buf_total = None
        elif kind == "edit" and state is not None:
            old, new, allf = payload
            if old and old in state:
                state = state.replace(new and old, new) if False else (
                    state.replace(old, new) if allf else state.replace(old, new, 1))
        elif kind == "vpart":
            total, lines = payload
            linebuf.update(lines)
            if total:
                buf_total = total
            # if we have full coverage, promote to state
            if buf_total and all(i in linebuf for i in range(1, buf_total + 1)):
                state = "\n".join(linebuf[i] for i in range(1, buf_total + 1))
    # if no full state but we stitched a partial, use best-effort contiguous from 1
    if state is None and linebuf:
        i = 1; acc = []
        while i in linebuf:
            acc.append(linebuf[i]); i += 1
        if acc:
            state = "\n".join(acc)
    if state is not None:
        best[rel] = state

OUT_n = 0
for rel, content in sorted(best.items()):
    dest = OUT / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")
    OUT_n += 1

print(f"recovered {OUT_n} files -> {OUT}")
KEY = ["src-tauri/src/commands/jarvis_commands.rs", "src-tauri/src/commands/skills.rs",
       "src-tauri/src/jarvis/hermes/commands.rs", "src-tauri/src/jarvis/hermes/state.rs",
       "src-tauri/src/jarvis/hermes/process.rs", "src-tauri/src/jarvis/hermes/mod.rs",
       "src-tauri/src/lib.rs", "src-ui/src/App.tsx", "server-jarvis/src/index.ts"]
print("\nKEY FILES:")
for k in KEY:
    if k in best:
        print(f"  OK  {len(best[k]):7d}b  {k}")
    else:
        print(f"  --  MISSING: {k}")
