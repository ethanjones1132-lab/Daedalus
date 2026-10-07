"""Minimal OpenCode Go chat client for the one-shot benchmark (2026-10-07).

The key is read from OpenCode's auth.json (provider "opencode-go") at call time and is never printed or logged.
Kept separate from the Laya v3 plan's scripts/moe-bench/opencode_go.py so the two runs don't share files.
"""
import json
import pathlib
import time
import urllib.error
import urllib.request

BASE = "https://opencode.ai/zen/go/v1"
PREFER = ("deepseek-v4.1-flash", "deepseek-v4-flash")


def read_key():
    path = pathlib.Path.home() / ".local" / "share" / "opencode" / "auth.json"
    entry = json.loads(path.read_text(encoding="utf-8"))["opencode-go"]
    return entry["key"] if isinstance(entry, dict) else entry


def _request(method, path, key, body=None, timeout=1800):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                          "Accept": "application/json", "User-Agent": "oneshot-bench/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def pick_model(key):
    ids = [m["id"] for m in _request("GET", "/models", key, timeout=60)["data"]]
    for want in PREFER:
        hits = sorted(i for i in ids if want in i.lower())
        if hits:
            return hits[0]
    raise RuntimeError(f"no DeepSeek Flash model among {len(ids)} listed")


def chat(key, model, messages, temperature=0.2, max_tokens=32768):
    """Returns {content, reasoning, finish_reason, usage, model, max_tokens}. Retries 429/5xx/network errors three
    times with backoff; on an HTTP 400 that mentions tokens, retries once with max_tokens 16384."""
    body = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    waits = [10, 30, 60]
    attempt = 0
    while True:
        try:
            r = _request("POST", "/chat/completions", key, body)
            choice = r["choices"][0]
            msg = choice.get("message") or {}
            return {"content": msg.get("content") or "", "reasoning": msg.get("reasoning_content") or msg.get("reasoning"),
                    "finish_reason": choice.get("finish_reason"), "usage": r.get("usage"), "model": r.get("model", model),
                    "max_tokens": body["max_tokens"]}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code == 400 and "token" in detail.lower() and body["max_tokens"] > 16384:
                body["max_tokens"] = 16384
                continue
            if (e.code == 429 or e.code >= 500) and attempt < len(waits):
                time.sleep(waits[attempt])
                attempt += 1
                continue
            raise RuntimeError(f"HTTP {e.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < len(waits):
                time.sleep(waits[attempt])
                attempt += 1
                continue
            raise RuntimeError(f"network: {e}") from None
