"""Jarvis Claude-CLI proxy.

Bilateral Translation Layer that maps Anthropic Messages API schemas on the fly
to OpenAI/Ollama Chat Completions API. Bypasses subprocess wrapping to directly
bridge Claude Code with a backing model, enabling tool calls and optimal
performance.

Upstream routing is per-request, keyed off the requested model id:
  - known OpenCode Go OpenAI-format ids + Go key  ->  OpenCode Go (hosted)
  - "vendor/model[:tag]"  + an OpenRouter key     ->  OpenRouter (hosted, remote)
  - bare "qwen3:8b"-style ids                     ->  local Ollama
This lets a Jarvis model profile drive Claude Code with either a large hosted
model or a local quantized one, without restarting the proxy.

OpenCode Go Anthropic-native models (minimax-m*, qwen3.*-plus/max) skip this
proxy entirely and talk point-to-point from the Bun server (see claude-cli.ts).
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import ipaddress
import re
import signal
import socket
import time
import urllib.request
import urllib.error
import urllib.parse
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping

LOG = logging.getLogger("jarvis.claude_cli_proxy")

PORT = int(os.environ.get("JARVIS_CLAUDE_PROXY_PORT", "19878"))
BIND_HOST = os.environ.get("JARVIS_CLAUDE_PROXY_BIND", "127.0.0.1")
OLLAMA_URL = os.environ.get("JARVIS_OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_MODEL = os.environ.get("JARVIS_DEFAULT_MODEL", "qwen3:8b")
CLAUDE_TIMEOUT = float(os.environ.get("JARVIS_CLAUDE_TIMEOUT", "180"))
LOCAL_ONLY = os.environ.get("JARVIS_CLAUDE_PROXY_LOCAL_ONLY", "1").lower() not in ("0", "false", "no", "off")
LOCAL_HOSTNAMES = {"localhost", "host.docker.internal", "host.containers.internal"}

# Correlate proxy logs with stage_runs.diagnostic_json.delegate_request_id.
#
# The proxy is a long-lived server. Process-env JARVIS_DELEGATE_REQUEST_ID is
# only a test/fallback path — production correlation is per HTTP request via
# X-Jarvis-Delegate-Request-Id (Claude CLI forwards ANTHROPIC_CUSTOM_HEADERS).
DELEGATE_REQUEST_ID_HEADER = "X-Jarvis-Delegate-Request-Id"
_DELEGATE_REQUEST_ID_SAFE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def sanitize_delegate_request_id(raw: str | None) -> str:
    """Return a log-safe request id, or empty string if unusable."""
    if not raw:
        return ""
    value = raw.strip()
    if not value or len(value) > 128:
        return ""
    lower = value.lower()
    # Never treat auth material as a correlation id.
    if lower.startswith("bearer ") or "authorization" in lower:
        return ""
    if not _DELEGATE_REQUEST_ID_SAFE.fullmatch(value):
        return ""
    return value


def get_delegate_request_id(headers: Mapping[str, str] | None = None) -> str:
    """Resolve delegate_request_id for the current request.

    Priority:
      1. Per-request header X-Jarvis-Delegate-Request-Id (production path)
      2. JARVIS_DELEGATE_REQUEST_ID env (tests / same-process launches)
      3. "missing"
    """
    if headers is not None:
        # BaseHTTPRequestHandler headers are case-insensitive; Mapping.get may not be.
        header_val = ""
        try:
            header_val = headers.get(DELEGATE_REQUEST_ID_HEADER) or headers.get(
                DELEGATE_REQUEST_ID_HEADER.lower()
            ) or ""
        except Exception:
            # Some mappings only support exact keys — scan case-insensitively.
            want = DELEGATE_REQUEST_ID_HEADER.lower()
            for key, value in headers.items():
                if str(key).lower() == want:
                    header_val = value
                    break
        sanitized = sanitize_delegate_request_id(
            header_val if isinstance(header_val, str) else str(header_val or "")
        )
        if sanitized:
            return sanitized

    env_val = sanitize_delegate_request_id(os.environ.get("JARVIS_DELEGATE_REQUEST_ID", ""))
    return env_val or "missing"


def reset_delegate_request_id_cache() -> None:
    """Back-compat no-op (process-level cache removed; correlation is per-request)."""
    return None


def delegate_correlation_field(
    headers: Mapping[str, str] | None = None,
    *,
    request_id: str | None = None,
) -> str:
    rid = request_id if request_id is not None else get_delegate_request_id(headers)
    return f"delegate_request_id={rid}"


# ── Transport-level retry (not model cascade) ────────────────────────────────
# Free-tier upstreams drop connections after accepting (200) mid-stream. The
# Conductor owns model-selection retry; nobody owned transport retry, so a
# TCP reset discarded productive delegate work (run_8e930248). Retry only
# transport failures, only before any content has been emitted to the client.
TRANSPORT_RETRY_ATTEMPTS = int(os.environ.get("JARVIS_PROXY_TRANSPORT_RETRIES", "3"))
TRANSPORT_RETRY_BACKOFF_S = float(os.environ.get("JARVIS_PROXY_TRANSPORT_BACKOFF", "0.25"))


def is_transport_error(exc: BaseException) -> bool:
    """True for connection drops / incomplete reads / timeouts — not HTTP 4xx."""
    if isinstance(exc, urllib.error.HTTPError):
        return False
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError)):
        return True
    if isinstance(exc, socket.timeout):
        return True
    if isinstance(exc, http.client.IncompleteRead):
        return True
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError, socket.timeout)):
            return True
        # DNS / refused / reset often wrap as URLError(OSError)
        if isinstance(reason, OSError):
            return True
        return True  # generic URLError is transport-ish; HTTPError is separate
    # WinError 10054 often surfaces as OSError / ConnectionResetError subclass
    if isinstance(exc, OSError):
        winerr = getattr(exc, "winerror", None)
        if winerr in (10054, 10053, 10060):  # reset, aborted, timeout
            return True
        err = getattr(exc, "errno", None)
        if err in (104, 54, 110, 10054):  # ECONNRESET variants
            return True
    return False


def open_upstream_with_retry(
    req_obj: urllib.request.Request,
    *,
    timeout: float = CLAUDE_TIMEOUT,
    attempts: int = TRANSPORT_RETRY_ATTEMPTS,
    backoff_s: float = TRANSPORT_RETRY_BACKOFF_S,
    sleep_fn: Callable[[float], None] = time.sleep,
    urlopen_fn: Callable[..., Any] = urllib.request.urlopen,
    log: logging.Logger | None = None,
    correlation: str | None = None,
) -> Any:
    """Open upstream with bounded transport retries. Never retries HTTPError 4xx/5xx.

    Caller must not have written to the client yet — a failure here is still
    invisible and safe to retry. Once the returned response is live, the
    streaming loop applies its own content-emitted guard.
    """
    logger = log or LOG
    corr = correlation if correlation is not None else delegate_correlation_field()
    last_exc: BaseException | None = None
    tries = max(1, attempts)
    for attempt in range(1, tries + 1):
        try:
            return urlopen_fn(req_obj, timeout=timeout)
        except urllib.error.HTTPError:
            # Genuine upstream rejection (auth, bad model, context length) — fail fast.
            raise
        except Exception as exc:
            last_exc = exc
            if not is_transport_error(exc) or attempt >= tries:
                raise
            logger.warning(
                "upstream transport retry attempt=%s/%s reason=%s: %s %s",
                attempt,
                tries,
                type(exc).__name__,
                exc,
                corr,
            )
            sleep_fn(backoff_s * attempt)
    assert last_exc is not None
    raise last_exc


# ── Remote hosted routing (OpenRouter + OpenCode Go) ────────────────────────
OPENROUTER_URL = os.environ.get("JARVIS_OPENROUTER_URL", "https://openrouter.ai/api/v1")
OPENROUTER_REFERER = os.environ.get("JARVIS_OPENROUTER_REFERER", "http://localhost:19877")
OPENROUTER_TITLE = os.environ.get("JARVIS_OPENROUTER_TITLE", "Jarvis")
DEFAULT_OPENCODE_GO_URL = "https://opencode.ai/zen/go/v1"
# Only these remote hosts may ever be dialed (deliberate exception to LOCAL_ONLY).
ALLOWED_REMOTE_HOSTS = {"openrouter.ai", "opencode.ai"}
# Back-compat alias — older call sites/tests may still reference this name.
OPENROUTER_HOSTS = ALLOWED_REMOTE_HOSTS
# Default on-disk config path (always last). JARVIS_CONFIG_PATH is resolved at
# read time so tests can isolate from the live ~/.openclaw config.
DEFAULT_CONFIG_PATH = os.path.expanduser("~/.openclaw/jarvis/config.json")
# Synced export of openCodeGoOpenaiFormatModelIds() — see live-model-catalog.ts.
OPENCODE_GO_MODELS_JSON = "opencode_go_openai_models.json"


def config_candidates() -> list[str]:
    """Ordered config paths: env override first, then the default home path."""
    return [
        os.environ.get("JARVIS_CONFIG_PATH", ""),
        DEFAULT_CONFIG_PATH,
    ]


# Back-compat for callers that still read the module-level list.
CONFIG_CANDIDATES = config_candidates()

_OR_KEY_CACHE: dict[str, Any] = {"key": "", "ts": 0.0}
_GO_KEY_CACHE: dict[str, Any] = {"key": "", "ts": 0.0}
_GO_URL_CACHE: dict[str, Any] = {"url": "", "ts": 0.0}
_GO_MODELS_CACHE: dict[str, Any] = {"models": frozenset(), "ts": 0.0}


def _load_jarvis_config() -> dict[str, Any]:
    """Return the first readable Jarvis config dict, or {}."""
    for path in config_candidates():
        if not path:
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if isinstance(cfg, dict):
                return cfg
        except Exception:
            continue
    return {}


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

    key = (_load_jarvis_config().get("openrouter") or {}).get("api_key") or ""

    _OR_KEY_CACHE["key"] = key
    _OR_KEY_CACHE["ts"] = now
    return key


def get_opencode_go_key() -> str:
    """Resolve the OpenCode Go API key: env override first, else cfg.opencode_go."""
    env_key = (
        os.environ.get("JARVIS_OPENCODE_GO_API_KEY", "")
        or os.environ.get("OPENCODE_GO_API_KEY", "")
        or os.environ.get("OPENCODE_GO_KEY", "")
    )
    if env_key:
        return env_key

    now = time.time()
    if _GO_KEY_CACHE["key"] and (now - _GO_KEY_CACHE["ts"]) < 10:
        return _GO_KEY_CACHE["key"]

    key = (_load_jarvis_config().get("opencode_go") or {}).get("api_key") or ""

    _GO_KEY_CACHE["key"] = key
    _GO_KEY_CACHE["ts"] = now
    return key


def get_opencode_go_base_url() -> str:
    """Resolve OpenCode Go base URL: env, then cfg.opencode_go.base_url, then default."""
    env_url = os.environ.get("JARVIS_OPENCODE_GO_URL", "").strip()
    if env_url:
        return env_url.rstrip("/")

    now = time.time()
    if _GO_URL_CACHE["url"] and (now - _GO_URL_CACHE["ts"]) < 10:
        return _GO_URL_CACHE["url"]

    url = ((_load_jarvis_config().get("opencode_go") or {}).get("base_url") or "").strip()
    if not url:
        url = DEFAULT_OPENCODE_GO_URL
    url = url.rstrip("/")

    _GO_URL_CACHE["url"] = url
    _GO_URL_CACHE["ts"] = now
    return url


def _opencode_go_model_json_candidates() -> list[str]:
    """Paths that may hold the synced OpenAI-format OpenCode Go model list."""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.environ.get("JARVIS_OPENCODE_GO_MODELS_PATH", ""),
        os.path.join(here, OPENCODE_GO_MODELS_JSON),
        # Deployed next to the proxy under resources/
        os.path.join(here, "resources", OPENCODE_GO_MODELS_JSON),
        os.path.expanduser(f"~/.openclaw/jarvis/{OPENCODE_GO_MODELS_JSON}"),
    ]
    for cfg_path in config_candidates():
        if cfg_path:
            candidates.append(os.path.join(os.path.dirname(cfg_path), OPENCODE_GO_MODELS_JSON))
    return candidates


def get_opencode_go_openai_models() -> frozenset[str]:
    """OpenAI-format OpenCode Go model ids the proxy may route.

    Source of truth is OPENCODE_GO_COST_RANKS in live-model-catalog.ts (openai
    protocol subset). Resolution order:
      1. JARVIS_OPENCODE_GO_OPENAI_MODELS env (comma-separated; tests)
      2. cfg.opencode_go.openai_format_models (optional runtime override)
      3. scripts/opencode_go_openai_models.json (synced export next to proxy)
    """
    env_list = os.environ.get("JARVIS_OPENCODE_GO_OPENAI_MODELS", "").strip()
    if env_list:
        return frozenset(m.strip() for m in env_list.split(",") if m.strip())

    now = time.time()
    if _GO_MODELS_CACHE["models"] and (now - _GO_MODELS_CACHE["ts"]) < 10:
        return _GO_MODELS_CACHE["models"]

    models: set[str] = set()

    cfg_models = (_load_jarvis_config().get("opencode_go") or {}).get("openai_format_models")
    if isinstance(cfg_models, list) and cfg_models:
        models = {str(m).strip() for m in cfg_models if str(m).strip()}
    else:
        for path in _opencode_go_model_json_candidates():
            if not path or not os.path.isfile(path):
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    payload = json.load(f)
                raw = payload.get("models") if isinstance(payload, dict) else payload
                if isinstance(raw, list):
                    models = {str(m).strip() for m in raw if str(m).strip()}
                    if models:
                        break
            except Exception:
                continue

    frozen = frozenset(models)
    _GO_MODELS_CACHE["models"] = frozen
    _GO_MODELS_CACHE["ts"] = now
    return frozen


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


def _normalize_opencode_go_model_id(req_model: str) -> str:
    """Strip optional opencode_go/ provider prefix from a requested model id."""
    model = (req_model or "").strip()
    if model.startswith("opencode_go/"):
        return model.split("/", 1)[1].strip()
    return model


def resolve_upstream(req_model: str) -> dict[str, Any]:
    """Pick the upstream provider for a request based on its model id.

    Priority (single-shot; no cascade — Conductor owns multi-candidate retry):
      1. Known OpenCode Go OpenAI-format model + Go key  -> opencode_go
      2. Namespaced "vendor/model[:tag]" + OpenRouter key -> openrouter
      3. Bare Ollama ids / claude-* placeholders          -> ollama
    """
    model = req_model or DEFAULT_MODEL

    go_model = _normalize_opencode_go_model_id(model)
    go_key = get_opencode_go_key()
    if go_key and go_model in get_opencode_go_openai_models():
        base = get_opencode_go_base_url()
        return {
            "provider": "opencode_go",
            "base_url": base,
            "completions_url": f"{base}/chat/completions",
            "model": go_model,
            "auth": f"Bearer {go_key}",
            "extra_headers": {},
            "local": False,
        }

    or_key = get_openrouter_key()
    if or_key and "/" in model and not model.startswith("claude-") and not model.startswith("opencode_go/"):
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
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, x-api-key, anthropic-version, "
            "x-jarvis-delegate-request-id",
        )
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
        # Per-request header from Claude CLI ANTHROPIC_CUSTOM_HEADERS — not process env.
        correlation = delegate_correlation_field(self.headers)
        LOG.info("POST %s (path=%s) %s", self.path, path, correlation)
        if path != "/v1/messages":
            self._write_json(404, {"error": "not found", "path": self.path})
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            LOG.error("request parse error %s: %s", correlation, exc)
            self._write_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}})
            return

        # Per-request upstream selection (Ollama vs OpenRouter) keyed off model id.
        upstream = resolve_upstream(req.get("model") or DEFAULT_MODEL)
        model = upstream["model"]
        LOG.info("request start model=%s %s", model, correlation)

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

        # Validate the chosen upstream. Local upstreams honour LOCAL_ONLY; remote
        # exceptions are constrained to the allow-listed host + a present key.
        if upstream["local"]:
            try:
                require_local_upstream(upstream["base_url"])
            except ValueError as exc:
                LOG.error("%s", exc)
                self._write_json(502, {"error": {"type": "local_only_violation", "message": str(exc)}})
                return
        else:
            host = (urllib.parse.urlparse(upstream["base_url"]).hostname or "").lower()
            if host not in ALLOWED_REMOTE_HOSTS:
                msg = f"Refusing unknown remote upstream host: {host}"
                LOG.error("%s", msg)
                self._write_json(502, {"error": {"type": "upstream_rejected", "message": msg}})
                return
            if upstream["provider"] == "opencode_go":
                if not get_opencode_go_key():
                    self._write_json(401, {
                        "error": {
                            "type": "authentication_error",
                            "message": "OpenCode Go API key not configured",
                        }
                    })
                    return
            elif not get_openrouter_key():
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

        LOG.info(
            "Bilateral proxying %s request to %s [%s] (stream=%s) %s",
            model, completions_url, upstream["provider"], stream, correlation,
        )
        LOG.info(
            "Upstream turn shape: %s %s",
            [
                m.get("role") + ("+tool_calls" if m.get("tool_calls") else "")
                for m in payload.get("messages", [])
            ],
            correlation,
        )
        LOG.info("Upstream payload: %s %s", json.dumps(payload, indent=2)[:2000], correlation)

        if not stream:
            try:
                with open_upstream_with_retry(
                    req_obj, timeout=CLAUDE_TIMEOUT, correlation=correlation,
                ) as response:
                    resp_data = response.read().decode("utf-8")
                    openai_resp = json.loads(resp_data)
                    anthropic_resp = translate_openai_response_to_anthropic(openai_resp, model)
                    LOG.info("upstream result status=200 %s", correlation)
                    self._write_json(200, anthropic_resp)
            except urllib.error.HTTPError as exc:
                err_content = exc.read().decode("utf-8")
                LOG.error("Upstream API Error %s: %s", correlation, err_content)
                self._write_json(exc.code, {"error": {"type": "api_error", "message": err_content}})
            except Exception as exc:
                LOG.exception("Upstream dispatch failed %s", correlation)
                self._write_json(500, {"error": {"type": "internal_error", "message": str(exc)}})
        else:
            # Open upstream BEFORE headers / message_start so transport failures
            # are invisible to the client and safely retryable. Once content
            # has been emitted, never retry (would duplicate output).
            content_emitted = False
            headers_sent = False
            try:
                msg_id = f"msg_{uuid.uuid4().hex[:24]}"
                # Anthropic requires content block indices to start at 0 and be
                # contiguous, so blocks are numbered in emission order rather
                # than reserving index 0 for text that may never arrive.
                next_block_index = 0
                text_block_index = None
                active_tool_calls: dict = {}

                def emit(event_type: str, payload: dict) -> None:
                    self.wfile.write(f"event: {event_type}\n".encode("utf-8"))
                    self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
                    self.wfile.flush()

                stream_attempts = max(1, TRANSPORT_RETRY_ATTEMPTS)
                last_stream_exc: BaseException | None = None
                for stream_attempt in range(1, stream_attempts + 1):
                    try:
                        # Fresh open each attempt (retry only pre-content).
                        response = open_upstream_with_retry(
                            req_obj,
                            timeout=CLAUDE_TIMEOUT,
                            attempts=1,  # outer loop owns multi-attempt for stream
                            correlation=correlation,
                        )
                        try:
                            if not headers_sent:
                                # Setup streaming headers only after upstream is alive.
                                self.send_response(200)
                                self.send_header("Content-Type", "text/event-stream")
                                self.send_header("Cache-Control", "no-cache")
                                # The SSE body has neither Content-Length nor chunked framing, so
                                # it is delimited only by connection close. Advertising
                                # keep-alive here makes strict clients (Node/undici, which the
                                # Claude CLI uses) wait forever for a delimiter that never
                                # arrives; curl is lenient and masks this.
                                self.send_header("Connection", "close")
                                self.close_connection = True
                                self.send_header("Access-Control-Allow-Origin", "*")
                                self.end_headers()
                                headers_sent = True

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
                                emit("message_start", message_start)

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
                                        content_emitted = True
                                        if text_block_index is None:
                                            text_block_index = next_block_index
                                            next_block_index += 1
                                            emit("content_block_start", {
                                                "type": "content_block_start",
                                                "index": text_block_index,
                                                "content_block": {"type": "text", "text": ""}
                                            })

                                        emit("content_block_delta", {
                                            "type": "content_block_delta",
                                            "index": text_block_index,
                                            "delta": {"type": "text_delta", "text": content}
                                        })

                                    # Tool chunks mapping
                                    tool_calls = delta.get("tool_calls")
                                    if tool_calls:
                                        for tc in tool_calls:
                                            idx = tc.get("index", 0)
                                            if idx not in active_tool_calls:
                                                content_emitted = True
                                                tc_id = tc.get("id") or f"toolu_{uuid.uuid4().hex[:12]}"
                                                tc_name = tc.get("function", {}).get("name") or ""
                                                block_index = next_block_index
                                                next_block_index += 1
                                                active_tool_calls[idx] = {
                                                    "id": tc_id,
                                                    "name": tc_name,
                                                    "arguments": "",
                                                    "block_index": block_index
                                                }
                                                emit("content_block_start", {
                                                    "type": "content_block_start",
                                                    "index": block_index,
                                                    "content_block": {
                                                        "type": "tool_use",
                                                        "id": tc_id,
                                                        "name": tc_name,
                                                        "input": {}
                                                    }
                                                })

                                            active_tc = active_tool_calls[idx]
                                            tc_args_delta = tc.get("function", {}).get("arguments") or ""
                                            if tc_args_delta:
                                                content_emitted = True
                                                active_tc["arguments"] += tc_args_delta
                                                emit("content_block_delta", {
                                                    "type": "content_block_delta",
                                                    "index": active_tc["block_index"],
                                                    "delta": {
                                                        "type": "input_json_delta",
                                                        "partial_json": tc_args_delta
                                                    }
                                                })
                        finally:
                            try:
                                response.close()
                            except Exception:
                                pass

                        # Clean up stream blocks
                        if text_block_index is not None:
                            emit("content_block_stop", {
                                "type": "content_block_stop",
                                "index": text_block_index
                            })

                        for active_tc in active_tool_calls.values():
                            emit("content_block_stop", {
                                "type": "content_block_stop",
                                "index": active_tc["block_index"]
                            })

                        stop_reason = "tool_use" if active_tool_calls else "end_turn"
                        message_delta = {
                            "type": "message_delta",
                            "delta": {
                                "stop_reason": stop_reason,
                                "stop_sequence": None
                            },
                            "usage": {"output_tokens": 0}
                        }
                        emit("message_delta", message_delta)
                        emit("message_stop", {"type": "message_stop"})
                        LOG.info("upstream result status=200 stream=true %s", correlation)
                        last_stream_exc = None
                        break

                    except urllib.error.HTTPError as exc:
                        # HTTP rejections are never transport-retried.
                        last_stream_exc = exc
                        break
                    except Exception as exc:
                        last_stream_exc = exc
                        if content_emitted or not is_transport_error(exc) or stream_attempt >= stream_attempts:
                            break
                        LOG.warning(
                            "stream transport retry attempt=%s/%s reason=%s: %s %s",
                            stream_attempt,
                            stream_attempts,
                            type(exc).__name__,
                            exc,
                            correlation,
                        )
                        time.sleep(TRANSPORT_RETRY_BACKOFF_S * stream_attempt)
                        continue

                if last_stream_exc is not None:
                    raise last_stream_exc

            except Exception as exc:
                LOG.error("Streaming error %s: %s", correlation, exc)
                if headers_sent:
                    error_event = {
                        "type": "error",
                        "error": {"type": "api_error", "message": str(exc)}
                    }
                    try:
                        self.wfile.write(b"event: error\n")
                        self.wfile.write(f"data: {json.dumps(error_event)}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except Exception:
                        pass
                else:
                    # Headers not sent — client still expects a normal JSON error.
                    code = exc.code if isinstance(exc, urllib.error.HTTPError) else 500
                    try:
                        if isinstance(exc, urllib.error.HTTPError):
                            err_content = exc.read().decode("utf-8")
                            self._write_json(code, {"error": {"type": "api_error", "message": err_content}})
                        else:
                            self._write_json(500, {"error": {"type": "internal_error", "message": str(exc)}})
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
        stream=sys.stdout,
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
