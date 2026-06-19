import json, glob, os

roots = glob.glob(r"C:\Users\ethan\.gemini\antigravity\brain\*\.system_generated\logs\transcript_full.jsonl")
roots += glob.glob(r"C:\Users\ethan\.gemini\antigravity\brain\*\.system_generated\logs\transcript.jsonl")
targets = ["hermes/commands.rs", "hermes/state.rs", "hermes/process.rs", "hermes/mod.rs",
           "commands/skills.rs", "commands/jarvis_commands.rs", "server-jarvis/src/index.ts",
           "src-ui/src/app.tsx"]

def norm(p):
    return (p or "").replace("\\", "/").lower()

hits = {t: [] for t in targets}
for f in roots:
    try:
        fh = open(f, encoding="utf-8", errors="replace")
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
            for tc in (o.get("tool_calls") or []):
                if not isinstance(tc, dict):
                    continue
                nm = tc.get("name")
                a = tc.get("args") or {}
                tf = norm(a.get("TargetFile") or a.get("AbsolutePath") or a.get("File") or "")
                if not tf:
                    continue
                for t in targets:
                    if tf.endswith(t):
                        clen = len(str(a.get("CodeContent") or a.get("ReplacementContent") or ""))
                        sess = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(f))))
                        hits[t].append((nm, clen, sess, o.get("created_at", "")))

for t in targets:
    print(f"### {t}")
    if not hits[t]:
        print("   (no writes/edits found)")
    for nm, clen, sess, ts in sorted(hits[t], key=lambda x: x[3])[:10]:
        print(f"   {nm:28s} len={clen:6d}  {ts}  sess={sess[:12]}")
