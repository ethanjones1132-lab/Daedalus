"""Minimal client for OpenCode Go's OpenAI-compatible chat API (Laya v3 spec §2: DeepSeek writes the judge set).
The key is read from OpenCode's auth.json at run time and never printed, logged or put in a URL.

DeepSeek v4.1 Flash reasons before it answers (2026-10-07: 20-25k tokens on a large build), so the default output
budget is 16,384 tokens and the timeout 600 s (the plan had 4,096 and 180 s; deviation recorded in the results doc).
"""
import json
import pathlib
import re
import time
import urllib.error
import urllib.request
import uuid

BASE = "https://opencode.ai/zen/go/v1"
# OpenCode Go requires its own user agent and a stable x-opencode-session per conversation (opencode.ai/docs/go,
# "Where can I use it?"); without the header every chat call is refused with HTTP 400 MissingSessionID (2026-10-07).
USER_AGENT = "laya-v3-judgeset/1.0"
AUTH = pathlib.Path.home() / ".local" / "share" / "opencode" / "auth.json"


def read_key(path=AUTH):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))["opencode-go"]["key"]


def pick_model(ids):
    """The newest DeepSeek Flash id in the endpoint's model list (v4.1 before v4)."""
    flash = [i for i in ids if "deepseek" in i.lower() and "flash" in i.lower() and "free" not in i.lower()]
    if not flash:
        raise LookupError("no DeepSeek Flash model on the endpoint")

    def ver(i):
        m = re.search(r"v(\d+)(?:\.(\d+))?", i)
        return (int(m.group(1)), int(m.group(2) or 0)) if m else (0, 0)
    return max(flash, key=ver)


def extract_json(text):
    """The first top-level JSON object in a reply (fenced or not), or None."""
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    start = text.find("{")
    while start >= 0:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


class Client:
    def __init__(self, key=None, model=None, base=BASE):
        self._key, self.base = key or read_key(), base
        self.session = uuid.uuid4().hex  # one stable session id per client (per writer run)
        self.model = model or pick_model(self.models())

    def __repr__(self):
        return f"Client(model={self.model!r}, base={self.base!r})"

    def _req(self, path, payload=None, timeout=600):
        req = urllib.request.Request(self.base + path, data=None if payload is None else json.dumps(payload).encode(),
                                     method="GET" if payload is None else "POST",
                                     headers={"Content-Type": "application/json", "User-Agent": USER_AGENT,
                                              "x-opencode-session": self.session,
                                              "Authorization": f"Bearer {self._key}"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    def models(self):
        return [m["id"] for m in self._req("/models")["data"]]

    def chat(self, prompt, temperature=0.8, max_tokens=16384, tries=5, json_mode=True, system=None):
        """Reply text. Retries 429/5xx and timeouts with backoff. json_mode asks for a JSON object (dropped on a 400);
        teacher data (scripts/teacher) turns it off for free text and passes the shared system message."""
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
        payload = {"model": self.model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        for k in range(tries):
            try:
                r = self._req("/chat/completions", payload)
                return r["choices"][0]["message"].get("content") or ""
            except urllib.error.HTTPError as e:
                if e.code == 400 and "response_format" in payload:
                    payload.pop("response_format")
                    continue
                if e.code not in (429, 500, 502, 503, 504) or k == tries - 1:
                    raise
            except (urllib.error.URLError, TimeoutError):
                if k == tries - 1:
                    raise
            time.sleep(min(60, 5 * 2 ** k))
        return ""
