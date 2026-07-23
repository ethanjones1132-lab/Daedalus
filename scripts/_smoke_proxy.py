import os, sys, json
os.environ.setdefault("JARVIS_OPENROUTER_API_KEY", "test-key-xxxx")
os.environ.setdefault("JARVIS_OPENCODE_GO_API_KEY", "go-test-key-xxxx")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_cli_proxy as p

print("== resolve_upstream routing ==")
for m in [
    "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
    "qwen/qwen3-coder:free",
    "qwen3:8b",
    "claude-sonnet-4-6",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "opencode_go/deepseek-v4-flash",
    "minimax-m3",
]:
    u = p.resolve_upstream(m)
    print(f"{m:45} -> {u['provider']:12} model={u['model']:30} {u['completions_url']}")
print("opencode_go openai models:", sorted(p.get_opencode_go_openai_models())[:6], "...")
print("allowed remote hosts:", sorted(p.ALLOWED_REMOTE_HOSTS))

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
