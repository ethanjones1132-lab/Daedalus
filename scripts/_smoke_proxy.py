import os, sys, json
os.environ.setdefault("JARVIS_OPENROUTER_API_KEY", "test-key-xxxx")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_cli_proxy as p

print("== resolve_upstream routing ==")
for m in ["nvidia/llama-3.1-nemotron-ultra-253b-v1:free", "qwen/qwen3-coder:free", "qwen3:8b", "claude-sonnet-4-6"]:
    u = p.resolve_upstream(m)
    print(f"{m:30} -> {u['provider']:10} model={u['model']:30} {u['completions_url']}")

print("== live OpenRouter key in config (env override cleared) ==")
os.environ.pop("JARVIS_OPENROUTER_API_KEY", None)
p._OR_KEY_CACHE["key"] = ""; p._OR_KEY_CACHE["ts"] = 0.0
cfgp = os.path.expanduser("~/.openclaw/jarvis/config.json")
try:
    with open(cfgp) as f:
        c = json.load(f)
    k = (c.get("openrouter") or {}).get("api_key") or ""
    print(f"config {cfgp}: openrouter.api_key = {'present len=' + str(len(k)) if k else 'ABSENT'}")
except Exception as e:
    print("config read failed:", e)
print("get_openrouter_key() resolves:", "present" if p.get_openrouter_key() else "absent")
