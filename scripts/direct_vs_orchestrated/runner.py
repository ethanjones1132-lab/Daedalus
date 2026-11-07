"""Isolated, provenance-first direct/orchestrated comparison harness."""

from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

from .sse_capture import _cancel_session, validate_runtime_config

PACKAGE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_ROOT.parents[1]
FIXTURE_SOURCE = PACKAGE_ROOT / "fixtures" / "stock.csv"
COMPARISON_GENERATION = {"max_tokens": 4096, "temperature": 0, "top_p": 1}
CLOUD_SECRET_NAMES = {
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AZURE_OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
    "OPENCODE_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY", "HTTP_PROXY", "HTTPS_PROXY",
    "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
}
_SECRET_FIELD_RE = re.compile(
    r"(?:^|[_-])(?:api[_-]?key|access[_-]?key|(?:access|refresh|id|session)[_-]?token|client[_-]?secret|secret|password|passwd|authorization|auth|token)(?:$|[_-])",
    re.IGNORECASE,
)


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def artifact_sha256(path: Path | str) -> str:
    """Hash exactly one caller-supplied artifact; never search for substitutes."""
    artifact = Path(path).expanduser()
    if not artifact.is_absolute():
        artifact = artifact.resolve()
    if not artifact.is_file():
        raise FileNotFoundError(f"required artifact is not a file: {artifact}")
    digest = hashlib.sha256()
    with artifact.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(repo_root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"source inventory failed: git {' '.join(args[:2])}: {message}")
    return result.stdout


def source_fingerprint(repo_root: Path | str) -> dict[str, Any]:
    """Fingerprint HEAD plus tracked diffs and all non-ignored untracked files."""
    root = Path(repo_root).resolve(strict=True)
    source_sha = _git(root, "rev-parse", "HEAD").decode("ascii").strip()
    tracked_diff = _git(root, "diff", "--binary", "HEAD", "--")
    untracked_paths = sorted(path for path in _git(root, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0") if path)
    untracked_hash = hashlib.sha256()
    for raw_path in untracked_paths:
        relative = os.fsdecode(raw_path)
        path = root / relative
        try:
            info = path.lstat()
            if path.is_symlink():
                payload = os.readlink(path).encode("utf-8", errors="surrogatepass")
                kind = b"symlink\0"
            elif path.is_file():
                file_hash = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        file_hash.update(chunk)
                payload = file_hash.digest()
                kind = b"file\0"
            else:
                raise RuntimeError(f"non-file untracked source cannot be inventoried: {relative}")
        except OSError as exc:
            raise RuntimeError(f"source inventory is incomplete for {relative}: {exc}") from exc
        untracked_hash.update(raw_path + b"\0" + kind + payload + b"\0")

    tree = hashlib.sha256()
    tree.update(b"tracked-diff\0")
    tree.update(tracked_diff)
    tree.update(b"untracked\0")
    tree.update(untracked_hash.digest())
    status = _git(root, "status", "--porcelain=v1", "--untracked-files=all")
    return {
        "source_sha": source_sha,
        "source_tree_sha256": tree.hexdigest(),
        "source_dirty": bool(status.strip()),
        "source_untracked_count": len(untracked_paths),
        "source_inventory_complete": True,
    }


def child_env(home: Path, *, port: int, workspace: Path) -> dict[str, str]:
    """Build one explicit allowlisted Bun child environment rooted in its home."""
    isolated_home = Path(home).resolve()
    isolated_workspace = Path(workspace).resolve()
    env = {
        key: os.environ[key]
        for key in ("PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT")
        if key in os.environ
    }
    path_values = {
        "HOME": isolated_home,
        "USERPROFILE": isolated_home,
        "APPDATA": isolated_home / "AppData" / "Roaming",
        "LOCALAPPDATA": isolated_home / "AppData" / "Local",
        "XDG_CONFIG_HOME": isolated_home / ".config",
        "XDG_CACHE_HOME": isolated_home / ".cache",
        "XDG_DATA_HOME": isolated_home / ".local" / "share",
        "TEMP": isolated_home / "tmp",
        "TMP": isolated_home / "tmp",
        "JARVIS_HOME": isolated_home,
    }
    env.update({key: str(value) for key, value in path_values.items()})
    env["JARVIS_SERVER_PORT"] = str(port)
    env["JARVIS_SERVER_HOST"] = "127.0.0.1"
    env["JARVIS_WORKSPACE"] = str(isolated_workspace)
    for secret in CLOUD_SECRET_NAMES:
        env.pop(secret, None)
    return env


def ensure_loopback_ports_free(ports: Iterable[int], *, host: str = "127.0.0.1") -> None:
    """Fail before spawn if any requested loopback TCP port is occupied."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        if host.lower() != "localhost":
            raise ValueError("server host must be a loopback address") from exc
    else:
        if not address.is_loopback:
            raise ValueError("server host must be a loopback address")
    seen: set[int] = set()
    for port in ports:
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError(f"invalid loopback port: {port}")
        if port in seen:
            raise ValueError(f"duplicate loopback port: {port}")
        seen.add(port)
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        bind_host = "::1" if family == socket.AF_INET6 and host == "localhost" else "127.0.0.1" if host == "localhost" else host
        with socket.socket(family, socket.SOCK_STREAM) as listener:
            listener.bind((bind_host, port))


def allocate_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def validate_llama_extra_args(arguments: Sequence[str]) -> list[str]:
    """Allow a small, validated set of local inference tuning options only."""
    value_options: dict[str, tuple[str, int, int] | tuple[str, str]] = {
        "--n-gpu-layers": ("int", 0, 256), "-ngl": ("int", 0, 256),
        "--threads": ("int", 1, 1024), "-t": ("int", 1, 1024),
        "--threads-batch": ("int", 1, 1024), "-tb": ("int", 1, 1024),
        "--n-cpu-moe": ("int", 0, 256),
        "--ctx-size": ("int", 1, 2_097_152), "-c": ("int", 1, 2_097_152),
        "--batch-size": ("int", 1, 2_097_152), "-b": ("int", 1, 2_097_152),
        "--ubatch-size": ("int", 1, 2_097_152), "-ub": ("int", 1, 2_097_152),
        "--parallel": ("int", 1, 256), "-np": ("int", 1, 256),
        "--reasoning-budget": ("int", 0, 32_768),
        "--cache-ram": ("int", 0, 16_384),
        "--flash-attn": ("enum", "on,off,auto"), "-fa": ("enum", "on,off,auto"),
        "--cache-type-k": ("enum", "f16,bf16,q8_0,q5_0,q5_1,q4_0,q4_1"),
        "-ctk": ("enum", "f16,bf16,q8_0,q5_0,q5_1,q4_0,q4_1"),
        "--cache-type-v": ("enum", "f16,bf16,q8_0,q5_0,q5_1,q4_0,q4_1"),
        "-ctv": ("enum", "f16,bf16,q8_0,q5_0,q5_1,q4_0,q4_1"),
        "--split-mode": ("enum", "none,layer,row"), "-sm": ("enum", "none,layer,row"),
        "--tensor-split": ("tensor-split", ""),
    }
    flag_options = {
        "--mlock", "--no-mmap", "--no-cont-batching", "--cont-batching",
        "--no-warmup", "--jinja", "--no-webui",
    }
    values = [str(argument) for argument in arguments]
    index = 0
    while index < len(values):
        argument = values[index]
        option_text, separator, inline_value = argument.partition("=")
        option = option_text
        if option in flag_options and not separator:
            index += 1
            continue
        if option not in value_options:
            raise ValueError(f"llama-server argument {option} is not an allowlisted local tuning option")
        if separator:
            value = inline_value
            index += 1
        else:
            if index + 1 >= len(values):
                raise ValueError(f"llama-server tuning option {option} requires a value")
            value = values[index + 1]
            index += 2
        if not value or value.startswith("--"):
            raise ValueError(f"invalid value for llama-server tuning option {option}")
        kind, *bounds = value_options[option]
        if kind == "int":
            if not re.fullmatch(r"[0-9]+", value):
                raise ValueError(f"invalid integer value for llama-server tuning option {option}")
            number = int(value)
            minimum, maximum = bounds
            if not minimum <= number <= maximum:
                raise ValueError(f"value for llama-server tuning option {option} is out of range")
        elif kind == "enum":
            allowed = set(str(bounds[0]).split(","))
            if value not in allowed:
                raise ValueError(f"invalid value for llama-server tuning option {option}")
        elif kind == "tensor-split":
            if not re.fullmatch(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:,(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))*", value):
                raise ValueError(f"invalid value for llama-server tuning option {option}")
            if not any(float(part) > 0 for part in value.split(",")):
                raise ValueError(f"invalid value for llama-server tuning option {option}")
    if any("\0" in value for value in values):
        raise ValueError("llama-server arguments cannot contain NUL bytes")
    return values


def _normalize_parallel(value: Any, count: int, label: str) -> list[Any]:
    if isinstance(value, (str, Path)) or not isinstance(value, Sequence):
        return [value] * count
    values = list(value)
    if len(values) != count:
        raise ValueError(f"{label} must have one value per child")
    return values


@contextlib.contextmanager
def owned_processes(
    commands: Sequence[Sequence[str]],
    *,
    ports: Sequence[int],
    env: dict[str, str] | Sequence[dict[str, str]],
    cwd: Path | str | Sequence[Path | str],
    popen_factory=subprocess.Popen,
    stdout_targets: Sequence[Any] | None = None,
    terminate_timeout_s: float = 5.0,
) -> Iterator[list[subprocess.Popen]]:
    """Own only returned Popen handles; never discover or kill by name/port."""
    ensure_loopback_ports_free(ports)
    count = len(commands)
    envs = _normalize_parallel(env, count, "env")
    cwds = _normalize_parallel(cwd, count, "cwd")
    outputs = _normalize_parallel(stdout_targets or [subprocess.DEVNULL] * count, count, "stdout_targets")
    children: list[subprocess.Popen] = []
    try:
        for command, child_environment, child_cwd, stdout in zip(commands, envs, cwds, outputs):
            process = popen_factory(
                list(command),
                cwd=str(child_cwd),
                env=dict(child_environment),
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=subprocess.STDOUT,
            )
            children.append(process)
        yield children
    finally:
        for process in reversed(children):
            try:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=terminate_timeout_s)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=terminate_timeout_s)
            except (OSError, subprocess.SubprocessError):
                # Cleanup is best effort on handles this context owns only.
                pass


def _loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def require_bun_loopback_bind(repo_root: Path | str) -> str:
    """Require a known loopback override path; runtime health confirms its value."""
    root = Path(repo_root).resolve(strict=True)
    index_source = (root / "server-jarvis" / "src" / "index.ts").read_text(encoding="utf-8")
    guards_source = (root / "server-jarvis" / "src" / "server-guards.ts").read_text(encoding="utf-8")
    call = re.search(r"resolveBindTarget\(\s*PORT(?:\s*,\s*([^)]*?))?\s*\)", index_source)
    if not call:
        raise RuntimeError("cannot verify that the Bun server binds to loopback")
    host_argument = (call.group(1) or "").strip()
    if host_argument == "process.env.JARVIS_SERVER_HOST":
        # child_env supplies this exact value; /health must confirm the actual
        # listener address before a capture can begin.
        host = "127.0.0.1"
    elif host_argument:
        literal = re.fullmatch(r"(['\"])(.*?)\1", host_argument)
        if not literal:
            raise RuntimeError("cannot verify that the Bun server binds to loopback")
        host = literal.group(2)
    else:
        default = re.search(r"DEFAULT_BIND_HOSTNAME\s*=\s*(['\"])(.*?)\1", guards_source)
        if not default:
            raise RuntimeError("cannot verify the Bun server default bind host")
        host = default.group(2)
    if not _loopback_host(host):
        raise RuntimeError(
            f"Bun source binds to {host}; the comparison requires a loopback-only bind and refuses to start it"
        )
    return "127.0.0.1" if host.lower() == "localhost" else host


def _assert_bun_loopback_health(response: dict[str, Any]) -> None:
    host = response.get("bind_host")
    if not isinstance(host, str) or not _loopback_host(host):
        raise RuntimeError("Bun /health did not confirm an effective loopback bind host")


def _assert_runtime_config(
    response: dict[str, Any],
    *,
    expected: dict[str, Any],
    mode: str,
    model_url: str,
    served_alias: str,
) -> None:
    """Check the bare /config payload against the intended isolated runtime."""
    expected_enabled = expected["orchestrator"]["enabled"]
    actual_orchestrator = response.get("orchestrator")
    actual_llama = response.get("llama_cpp")
    if response.get("active_backend") != "llama_cpp":
        raise RuntimeError(f"{mode} Bun /config did not confirm the local llama.cpp backend")
    if not isinstance(actual_orchestrator, dict) or actual_orchestrator.get("enabled") is not expected_enabled:
        raise RuntimeError(f"{mode} Bun /config did not confirm the intended orchestration mode")
    if not isinstance(actual_llama, dict) or actual_llama.get("base_url") != model_url or actual_llama.get("model") != served_alias:
        raise RuntimeError(f"{mode} Bun /config did not confirm the isolated llama.cpp target")
    expected_conductor = expected["orchestrator"]["conductor"]
    actual_conductor = actual_orchestrator.get("conductor")
    if not isinstance(actual_conductor, dict):
        raise RuntimeError(f"{mode} Bun /config did not confirm the isolated resident conductor")
    for key in (
        "enabled", "base_url", "model", "fallback_model", "keep_warm",
        "fallback_to_api", "persist_sessions", "kv_persist", "kv_backend",
    ):
        if actual_conductor.get(key) != expected_conductor.get(key):
            raise RuntimeError(f"{mode} Bun /config did not confirm the isolated conductor {key}")


def build_mode_configs(
    *,
    isolated_home: Path,
    workspace: Path,
    llama_base_url: str,
    served_alias: str,
    llama_server_path: Path,
    model_path: Path,
) -> dict[str, dict[str, Any]]:
    """Create identical minimal overlays except for the orchestrator switch."""
    home = Path(isolated_home)
    if not home.is_absolute():
        raise ValueError("isolated_home must be an absolute path")
    workspace_path = str(Path(workspace).resolve())
    base_url = llama_base_url.rstrip("/")
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port is None:
        raise ValueError("llama.cpp URL must use explicit http://127.0.0.1:<port>")
    if not served_alias.strip():
        raise ValueError("served_alias must be nonempty")

    base: dict[str, Any] = {
        "active_backend": "llama_cpp",
        "comparison_generation": dict(COMPARISON_GENERATION),
        "llama_cpp": {
            "base_url": base_url,
            "model": served_alias,
            "server_path": str(Path(llama_server_path).resolve()),
            "model_path": str(Path(model_path).resolve()),
            "mtp_path": "",
            "port": parsed.port,
        },
        "claude_cli": {"enabled": False, "delegate": {"enabled": False}},
        "openrouter": {"api_key": "", "enable_fallbacks": False, "enable_paid_fallbacks": False, "fallbacks": []},
        "opencode_zen": {"api_key": ""},
        "opencode_go": {"api_key": ""},
        "vllm": {"enabled": False, "api_key_env": ""},
        "web_search": {"brave_api_key": "", "tavily_api_key": ""},
        "tools": {
            "enabled": True,
            "require_approval": [
                "web_search", "web_fetch", "Write", "Edit", "Bash", "MultiEdit",
                "write_file", "edit_file", "multi_edit", "bash", "powershell",
            ],
            "sandbox_mode": "strict",
            "interactive_approval": True,
            "allowed_roots": [workspace_path],
            "grant_session_roots": False,
            "run_gate": False,
        },
        "jarvis_path": workspace_path,
        "orchestrator": {
            "enabled": False,
            "allow_cloud_helpers": False,
            "session_memory": {"enabled": False},
            "conductor_learning": {"enabled": False, "trajectory_export": False},
            "skill_distillation": {"enabled": False},
            "conductor": {
                "enabled": True,
                "base_url": base_url,
                "model": served_alias,
                "fallback_model": "",
                "fallback_to_api": False,
                "keep_warm": False,
                "persist_sessions": False,
                "kv_persist": False,
                "kv_backend": "llama_cpp",
            },
        },
    }
    direct = copy.deepcopy(base)
    orchestrated = copy.deepcopy(base)
    direct["orchestrator"]["enabled"] = False
    orchestrated["orchestrator"]["enabled"] = True
    return {"direct": direct, "orchestrated": orchestrated}


def redact_config(value: Any) -> Any:
    """Return a JSON-safe config copy with secret-bearing fields redacted."""
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if _SECRET_FIELD_RE.search(str(key)):
                redacted[key] = "[REDACTED]" if item not in (None, "", False) else item
            else:
                redacted[key] = redact_config(item)
        return redacted
    if isinstance(value, list):
        return [redact_config(item) for item in value]
    return value


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _atomic_write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    _write_json(temporary, value)
    temporary.replace(path)


def _local_json_request(url: str, *, timeout: float = 2.0) -> dict[str, Any]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("readiness probes are restricted to loopback HTTP")
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RejectRedirects())
    with opener.open(request, timeout=timeout) as response:
        body = response.read(4 * 1024 * 1024)
    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("readiness endpoint returned a non-object JSON body")
    return value


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        close = getattr(file_pointer, "close", None)
        if callable(close):
            close()
        raise urllib.error.URLError("redirect blocked for local readiness probe")


def _wait_for_json(
    url: str,
    process: subprocess.Popen,
    *,
    timeout_s: float,
    readiness_kind: str,
    expected_alias: str | None = None,
) -> dict[str, Any]:
    if readiness_kind not in {"health", "config", "models"}:
        raise ValueError(f"unsupported readiness response kind: {readiness_kind}")
    if readiness_kind == "models" and not expected_alias:
        raise ValueError("models readiness requires the expected serving alias")
    deadline = time.monotonic() + timeout_s
    last_error = "not yet ready"
    while time.monotonic() < deadline:
        code = process.poll()
        if code is not None:
            raise RuntimeError(f"owned process {process.pid} exited before readiness (code {code})")
        try:
            body = _local_json_request(url, timeout=1.0)
            if readiness_kind == "models":
                models = body.get("data")
                if isinstance(models, list) and any(isinstance(model, dict) and model.get("id") == expected_alias for model in models):
                    return body
                last_error = "served alias not present in /v1/models"
            elif readiness_kind == "health":
                has_error = body.get("error") not in (None, "", False)
                status_conflict = "status" in body and body.get("status") != "ok"
                if not has_error and not status_conflict and (body.get("ok") is True or body.get("status") == "ok"):
                    return body
                last_error = "health response did not report a clean ok status"
            elif readiness_kind == "config":
                has_error = body.get("error") not in (None, "", False)
                status_conflict = "status" in body and body.get("status") != "ok"
                if not has_error and not status_conflict and body.get("ok") is not False and isinstance(body.get("active_backend"), str) and isinstance(body.get("orchestrator"), dict) and isinstance(body.get("llama_cpp"), dict):
                    return body
                last_error = "config response did not contain a clean bare configuration"
            else:
                last_error = f"{readiness_kind} response did not satisfy its readiness contract"
        except (OSError, ValueError, urllib.error.URLError) as exc:
            last_error = type(exc).__name__
        time.sleep(0.2)
    raise TimeoutError(f"readiness timeout for {url}: {last_error}")


def _require_explicit_file(value: Any, label: str) -> Path:
    if value is None or str(value).strip() == "":
        raise ValueError(f"explicit --{label} path is required")
    path = Path(value).expanduser().resolve(strict=True)
    if not path.is_file():
        raise FileNotFoundError(f"--{label} must name a file: {path}")
    return path


def _hardware_facts() -> dict[str, Any]:
    return {
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "logical_cpu_count": os.cpu_count(),
    }


def _redact_argv(argv: Sequence[str]) -> list[str]:
    result: list[str] = []
    redact_next = False
    for argument in argv:
        value = str(argument)
        if redact_next:
            result.append("[REDACTED]")
            redact_next = False
            continue
        option = value.split("=", 1)[0]
        if _SECRET_FIELD_RE.search(option):
            if "=" in value:
                key, _secret = value.split("=", 1)
                result.append(f"{key}=[REDACTED]")
            else:
                result.append(value)
                redact_next = True
        else:
            result.append(value)
    return result


def build_provenance(
    *,
    repo_root: Path,
    llama_server: Path,
    model: Path,
    bun: Path,
    served_alias: str,
    llama_argv: Sequence[str],
    bun_argv: Sequence[str],
    source_snapshot: dict[str, Any] | None = None,
    artifact_hashes: dict[str, str] | None = None,
) -> dict[str, Any]:
    source = source_snapshot if source_snapshot is not None else source_fingerprint(repo_root)
    hashes = artifact_hashes or {
        "llama_server_sha256": artifact_sha256(llama_server),
        "gguf_sha256": artifact_sha256(model),
        "bun_sha256": artifact_sha256(bun),
    }
    return {
        **source,
        "llama_server_path": str(llama_server.resolve(strict=True)),
        "llama_server_sha256": hashes["llama_server_sha256"],
        "gguf_path": str(model.resolve(strict=True)),
        "gguf_sha256": hashes["gguf_sha256"],
        "served_alias": served_alias,
        "llama_argv_redacted": _redact_argv(llama_argv),
        "bun_path": str(bun.resolve(strict=True)),
        "bun_sha256": hashes["bun_sha256"],
        "bun_argv_redacted": _redact_argv(bun_argv),
        "hardware": _hardware_facts(),
    }


@contextlib.contextmanager
def _open_process_logs(out_dir: Path, names: Sequence[str]) -> Iterator[list[Any]]:
    logs = out_dir / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    with contextlib.ExitStack() as stack:
        yield [stack.enter_context((logs / f"{name}.log").open("ab")) for name in names]


def _load_tasks() -> list[dict[str, Any]]:
    payload = json.loads((PACKAGE_ROOT / "tasks.json").read_text(encoding="utf-8"))
    tasks = payload.get("tasks") if isinstance(payload, dict) else None
    if not isinstance(tasks, list) or len(tasks) != 4:
        raise ValueError("the frozen comparison corpus must contain exactly four tasks")
    for task in tasks:
        if not isinstance(task, dict) or any(task.get(key) != value for key, value in COMPARISON_GENERATION.items()):
            raise ValueError("all frozen tasks must match the persisted comparison generation policy")
    return tasks


def build_trial_schedule(tasks: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the fixed two process-cold, two warm-up, and 24 warm schedule."""
    by_id = {str(task.get("id")): task for task in tasks if isinstance(task, dict)}
    arithmetic = by_id.get("arithmetic")
    if arithmetic is None or len(by_id) != len(tasks):
        raise ValueError("the frozen schedule requires unique task IDs including arithmetic")

    schedule: list[dict[str, Any]] = []
    for index, mode in enumerate(("direct", "orchestrated"), start=1):
        schedule.append({
            "observation_id": f"cold_{index:02d}_arithmetic",
            "phase": "process_cold",
            "mode": mode,
            "task_id": "arithmetic",
            "pair_id": None,
            "pair_order": None,
            "order_index": index,
            "reported": True,
        })
    for index, mode in enumerate(("direct", "orchestrated"), start=1):
        schedule.append({
            "observation_id": f"warmup_{index:02d}",
            "phase": "warmup",
            "mode": mode,
            "task_id": "arithmetic",
            "pair_id": None,
            "pair_order": None,
            "order_index": index,
            "reported": False,
        })

    pair_index = 0
    orders = (
        ("direct_then_orchestrated", ("direct", "orchestrated")),
        ("orchestrated_then_direct", ("orchestrated", "direct")),
        ("direct_then_orchestrated", ("direct", "orchestrated")),
    )
    for task in tasks:
        task_id = str(task["id"])
        for pair_number, (pair_order, modes) in enumerate(orders, start=1):
            pair_index += 1
            pair_id = f"{task_id}_pair_{pair_number:02d}"
            for slot, mode in zip(("a", "b"), modes):
                schedule.append({
                    "observation_id": f"pair_{pair_number:02d}_{task_id}_{slot}",
                    "phase": "warm",
                    "mode": mode,
                    "task_id": task_id,
                    "pair_id": pair_id,
                    "pair_order": pair_order,
                    "order_index": pair_index,
                    "reported": True,
                })
    return schedule


def cold_observation_metadata(*, model_ready_ms: float, first_output_ms: float | None) -> dict[str, Any]:
    return {
        "cold_label": "process-cold",
        "cold_state": "llama_process_and_kv",
        "os_page_cache_cold": False,
        "whole_machine_cold": False,
        "model_process_ready_ms": max(0.0, float(model_ready_ms)),
        "first_output_ms": None if first_output_ms is None else max(0.0, float(first_output_ms)),
    }


def _route_records(observation: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for key in ("route_attempts", "stage_routes", "direct_path_route_attribution"):
        value = observation.get(key)
        if isinstance(value, list):
            records.extend(record for record in value if isinstance(record, dict))
    for key in ("answered_by",):
        value = observation.get(key)
        if isinstance(value, dict):
            records.append(value)
    return records


def _tool_call_id(frame: dict[str, Any]) -> str | None:
    for key in ("id", "call_id"):
        value = frame.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _path_fields(value: Any) -> Iterator[str]:
    path_keys = {"path", "paths", "file", "files", "file_path", "filepath", "directory", "directories", "dir", "root", "cwd"}
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).casefold() in path_keys:
                if isinstance(child, str):
                    yield child
                elif isinstance(child, list):
                    yield from (item for item in child if isinstance(item, str))
                else:
                    yield from _path_fields(child)
            else:
                yield from _path_fields(child)
    elif isinstance(value, list):
        for child in value:
            yield from _path_fields(child)


def _path_within(root: Path, value: str) -> bool:
    try:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = root / candidate
        return candidate.resolve(strict=False).is_relative_to(root.resolve(strict=True))
    except (OSError, RuntimeError, ValueError):
        return False


def validate_trial_safety(
    observation: dict[str, Any],
    *,
    served_alias: str,
    fixture_root: Path,
    fixture_sha256: str,
) -> list[str]:
    """Return fail-closed reasons from observed routes, tools, and fixture hashes."""
    reasons: list[str] = []
    routes = _route_records(observation)
    if not routes:
        reasons.append("route_attribution_missing")
    for route in routes:
        provider = route.get("provider", route.get("actual_provider"))
        model = route.get("model", route.get("actual_model"))
        if route.get("cloud") is True:
            reasons.append("cloud_route")
        if provider != "llama_cpp":
            reasons.append("non_local_route")
        if model != served_alias:
            reasons.append("unexpected_alias")

    uses = observation.get("tool_use_frames")
    results = observation.get("tool_result_frames")
    metrics = observation.get("orchestration_metrics")
    reported_calls = metrics.get("tool_calls") if isinstance(metrics, dict) else None
    if isinstance(reported_calls, int) and not isinstance(reported_calls, bool) and reported_calls > (len(uses) if isinstance(uses, list) else 0):
        reasons.append("tool_trace_incomplete")
    if isinstance(uses, list) and isinstance(results, list):
        use_ids = [_tool_call_id(item) for item in uses if isinstance(item, dict)]
        result_ids = [_tool_call_id(item) for item in results if isinstance(item, dict)]
        if len(uses) != len(results):
            reasons.append("tool_trace_mismatch")
        elif len(use_ids) != len(uses) or len(result_ids) != len(results) or any(not value for value in [*use_ids, *result_ids]):
            reasons.append("tool_trace_identity_missing")
        elif len(set(use_ids)) != len(use_ids) or len(set(result_ids)) != len(result_ids):
            reasons.append("tool_trace_identity_duplicate")
        elif sorted(use_ids) != sorted(result_ids):
            reasons.append("tool_trace_mismatch")
    for use in uses if isinstance(uses, list) else []:
        if not isinstance(use, dict):
            continue
        name = use.get("name")
        if name in {"web_search", "web_fetch"}:
            reasons.append("web_tool_attempt")
        if name in {"write_file", "edit_file", "multi_edit", "Write", "Edit", "MultiEdit", "bash", "powershell", "Bash"}:
            reasons.append("mutating_tool_attempt")
        for path_value in _path_fields(use.get("input", {})):
            if not _path_within(fixture_root, path_value):
                reasons.append("escaped_tool_path")

    before = observation.get("fixture_sha256_before")
    after = observation.get("fixture_sha256_after")
    if before != fixture_sha256:
        reasons.append("fixture_baseline_mismatch")
    if after != fixture_sha256:
        reasons.append("fixture_mutated")
    if observation.get("outcome") == "timeout" and observation.get("cancel_confirmed") is not True:
        reasons.append("cancellation_unconfirmed")
    if observation.get("capture_worker_settled") is False:
        reasons.append("capture_worker_unsettled")
    return list(dict.fromkeys(reasons))


def run_trial_schedule(
    schedule: Sequence[dict[str, Any]],
    trial_runner,
) -> list[dict[str, Any]]:
    """Keep all failure records and stop only when safety/cancellation requires it."""
    records: list[dict[str, Any]] = []
    for trial in schedule:
        try:
            result = trial_runner(trial)
        except Exception as exc:
            result = {"outcome": "transport_failure", "error_type": type(exc).__name__, "stop_campaign": True}
        if not isinstance(result, dict):
            result = {"outcome": "transport_failure", "error_type": "InvalidTrialResult", "stop_campaign": True}
        record = {**trial, **result}
        if record.get("outcome") == "timeout" and record.get("cancel_confirmed") is not True:
            record["stop_campaign"] = True
        if record.get("outcome") == "blocked" or record.get("trial_status") == "blocked":
            record["stop_campaign"] = True
        records.append(record)
        if record.get("stop_campaign") is True:
            break
    return records


def capture_trial(
    trial: dict[str, Any],
    task: dict[str, Any],
    *,
    base_url: str,
    fixture_path: Path,
    fixture_root: Path,
    fixture_sha256: str,
    out_path: Path,
    served_alias: str,
    wall_cap_ms: int = 120_000,
    worker=None,
) -> dict[str, Any]:
    """Capture one fresh Session and verify local-only and fixture invariants."""
    session_id = uuid.uuid4().hex
    record: dict[str, Any] = {
        **trial,
        "session_id": session_id,
        "raw_capture_path": str(out_path),
        "history_reset": True,
    }
    try:
        before = artifact_sha256(fixture_path)
    except OSError:
        before = None
    record["fixture_sha256_before"] = before
    if before != fixture_sha256:
        record.update({
            "outcome": "blocked",
            "trial_status": "blocked",
            "fixture_sha256_after": before,
            "safety_reasons": ["fixture_baseline_mismatch"],
            "stop_campaign": True,
        })
        return record

    capture_worker = worker or _run_capture_worker
    try:
        observation = capture_worker(
            base_url=base_url,
            session_id=session_id,
            task=task,
            wall_cap_ms=wall_cap_ms,
            out_path=out_path,
        )
    except Exception as exc:
        observation = {"outcome": "transport_failure", "error_type": type(exc).__name__}
    try:
        after = artifact_sha256(fixture_path)
    except OSError:
        after = None
    record.update(observation if isinstance(observation, dict) else {"outcome": "transport_failure", "error_type": "InvalidCaptureResult"})
    record["fixture_sha256_after"] = after
    reasons = validate_trial_safety(record, served_alias=served_alias, fixture_root=fixture_root, fixture_sha256=fixture_sha256)
    record["safety_reasons"] = reasons
    record["trial_status"] = "blocked" if reasons else record.get("outcome", "unknown")
    record["stop_campaign"] = bool(reasons) or record.get("stop_campaign") is True
    return record


def _successful_named_tool_calls(observation: dict[str, Any], tool_name: str) -> int | None:
    uses = observation.get("tool_use_frames")
    results = observation.get("tool_result_frames")
    if not isinstance(uses, list) or not isinstance(results, list):
        return None
    use_ids = [_tool_call_id(use) for use in uses if isinstance(use, dict)]
    result_ids = [_tool_call_id(result) for result in results if isinstance(result, dict)]
    if (
        len(uses) != len(results)
        or len(use_ids) != len(uses)
        or len(result_ids) != len(results)
        or any(not value for value in [*use_ids, *result_ids])
        or len(set(use_ids)) != len(use_ids)
        or len(set(result_ids)) != len(result_ids)
        or sorted(use_ids) != sorted(result_ids)
        or any(not isinstance(result, dict) or result.get("is_error") not in {True, False} for result in results)
    ):
        return None
    successful_results = {
        _tool_call_id(result)
        for result in results
        if result.get("is_error") is False
    }
    return sum(
        1 for use in uses
        if isinstance(use, dict)
        and use.get("name") == tool_name
        and _tool_call_id(use) in successful_results
    )


def evaluate_acceptance(
    task: dict[str, Any],
    observation: dict[str, Any],
    *,
    fixture_sha256_before: str | None,
    fixture_sha256_after: str | None,
    expected_fixture_sha256: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Score only mechanical criteria; preserve subjective criteria as blind pending work."""
    acceptance = task.get("acceptance", {})
    criteria = acceptance.get("criteria", []) if isinstance(acceptance, dict) else []
    observation_id = str(observation.get("observation_id", "unknown-observation"))
    blind_label = "blind-" + hashlib.sha256(observation_id.encode("utf-8")).hexdigest()[:12]
    expected_fixture = expected_fixture_sha256 or fixture_sha256_before
    mechanical: list[dict[str, Any]] = []
    rubric: list[dict[str, Any]] = []

    for criterion in criteria:
        if not isinstance(criterion, dict):
            continue
        criterion_id = criterion.get("id")
        kind = criterion.get("kind")
        status: str | None = None
        observed: Any = None
        expected: Any = None
        if kind == "exact_text":
            observed = str(observation.get("visible_text", "")).strip()
            expected = str(criterion.get("expected", acceptance.get("expected_answer", ""))).strip()
            status = "pass" if observed == expected else "fail"
        elif kind == "minimum_successful_tool_calls":
            tool = str(criterion.get("tool", ""))
            observed = _successful_named_tool_calls(observation, tool)
            expected = int(criterion.get("minimum", 0))
            status = "unknown" if observed is None else "pass" if observed >= expected else "fail"
        elif kind == "maximum_failed_tool_results":
            results = observation.get("tool_result_frames")
            if isinstance(results, list) and all(isinstance(result, dict) and result.get("is_error") in {True, False} for result in results):
                observed = sum(result.get("is_error") is True for result in results)
                expected = int(criterion.get("maximum", 0))
                status = "pass" if observed <= expected else "fail"
            else:
                status = "unknown"
        elif kind == "fixture_sha256_matches_baseline":
            observed = {"before": fixture_sha256_before, "after": fixture_sha256_after}
            expected = expected_fixture
            status = "pass" if expected and fixture_sha256_before == expected and fixture_sha256_after == expected else "fail"

        if status is not None:
            mechanical.append({
                "observation_id": observation_id,
                "task_id": task.get("id"),
                "criterion_id": criterion_id,
                "kind": kind,
                "status": status,
                "observed": observed,
                "expected": expected,
            })
            continue

        rubric.append({
            "observation_id": observation_id,
            "blind_label": blind_label,
            "task_id": task.get("id"),
            "criterion_id": criterion_id,
            "criterion": criterion.get("criterion", ""),
            "score": "pending",
            "reviewer": {"type": "pending", "identity": None},
            "comments": [],
            "raw_output": observation.get("visible_text", ""),
        })

    return {"mechanical_results": mechanical, "rubric_results": rubric}


def _run_capture_worker(
    *,
    base_url: str,
    session_id: str,
    task: dict[str, Any],
    runtime_config: dict[str, Any],
    wall_cap_ms: int,
    out_path: Path,
    worker_home: Path,
    port: int,
    workspace: Path,
    repo_root: Path = REPO_ROOT,
    popen_factory=subprocess.Popen,
) -> dict[str, Any]:
    """Run one capture worker under a parent deadline that includes process spawn."""
    task_path = out_path.with_suffix(".task.json")
    _write_json(task_path, task)
    runtime_config_path = Path(worker_home) / ".openclaw" / "jarvis" / "capture-runtime-config.json"
    _write_json(runtime_config_path, validate_runtime_config(runtime_config))
    command = [
        sys.executable, "-m", "scripts.direct_vs_orchestrated.capture_worker",
        "--base-url", base_url,
        "--session-id", session_id,
        "--task-json", str(task_path),
        "--config-json", str(runtime_config_path),
        "--out", str(out_path),
        "--wall-cap-ms", str(wall_cap_ms),
    ]
    environment = child_env(worker_home, port=port, workspace=workspace)
    # The monotonic turn deadline begins before Popen, so interpreter startup
    # and task-file loading consume the same 120-second budget as SSE capture.
    capture_started = time.monotonic()
    deadline = capture_started + wall_cap_ms / 1000.0

    def with_parent_timing(result: dict[str, Any]) -> dict[str, Any]:
        result["capture_worker_wall_ms"] = round(max(0.0, time.monotonic() - capture_started) * 1000, 3)
        return result
    with owned_processes(
        [command],
        ports=[],
        env=[environment],
        cwd=[repo_root],
        popen_factory=popen_factory,
        stdout_targets=[subprocess.PIPE],
        terminate_timeout_s=1.0,
    ) as processes:
        process = processes[0]
        try:
            stdout, _stderr = process.communicate(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            cancellation_deadline = time.monotonic() + 5.0
            cancel_confirmed = _cancel_session(base_url, session_id, deadline_mono=cancellation_deadline)
            settled = False
            stdout = b""
            if cancel_confirmed:
                try:
                    stdout, _stderr = process.communicate(timeout=max(0.0, cancellation_deadline - time.monotonic()))
                    settled = True
                except subprocess.TimeoutExpired:
                    pass
            elif process.poll() is not None:
                try:
                    stdout, _stderr = process.communicate(timeout=0.0)
                    settled = True
                except subprocess.TimeoutExpired:
                    pass
            if not settled and process.poll() is None:
                process.terminate()
                try:
                    stdout, _stderr = process.communicate(timeout=1.0)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, _stderr = process.communicate(timeout=1.0)
            result = _parse_worker_summary(stdout)
            if result is None:
                result = {"outcome": "timeout"}
            settlement_outcome = result.get("outcome")
            result.update({
                "outcome": "timeout",
                "timeout_ms": wall_cap_ms,
                "cancel_confirmed": cancel_confirmed,
                "capture_worker_settled": settled,
                "cancel_settlement_outcome": settlement_outcome,
                "capture_worker_pid": process.pid,
                "stop_campaign": not (cancel_confirmed and settled),
            })
            return with_parent_timing(result)
        result = _parse_worker_summary(stdout)
        if result is None:
            return with_parent_timing({
                "outcome": "transport_failure",
                "capture_worker_pid": process.pid,
                "capture_worker_exit_code": process.returncode,
                "capture_worker_settled": True,
                "error_type": "InvalidWorkerSummary",
            })
        result.update({
            "capture_worker_pid": process.pid,
            "capture_worker_exit_code": process.returncode,
            "capture_worker_settled": True,
        })
        return with_parent_timing(result)


def _parse_worker_summary(stdout: bytes | str | None) -> dict[str, Any] | None:
    if stdout is None:
        return None
    text = stdout.decode("utf-8", errors="replace") if isinstance(stdout, bytes) else str(stdout)
    for line in reversed(text.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get("outcome"), str):
            return value
    return None


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        stream.flush()


def _new_output_dir(out_dir: Path) -> Path:
    resolved = out_dir.expanduser().resolve()
    if resolved.exists():
        if not resolved.is_dir() or any(resolved.iterdir()):
            raise FileExistsError(f"--out-dir must be a new or empty directory: {resolved}")
    else:
        resolved.mkdir(parents=True)
    return resolved


def _write_report_artifact(out_dir: Path, manifest: dict[str, Any], manifest_path: Path) -> None:
    from .report import write_report

    try:
        report_path = write_report(out_dir)
    except Exception as exc:
        manifest["report_error"] = {"type": type(exc).__name__}
        if manifest.get("run_status") == "complete":
            manifest["run_status"] = "report_failed"
        _atomic_write_json(manifest_path, manifest)
        raise RuntimeError(f"comparison report generation failed: {type(exc).__name__}") from exc
    manifest["report_path"] = str(report_path)
    _atomic_write_json(manifest_path, manifest)


def _execute_campaign(
    *,
    out_dir: Path,
    manifest: dict[str, Any],
    manifest_path: Path,
    tasks: list[dict[str, Any]],
    configs: dict[str, dict[str, Any]],
    llama_argv: list[str],
    bun_path: Path,
    repo_root: Path,
    homes: Path,
    fixture_dir: Path,
    fixture_path: Path,
    fixture_sha: str,
    ports: dict[str, int],
    served_alias: str,
    model_url: str,
    popen_factory=subprocess.Popen,
) -> None:
    schedule = build_trial_schedule(tasks)
    manifest.update({
        "schedule": schedule,
        "expected_counts": {"process_cold": 2, "warmup_unreported": 2, "warm_reported": 24},
        "observations": [],
        "run_status": "starting",
        "campaign_complete": False,
    })
    _atomic_write_json(manifest_path, manifest)
    task_by_id = {task["id"]: task for task in tasks}
    server_root = repo_root / "server-jarvis"
    bun_argv = [str(bun_path), "run", "--no-env-file", "src/index.ts"]
    bun_commands = [bun_argv, bun_argv]
    bun_modes = ["direct", "orchestrated"]
    bun_envs = [
        child_env(homes / mode, port=ports[mode], workspace=fixture_dir)
        for mode in bun_modes
    ]
    bun_cwds = [server_root, server_root]
    log_names = ["llama_cpp_process_cold_direct", "llama_cpp_process_cold_orchestrated", "bun_direct", "bun_orchestrated"]
    readiness: list[dict[str, Any]] = []
    process_handles: dict[int, subprocess.Popen] = {}
    blind_key: dict[str, Any] = {}
    observations_path = out_dir / "observations.jsonl"
    rubric_path = out_dir / "rubric.jsonl"
    packets_path = out_dir / "blind-review-packets.jsonl"
    blind_key_path = out_dir / "blind-review-key.json"

    def record_process(name: str, process: subprocess.Popen, argv: Sequence[str], cwd: Path) -> dict[str, Any]:
        row = {
            "name": name,
            "pid": process.pid,
            "argv_redacted": _redact_argv(argv),
            "cwd": str(cwd),
            "owned_handle": True,
            "status": "started",
        }
        manifest["processes"].append(row)
        process_handles[process.pid] = process
        _atomic_write_json(manifest_path, manifest)
        return row

    def mark_process_stopped(row: dict[str, Any], process: subprocess.Popen) -> None:
        row["exit_code"] = process.poll()
        row["status"] = "stopped" if row["exit_code"] is not None else "stop_unconfirmed"
        _atomic_write_json(manifest_path, manifest)

    def start_model(process_stack: contextlib.ExitStack, log_file, generation: str):
        model_stack = process_stack.enter_context(contextlib.ExitStack())
        ready_started = time.monotonic()
        processes = model_stack.enter_context(owned_processes(
            [llama_argv],
            ports=[ports["llama_cpp"]],
            env=[child_env(homes / "model", port=ports["llama_cpp"], workspace=fixture_dir)],
            cwd=[homes / "model"],
            stdout_targets=[log_file],
            popen_factory=popen_factory,
        ))
        process = processes[0]
        process_row = record_process(f"llama_cpp_{generation}", process, llama_argv, homes / "model")
        health = _wait_for_json(
            f"http://127.0.0.1:{ports['llama_cpp']}/health",
            process,
            timeout_s=120.0,
            readiness_kind="health",
        )
        model_list = _wait_for_json(
            f"http://127.0.0.1:{ports['llama_cpp']}/v1/models",
            process,
            timeout_s=5.0,
            readiness_kind="models",
            expected_alias=served_alias,
        )
        ready_ms = round((time.monotonic() - ready_started) * 1000, 3)
        readiness.append({
            "component": f"llama_cpp_{generation}",
            "status": "ready",
            "health": health,
            "served_alias": served_alias,
            "model_count": len(model_list.get("data", [])),
            "ready_ms": ready_ms,
        })
        manifest["readiness"] = readiness
        _atomic_write_json(manifest_path, manifest)
        return model_stack, process, process_row, ready_ms

    def record_trial(trial: dict[str, Any], *, model_ready_ms: float, model_generation: str) -> dict[str, Any]:
        task = task_by_id[trial["task_id"]]
        mode = trial["mode"]
        base_url = f"http://127.0.0.1:{ports[mode]}"
        capture_path = out_dir / "captures" / mode / trial["task_id"] / f"{trial['observation_id']}.jsonl"

        def launch_worker(**kwargs):
            return _run_capture_worker(
                **kwargs,
                runtime_config=configs[mode],
                worker_home=homes / mode,
                port=ports[mode],
                workspace=fixture_dir,
                repo_root=repo_root,
                popen_factory=popen_factory,
            )

        record = capture_trial(
            trial,
            task,
            base_url=base_url,
            fixture_path=fixture_path,
            fixture_root=fixture_dir,
            fixture_sha256=fixture_sha,
            out_path=capture_path,
            served_alias=served_alias,
            wall_cap_ms=120_000,
            worker=launch_worker,
        )
        record["llama_process_generation"] = model_generation
        if trial["phase"] == "process_cold":
            record.update(cold_observation_metadata(
                model_ready_ms=model_ready_ms,
                first_output_ms=record.get("first_visible_ms"),
            ))

        all_frames = record.get("raw_frames")
        normalized = {key: value for key, value in record.items() if key != "raw_frames"}
        normalized["raw_frame_count"] = len(all_frames) if isinstance(all_frames, list) else None
        _append_jsonl(observations_path, normalized)
        acceptance = evaluate_acceptance(
            task,
            record,
            fixture_sha256_before=record.get("fixture_sha256_before"),
            fixture_sha256_after=record.get("fixture_sha256_after"),
            expected_fixture_sha256=fixture_sha,
        )
        for row in acceptance["mechanical_results"]:
            _append_jsonl(rubric_path, {"assessment_type": "mechanical", **row})
        for row in acceptance["rubric_results"]:
            _append_jsonl(rubric_path, {"assessment_type": "independent_review", **row})
        if acceptance["rubric_results"]:
            first = acceptance["rubric_results"][0]
            blind_label = first["blind_label"]
            _append_jsonl(packets_path, {
                "blind_label": blind_label,
                "task_id": task["id"],
                "criteria": [
                    {"criterion_id": row["criterion_id"], "criterion": row["criterion"]}
                    for row in acceptance["rubric_results"]
                ],
                "answer": record.get("visible_text", ""),
            })
            blind_key[blind_label] = {
                "observation_id": trial["observation_id"],
                "mode": mode,
                "pair_id": trial.get("pair_id"),
                "pair_order": trial.get("pair_order"),
            }
            _atomic_write_json(blind_key_path, blind_key)

        manifest["observations"].append({
            "observation_id": trial["observation_id"],
            "phase": trial["phase"],
            "mode": mode,
            "task_id": task["id"],
            "outcome": record.get("outcome"),
            "trial_status": record.get("trial_status"),
            "safety_reasons": record.get("safety_reasons", []),
            "raw_capture_path": str(capture_path),
            "cancel_confirmed": record.get("cancel_confirmed"),
        })
        manifest["run_status"] = "capturing"
        manifest["observation_count"] = len(manifest["observations"])
        if record.get("stop_campaign"):
            manifest["campaign_stop_reason"] = record.get("safety_reasons") or "capture cancellation did not settle"
            manifest["run_status"] = "incomplete"
        _atomic_write_json(manifest_path, manifest)
        return record

    def consume(trials: Sequence[dict[str, Any]], *, model_ready_ms: float, generation: str) -> bool:
        records = run_trial_schedule(
            trials,
            lambda trial: record_trial(trial, model_ready_ms=model_ready_ms, model_generation=generation),
        )
        known_ids = {row.get("observation_id") for row in manifest.get("observations", [])}
        for row in records:
            if row.get("observation_id") in known_ids:
                continue
            fallback = {
                key: row.get(key)
                for key in ("observation_id", "phase", "mode", "task_id", "pair_id", "pair_order", "reported")
            }
            fallback.update({
                "outcome": row.get("outcome", "transport_failure"),
                "trial_status": row.get("trial_status", "failed"),
                "error_type": row.get("error_type"),
                "safety_reasons": row.get("safety_reasons", []),
                "stop_campaign": row.get("stop_campaign", False),
            })
            manifest["observations"].append(fallback)
            _append_jsonl(observations_path, fallback)
            known_ids.add(row.get("observation_id"))
        manifest.setdefault("campaign_records", []).extend({
            "observation_id": row.get("observation_id"),
            "outcome": row.get("outcome"),
            "stop_campaign": row.get("stop_campaign", False),
        } for row in records)
        if records and records[-1].get("stop_campaign") is True:
            manifest["run_status"] = "incomplete"
            manifest["campaign_stop_reason"] = records[-1].get("safety_reasons") or records[-1].get("error_type") or records[-1].get("outcome")
        _atomic_write_json(manifest_path, manifest)
        return len(records) == len(trials) and (not records or records[-1].get("stop_campaign") is not True)

    try:
        with _open_process_logs(out_dir, log_names) as log_files:
            logs = dict(zip(log_names, log_files))
            with contextlib.ExitStack() as process_stack:
                model_stack, model_process, model_row, direct_ready_ms = start_model(
                    process_stack, logs["llama_cpp_process_cold_direct"], "process_cold_direct",
                )
                bun_processes = process_stack.enter_context(owned_processes(
                    bun_commands,
                    ports=[ports["direct"], ports["orchestrated"]],
                    env=bun_envs,
                    cwd=bun_cwds,
                    stdout_targets=[logs["bun_direct"], logs["bun_orchestrated"]],
                    popen_factory=popen_factory,
                ))
                bun_rows = []
                for mode, process, command, working_dir, port in zip(
                    bun_modes, bun_processes, bun_commands, bun_cwds, (ports["direct"], ports["orchestrated"]),
                ):
                    bun_rows.append(record_process(f"bun_{mode}", process, command, working_dir))
                    health = _wait_for_json(
                        f"http://127.0.0.1:{port}/health",
                        process,
                        timeout_s=30.0,
                        readiness_kind="health",
                    )
                    _assert_bun_loopback_health(health)
                    if health.get("backend") != "llama_cpp" or health.get("configured_model") != served_alias:
                        raise RuntimeError(f"{mode} Bun health did not confirm the expected local backend and alias")
                    config_response = _wait_for_json(
                        f"http://127.0.0.1:{port}/config",
                        process,
                        timeout_s=5.0,
                        readiness_kind="config",
                    )
                    _assert_runtime_config(
                        config_response,
                        expected=configs[mode],
                        mode=mode,
                        model_url=model_url,
                        served_alias=served_alias,
                    )
                    readiness.append({
                        "component": f"bun_{mode}",
                        "status": "ready",
                        "health": {key: health.get(key) for key in ("ok", "backend", "model", "configured_model", "bind_host", "git_sha", "source_tree_sha256")},
                        "effective_config_redacted": redact_config(config_response),
                        "effective_config_fingerprint": _fingerprint(redact_config(config_response)),
                    })
                manifest["readiness"] = readiness
                manifest["run_status"] = "ready"
                _atomic_write_json(manifest_path, manifest)

                cold_trials = [trial for trial in schedule if trial["phase"] == "process_cold"]
                if not consume(cold_trials[:1], model_ready_ms=direct_ready_ms, generation="process_cold_direct"):
                    return

                # Stop only our first llama-server handle while both owned Bun
                # servers stay alive; the next mode gets an unloaded process/KV.
                model_stack.close()
                mark_process_stopped(model_row, model_process)
                model_stack, model_process, model_row, orchestrated_ready_ms = start_model(
                    process_stack, logs["llama_cpp_process_cold_orchestrated"], "process_cold_orchestrated",
                )
                if not consume(cold_trials[1:], model_ready_ms=orchestrated_ready_ms, generation="process_cold_orchestrated"):
                    return

                warmups = [trial for trial in schedule if trial["phase"] == "warmup"]
                warm = [trial for trial in schedule if trial["phase"] == "warm"]
                if not consume(warmups, model_ready_ms=orchestrated_ready_ms, generation="warm"):
                    return
                if not consume(warm, model_ready_ms=orchestrated_ready_ms, generation="warm"):
                    return

        # A completed campaign has every scheduled record. Warm-ups remain in
        # observations with reported=false, while the report can omit them.
        complete = len(manifest.get("observations", [])) == len(schedule)
        manifest["run_status"] = "complete" if complete else "incomplete"
        manifest["campaign_complete"] = complete
        manifest["reported_warm_count"] = sum(
            item.get("phase") == "warm" for item in manifest.get("observations", [])
        )
        _atomic_write_json(manifest_path, manifest)
    finally:
        for row in manifest.get("processes", []):
            process = process_handles.get(row.get("pid"))
            if process is not None and row.get("status") != "stopped":
                exit_code = process.poll()
                if exit_code is not None:
                    row["exit_code"] = exit_code
                    row["status"] = "stopped"
        _atomic_write_json(manifest_path, manifest)


def run_comparison(args: argparse.Namespace) -> Path:
    """Start only owned loopback processes, validate readiness, then clean up."""
    repo_root = REPO_ROOT.resolve(strict=True)
    # This guard recognizes only the server's explicit allowlisted host override
    # or an explicit loopback source bind. The child environment below pins the
    # override, then /health must report the actual loopback address before any
    # capture begins.
    require_bun_loopback_bind(repo_root)

    llama_server = _require_explicit_file(getattr(args, "llama_server", None), "llama-server")
    model_path = _require_explicit_file(getattr(args, "model", None), "model")
    bun_value = getattr(args, "bun", None) or shutil.which("bun")
    if not bun_value:
        raise FileNotFoundError("Bun executable was not found; pass --bun explicitly")
    bun_path = _require_explicit_file(bun_value, "bun")
    served_alias = str(getattr(args, "served_alias", "jarvis-comparison-local"))
    llama_extra = validate_llama_extra_args(getattr(args, "llama_arg", []) or [])
    # Snapshot inputs before writing to --out-dir, which may itself be inside
    # the repository and must not perturb its own source fingerprint.
    source_snapshot = source_fingerprint(repo_root)
    artifact_hashes = {
        "llama_server_sha256": artifact_sha256(llama_server),
        "gguf_sha256": artifact_sha256(model_path),
        "bun_sha256": artifact_sha256(bun_path),
    }
    out_dir = _new_output_dir(Path(getattr(args, "out_dir", "")))

    fixture_dir = out_dir / "fixture"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    fixture_path = fixture_dir / "stock.csv"
    shutil.copyfile(FIXTURE_SOURCE, fixture_path)
    fixture_sha = artifact_sha256(fixture_path)

    homes = out_dir / "homes"
    for mode in ("model", "direct", "orchestrated"):
        (homes / mode).mkdir(parents=True, exist_ok=True)
    ports = {"llama_cpp": allocate_loopback_port(), "direct": allocate_loopback_port(), "orchestrated": allocate_loopback_port()}
    while len(set(ports.values())) != len(ports):
        ports = {"llama_cpp": allocate_loopback_port(), "direct": allocate_loopback_port(), "orchestrated": allocate_loopback_port()}
    ensure_loopback_ports_free(list(ports.values()))
    model_url = f"http://127.0.0.1:{ports['llama_cpp']}/v1"
    bun_model_argv = [str(bun_path), "run", "--no-env-file", "src/index.ts"]
    llama_argv = [
        str(llama_server), "--model", str(model_path), "--host", "127.0.0.1",
        "--port", str(ports["llama_cpp"]), "--alias", served_alias, *llama_extra,
    ]
    provenance = build_provenance(
        repo_root=repo_root,
        llama_server=llama_server,
        model=model_path,
        bun=bun_path,
        served_alias=served_alias,
        llama_argv=llama_argv,
        bun_argv=bun_model_argv,
        source_snapshot=source_snapshot,
        artifact_hashes=artifact_hashes,
    )
    configs = build_mode_configs(
        isolated_home=homes,
        workspace=fixture_dir,
        llama_base_url=model_url,
        served_alias=served_alias,
        llama_server_path=llama_server,
        model_path=model_path,
    )
    config_paths: dict[str, Path] = {}
    for mode, config in configs.items():
        config_path = homes / mode / ".openclaw" / "jarvis" / "config.json"
        _write_json(config_path, config)
        config_paths[mode] = config_path
    fingerprints = {mode: _fingerprint(config) for mode, config in configs.items()}
    tasks = _load_tasks()
    manifest: dict[str, Any] = {
        **provenance,
        "llama_argv_redacted": _redact_argv(llama_argv),
        "bun_argv_redacted": _redact_argv(bun_model_argv),
        "generation_defaults": {task["id"]: {key: task[key] for key in ("max_tokens", "temperature", "top_p")} for task in tasks},
        "generation_policy": {"source": "comparison_generation", "completion_cap_scope": "per_model_invocation", **COMPARISON_GENERATION},
        "mode_config_fingerprints": fingerprints,
        "ports": ports,
        "fixture_path": str(fixture_path),
        "fixture_sha256": fixture_sha,
        "config_paths": {mode: str(path) for mode, path in config_paths.items()},
        "readiness": [],
        "processes": [],
        "run_status": "starting",
    }
    manifest_path = out_dir / "manifest.json"
    _atomic_write_json(manifest_path, manifest)

    try:
        _execute_campaign(
            out_dir=out_dir,
            manifest=manifest,
            manifest_path=manifest_path,
            tasks=tasks,
            configs=configs,
            llama_argv=llama_argv,
            bun_path=bun_path,
            repo_root=repo_root,
            homes=homes,
            fixture_dir=fixture_dir,
            fixture_path=fixture_path,
            fixture_sha=fixture_sha,
            ports=ports,
            served_alias=served_alias,
            model_url=model_url,
        )
    except BaseException as exc:
        manifest["run_status"] = "failed" if manifest.get("run_status") != "incomplete" else "incomplete"
        manifest["failure"] = {"type": type(exc).__name__, "reason": str(exc)}
        _atomic_write_json(manifest_path, manifest)
        try:
            _write_report_artifact(out_dir, manifest, manifest_path)
        except Exception:
            pass
        raise

    _write_report_artifact(out_dir, manifest, manifest_path)
    return out_dir


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run an isolated local Direct versus Orchestrated comparison.")
    parser.add_argument("--llama-server", required=True, type=Path, help="explicit llama-server executable path")
    parser.add_argument("--model", required=True, type=Path, help="explicit GGUF model path")
    parser.add_argument("--out-dir", required=True, type=Path, help="new empty directory for all comparison artifacts")
    parser.add_argument("--bun", type=Path, help="Bun executable path; defaults to the resolved Bun on PATH")
    parser.add_argument("--served-alias", default="jarvis-comparison-local")
    parser.add_argument("--llama-arg", action="append", default=[], help="additional llama-server flag; repeat as needed")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        out_dir = run_comparison(args)
    except (OSError, RuntimeError, ValueError, TimeoutError) as exc:
        print(f"comparison refused: {exc}", file=sys.stderr)
        return 1
    print(str(out_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
