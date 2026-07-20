"""Jarvis Claude-CLI proxy.

Bilateral Translation Layer that maps Anthropic Messages API schemas on the fly
to OpenAI/Ollama Chat Completions API. Bypasses subprocess wrapping to directly
bridge Claude Code with a backing model, enabling tool calls and optimal
performance.

Upstream routing is per-request, keyed off the requested model id:
  - "vendor/model[:tag]"  + an OpenRouter key  ->  OpenRouter (hosted, remote)
  - bare "qwen3:8b"-style ids                  ->  local Ollama
This lets a Jarvis model profile drive Claude Code with either a large hosted
model or a local quantized one, without restarting the proxy.
"""

from __future__ import annotations

import json
import logging
import os
import ipaddress
import signal
import time
import urllib.request
import urllib.error
import urllib.parse
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

LOG = logging.getLogger("jarvis.claude_cli_proxy")

PORT = int(os.environ.get("JARVIS_CLAUDE_PROXY_PORT", "19878"))
BIND_HOST = os.environ.get("JARVIS_CLAUDE_PROXY_BIND", "127.0.0.1")
OLLAMA_URL = os.environ.get("JARVIS_OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_MODEL = os.environ.get("JARVIS_DEFAULT_MODEL", "gemma4:e4b")
CLAUDE_TIMEOUT = float(os.environ.get("JARVIS_CLAUDE_TIMEOUT", "180"))
LOCAL_ONLY = os.environ.get("JARVIS_CLAUDE_PROXY_LOCAL_ONLY", "1").lower() not in ("0", "false", "no", "off")
LOCAL_HOSTNAMES = {"localhost", "host.docker.internal", "host.containers.internal"}

# ── OpenRouter routing ──────────────────────────────────────────────────────
OPENROUTER_URL = os.environ.get("JARVIS_OPENROUTER_URL", "https://openrouter.ai/api/v1")
OPENROUTER_REFERER = os.environ.get("JARVIS_OPENROUTER_REFERER", "http://localhost:19877")
OPENROUTER_TITLE = os.environ.get("JARVIS_OPENROUTER_TITLE", "Jarvis")
# Only these remote hosts may ever be dialed (deliberate exception to LOCAL_ONLY).
OPENROUTER_HOSTS = {"openrouter.ai"}
# Where to find the user's OpenRouter key if it isn't passed via env.
CONFIG_CANDIDATES = [
    os.environ.get("JARVIS_CONFIG_PATH", ""),
    os.path.expanduser("~/.openclaw/jarvis/config.json"),
]

_OR_KEY_CACHE: dict[str, Any] = {"key": "", "ts": 0.0}


def get_openrouter_key() -> str:
    """Resolve the OpenRouter API key: env override first, else the Jarvis config
    file. Cached briefly so per-request lookups don't hammer the filesystem, while
    still picking up key changes the user makes in settings within ~10s."""
    env_key = os.environ.get("JARVIS_OPENROUTER_API_KEY", "")
    if env_key:
        return env_key

    now = time.time()
    if _OR_KEY_CACHE["key"] and (now - _OR_KEY_CACHE["ts"]) < 10:
        return _OR_KEY_CACHE["key"]

    key = ""
    for path in CONFIG_CANDIDATES:
        if not path:
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            key = (cfg.get("openrouter") or {}).get("api_key") or ""
            if key:
                break
        except Exception:
            continue

    _OR_KEY_CACHE["key"] = key
    _OR_KEY_CACHE["ts"] = now
    return key


def is_local_upstream(url: str) -> bool:
    """Return True only for loopback, private, or local host upstreams."""
    try:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or "").lower()
    except Exception:
        return False

    if not host:
        return False
    if host in LOCAL_HOSTNAMES:
        return True

    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False

    return addr.is_loopback or addr.is_private or addr.is_link_local


def require_local_upstream(url: str) -> None:
    if LOCAL_ONLY and not is_local_upstream(url):
        raise ValueError(f"Refusing non-local Claude proxy upstream: {url}")


def resolve_default_gateway() -> str:
    """Find the default gateway IP inside WSL2 to reach the Windows host."""
    try:
        with open("/proc/net/route", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 8 and parts[1] == "00000000" and parts[7] == "00000000":
                    hex_ip = parts[2]
                    if len(hex_ip) == 8:
                        ip = ".".join(str(int(hex_ip[i:i+2], 16)) for i in (6, 4, 2, 0))
                        LOG.info("Resolved Windows host gateway IP: %s", ip)
                        return ip
    except Exception:
        pass

    try:
        with open("/etc/resolv.conf", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("nameserver"):
                    ip = line.split()[1]
                    LOG.info("Resolved Windows host nameserver IP: %s", ip)
                    return ip
    except Exception:
        pass

    return "127.0.0.1"


def get_ollama_url() -> str:
    """Return the active Ollama URL. Auto-fallback to host gateway if localhost is down."""
    url = OLLAMA_URL
    if "127.0.0.1" in url or "localhost" in url:
        # Check if local Ollama port is open
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.2)
            s.connect(("127.0.0.1", 11434))
            s.close()
            return url
        except Exception:
            # Local port closed, resolve host gateway
            gw = resolve_default_gateway()
            fallback = url.replace("127.0.0.1", gw).replace("localhost", gw)
            LOG.info("Local Ollama unreachable; falling back to host URL: %s", fallback)
            return fallback
    return url


def resolve_upstream(req_model: str) -> dict[str, Any]:
    """Pick the upstream provider for a request based on its model id.

    OpenRouter model ids are namespaced ("vendor/model[:tag]") and need a key.
    Ollama models are bare ("qwen3:8b"). Claude Code may also send sonnet/opus
    placeholders, which fall back to the local default model.
    """
    model = req_model or DEFAULT_MODEL
    or_key = get_openrouter_key()

    if or_key and "/" in model and not model.startswith("claude-"):
        base = OPENROUTER_URL.rstrip("/")
        return {
            "provider": "openrouter",
            "base_url": base,
            "completions_url": f"{base}/chat/completions",
            "model": model,  # keep the full "vendor/model:tag" id
            "auth": f"Bearer {or_key}",
            "extra_headers": {
                "HTTP-Referer": OPENROUTER_REFERER,
                "X-Title": OPENROUTER_TITLE,
            },
            "local": False,
        }

    # Local Ollama. Strip any provider prefix and map claude-* placeholders.
    ollama_model = model.split("/", 1)[1] if "/" in model else model
    if ollama_model.startswith("claude-"):
        ollama_model = DEFAULT_MODEL
    base = get_ollama_url().rstrip("/")
    return {
        "provider": "ollama",
        "base_url": base,
        "completions_url": f"{base}/v1/chat/completions",
        "model": ollama_model,
        "auth": "Bearer ollama",
        "extra_headers": {},
        "local": True,
    }


def patch_claude_settings() -> None:
    """Optimize ~/.claude/settings.json to prevent KV cache slowdowns."""
    settings_path = os.path.expanduser("~/.claude/settings.json")
    try:
        os.makedirs(os.path.dirname(settings_path), exist_ok=True)
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = {}
    except Exception as exc:
        LOG.warning("Could not read Claude settings: %s", exc)
        data = {}

    if "env" not in data or not isinstance(data["env"], dict):
        data["env"] = {}

    if data["env"].get("CLAUDE_CODE_ATTRIBUTION_HEADER") != "0":
        data["env"]["CLAUDE_CODE_ATTRIBUTION_HEADER"] = "0"
        try:
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            LOG.info("Successfully patched ~/.claude/settings.json with attribution header disabled.")
        except Exception as exc:
            LOG.error("Failed to patch ~/.claude/settings.json: %s", exc)


def anthropic_to_openai_tools(anthropic_tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translates Claude Code tool schemas into Ollama/OpenAI format."""
    openai_tools = []
    for tool in anthropic_tools:
        openai_tools.append({
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {"type": "object", "properties": {}})
            }
        })
    return openai_tools


def openai_to_anthropic_response(openai_choice: dict[str, Any]) -> dict[str, Any]:
    """Translates Ollama's tool calls into the content block Claude Code expects."""
    anthropic_content = []
    message = openai_choice.get("message", {})

    if message.get("content"):
        anthropic_content.append({"type": "text", "text": message["content"]})

    if "tool_calls" in message:
        for tool_call in message["tool_calls"]:
            try:
                parsed_input = json.loads(tool_call["function"]["arguments"])
            except Exception:
                parsed_input = tool_call["function"]["arguments"]

            anthropic_content.append({
                "type": "tool_use",
                "id": tool_call.get("id", f"toolu_{tool_call['function']['name']}"),
                "name": tool_call["function"]["name"],
                "input": parsed_input
            })

    return {
        "role": "assistant",
        "content": anthropic_content
    }


def map_history_messages(anthropic_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Patches the conversation loop history so the model can trace prior tool results."""
    openai_messages = []
    for msg in anthropic_messages:
        role = msg["role"]
        content = msg["content"]

        if isinstance(content, list):
            text_parts = []
            tool_calls = []
            tool_results = []

            for block in content:
                if block.get("type") == "text":
                    text_parts.append(block["text"])
                elif block.get("type") == "tool_use":
                    tool_calls.append({
                        "id": block["id"],
                        "type": "function",
                        "function": {
                            "name": block["name"],
                            "arguments": json.dumps(block["input"])
                        }
                    })
                elif block.get("type") == "tool_result":
                    tool_results.append({
                        "role": "tool",
                        "tool_call_id": block["tool_use_id"],
                        "content": str(block.get("content", ""))
                    })

            if tool_results:
                for tr in tool_results:
                    openai_messages.append(tr)
            else:
                msg_obj = {"role": role}
                if text_parts:
                    msg_obj["content"] = "\n".join(text_parts)
                if tool_calls:
                    msg_obj["tool_calls"] = tool_calls
                openai_messages.append(msg_obj)
        else:
            openai_messages.append({"role": role, "content": content})

    return openai_messages


def translate_openai_response_to_anthropic(openai_resp: dict[str, Any], model_name: str) -> dict[str, Any]:
    """Translates the full non-streaming OpenAI response into Anthropic format."""
    choices = openai_resp.get("choices", [])
    if not choices:
        return {}

    choice = choices[0]
    mapped_msg = openai_to_anthropic_response(choice)

    finish_reason = choice.get("finish_reason")
    stop_reason = "end_turn"
    if finish_reason == "tool_calls" or "tool_calls" in choice.get("message", {}):
        stop_reason = "tool_use"
    elif finish_reason == "length":
        stop_reason = "max_tokens"

    usage = openai_resp.get("usage", {})

    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model_name,
        "content": mapped_msg["content"],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        }
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        LOG.info("%s - %s", self.address_string(), format % args)

    def _write_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        LOG.info("GET %s (path=%s)", self.path, path)
        if path in ("/", "/health"):
            resolved = get_ollama_url()
            self._write_json(200, {
                "status": "ok",
                "model": DEFAULT_MODEL,
                "bind": BIND_HOST,
                "ollama": OLLAMA_URL,
                "resolved_ollama": resolved,
                "local_only": LOCAL_ONLY,
                "upstream_allowed": is_local_upstream(resolved),
                "openrouter_enabled": bool(get_openrouter_key()),
            })
            return
        if path == "/v1/models":
            self._write_json(200, {
                "data": [
                    {"id": DEFAULT_MODEL, "type": "model"},
                    {"id": "claude-sonnet-4-6", "type": "model"},
                    {"id": "claude-opus-4-7", "type": "model"},
                    {"id": "claude-3-7-sonnet-20250219", "type": "model"}
                ],
            })
            return
        self._write_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        # Strip query parameters for path matching
        path = self.path.split("?")[0]
        LOG.info("POST %s (path=%s)", self.path, path)
        if path != "/v1/messages":
            self._write_json(404, {"error": "not found", "path": self.path})
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            self._write_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}})
            return

        # Per-request upstream selection (Ollama vs OpenRouter) keyed off model id.
        upstream = resolve_upstream(req.get("model") or DEFAULT_MODEL)
        model = upstream["model"]

        # Bilateral Translation: Anthropic -> OpenAI
        openai_messages = map_history_messages(req.get("messages", []))

        system_prompt = req.get("system", "")
        if system_prompt:
            if isinstance(system_prompt, list):
                system_text = "\n".join(
                    s.get("text", "") if isinstance(s, dict) else str(s)
                    for s in system_prompt
                )
            else:
                system_text = str(system_prompt)
            openai_messages.insert(0, {"role": "system", "content": system_text})

        openai_tools = None
        if "tools" in req:
            openai_tools = anthropic_to_openai_tools(req["tools"])

        stream = req.get("stream", False)

        payload = {
            "model": model,
            "messages": openai_messages,
            "stream": stream
        }
        if "temperature" in req:
            payload["temperature"] = req["temperature"]
        if "top_p" in req:
            payload["top_p"] = req["top_p"]
        if "max_tokens" in req:
            payload["max_tokens"] = req["max_tokens"]
        if openai_tools:
            payload["tools"] = openai_tools

        # Validate the chosen upstream. Local upstreams honour LOCAL_ONLY; the
        # OpenRouter exception is constrained to the known host + a present key.
        if upstream["local"]:
            try:
                require_local_upstream(upstream["base_url"])
            except ValueError as exc:
                LOG.error("%s", exc)
                self._write_json(502, {"error": {"type": "local_only_violation", "message": str(exc)}})
                return
        else:
            host = (urllib.parse.urlparse(upstream["base_url"]).hostname or "").lower()
            if host not in OPENROUTER_HOSTS:
                msg = f"Refusing unknown remote upstream host: {host}"
                LOG.error("%s", msg)
                self._write_json(502, {"error": {"type": "upstream_rejected", "message": msg}})
                return
            if not get_openrouter_key():
                self._write_json(401, {"error": {"type": "authentication_error", "message": "OpenRouter API key not configured"}})
                return

        completions_url = upstream["completions_url"]
        headers = {
            "Content-Type": "application/json",
            "Authorization": upstream["auth"],
            **upstream["extra_headers"],
        }

        req_obj = urllib.request.Request(
            completions_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )

        LOG.info("Bilateral proxying %s request to %s [%s] (stream=%s)", model, completions_url, upstream["provider"], stream)
        LOG.info("Upstream payload: %s", json.dumps(payload, indent=2)[:2000])

        if not stream:
            try:
                with urllib.request.urlopen(req_obj, timeout=CLAUDE_TIMEOUT) as response:
                    resp_data = response.read().decode("utf-8")
                    openai_resp = json.loads(resp_data)
                    anthropic_resp = translate_openai_response_to_anthropic(openai_resp, model)
                    self._write_json(200, anthropic_resp)
            except urllib.error.HTTPError as exc:
                err_content = exc.read().decode("utf-8")
                LOG.error("Upstream API Error: %s", err_content)
                self._write_json(exc.code, {"error": {"type": "api_error", "message": err_content}})
            except Exception as exc:
                LOG.exception("Upstream dispatch failed")
                self._write_json(500, {"error": {"type": "internal_error", "message": str(exc)}})
        else:
            try:
                # Setup streaming headers
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                msg_id = f"msg_{uuid.uuid4().hex[:24]}"
                content_block_started = False
                active_tool_calls = {}

                # Send initial message_start
                message_start = {
                    "type": "message_start",
                    "message": {
                        "id": msg_id,
                        "type": "message",
                        "role": "assistant",
                        "model": model,
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 0, "output_tokens": 0}
                    }
                }
                self.wfile.write(f"data: {json.dumps(message_start)}\n\n".encode("utf-8"))
                self.wfile.flush()

                with urllib.request.urlopen(req_obj, timeout=CLAUDE_TIMEOUT) as response:
                    for line_bytes in response:
                        line = line_bytes.decode("utf-8").strip()
                        if not line:
                            continue
                        if line.startswith("data:"):
                            data_str = line[5:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                            except Exception:
                                continue

                            choices = chunk.get("choices", [])
                            if not choices:
                                continue
                            choice = choices[0]
                            delta = choice.get("delta", {})

                            # Text chunks mapping
                            content = delta.get("content")
                            if content:
                                if not content_block_started:
                                    block_start = {
                                        "type": "content_block_start",
                                        "index": 0,
                                        "content_block": {"type": "text", "text": ""}
                                    }
                                    self.wfile.write(f"data: {json.dumps(block_start)}\n\n".encode("utf-8"))
                                    content_block_started = True

                                block_delta = {
                                    "type": "content_block_delta",
                                    "index": 0,
                                    "delta": {"type": "text_delta", "text": content}
                                }
                                self.wfile.write(f"data: {json.dumps(block_delta)}\n\n".encode("utf-8"))
                                self.wfile.flush()

                            # Tool chunks mapping
                            tool_calls = delta.get("tool_calls")
                            if tool_calls:
                                for tc in tool_calls:
                                    idx = tc.get("index", 0)
                                    if idx not in active_tool_calls:
                                        tc_id = tc.get("id") or f"toolu_{uuid.uuid4().hex[:12]}"
                                        tc_name = tc.get("function", {}).get("name") or ""
                                        active_tool_calls[idx] = {
                                            "id": tc_id,
                                            "name": tc_name,
                                            "arguments": ""
                                        }
                                        block_start = {
                                            "type": "content_block_start",
                                            "index": idx + 1,
                                            "content_block": {
                                                "type": "tool_use",
                                                "id": tc_id,
                                                "name": tc_name,
                                                "input": {}
                                            }
                                        }
                                        self.wfile.write(f"data: {json.dumps(block_start)}\n\n".encode("utf-8"))
                                        self.wfile.flush()

                                    active_tc = active_tool_calls[idx]
                                    tc_args_delta = tc.get("function", {}).get("arguments") or ""
                                    if tc_args_delta:
                                        active_tc["arguments"] += tc_args_delta
                                        block_delta = {
                                            "type": "content_block_delta",
                                            "index": idx + 1,
                                            "delta": {"type": "input_delta", "partial_json": tc_args_delta}
                                        }
                                        self.wfile.write(f"data: {json.dumps(block_delta)}\n\n".encode("utf-8"))
                                        self.wfile.flush()

                # Clean up stream blocks
                if content_block_started:
                    block_stop = {"type": "content_block_stop", "index": 0}
                    self.wfile.write(f"data: {json.dumps(block_stop)}\n\n".encode("utf-8"))

                for idx in active_tool_calls:
                    block_stop = {"type": "content_block_stop", "index": idx + 1}
                    self.wfile.write(f"data: {json.dumps(block_stop)}\n\n".encode("utf-8"))

                stop_reason = "tool_use" if active_tool_calls else "end_turn"
                message_delta = {
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": stop_reason,
                        "stop_sequence": None
                    },
                    "usage": {"output_tokens": 0}
                }
                self.wfile.write(f"data: {json.dumps(message_delta)}\n\n".encode("utf-8"))

                message_stop = {"type": "message_stop"}
                self.wfile.write(f"data: {json.dumps(message_stop)}\n\n".encode("utf-8"))
                self.wfile.flush()

            except Exception as exc:
                LOG.error("Streaming error: %s", exc)
                error_event = {
                    "type": "error",
                    "error": {"type": "api_error", "message": str(exc)}
                }
                try:
                    self.wfile.write(f"data: {json.dumps(error_event)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except Exception:
                    pass


def main() -> None:
    # Ignore SIGPIPE so `python3 claude_cli_proxy.py | head -N` pipelines don't
    # kill the server when the reader closes early.
    sigpipe = getattr(signal, "SIGPIPE", None)
    if sigpipe is not None:
        signal.signal(sigpipe, signal.SIG_IGN)

    logging.basicConfig(
        level=os.environ.get("JARVIS_LOG_LEVEL", "INFO"),
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )

    # Auto-patch Claude settings on start
    patch_claude_settings()

    LOG.info("ollama upstream (default): %s", OLLAMA_URL)
    LOG.info("local-only mode: %s", LOCAL_ONLY)
    LOG.info("default model: %s", DEFAULT_MODEL)
    LOG.info("openrouter: %s (key %s)", OPENROUTER_URL, "present" if get_openrouter_key() else "absent")

    server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    LOG.info("listening on http://%s:%d/v1/messages", BIND_HOST, PORT)

    # Write startup status to stdout so `| head -N` pipelines get data and exit
    # cleanly instead of waiting forever (logging goes to stderr, not stdout).
    print(f"jarvis-proxy: ok", flush=True)
    print(f"model: {DEFAULT_MODEL}", flush=True)
    print(f"port: {PORT}", flush=True)
    print(f"ollama: {OLLAMA_URL}", flush=True)
    print(f"ready: true", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
