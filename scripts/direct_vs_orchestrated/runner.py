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
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

PACKAGE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_ROOT.parents[1]
FIXTURE_SOURCE = PACKAGE_ROOT / "fixtures" / "stock.csv"
CLOUD_SECRET_NAMES = {
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AZURE_OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
    "OPENCODE_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY", "HTTP_PROXY", "HTTPS_PROXY",
    "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
}


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
    """Keep caller tuning flags from overriding the isolated server identity."""
    reserved = {"--host", "--port", "--model", "-m", "--alias", "--rpc"}
    values = [str(argument) for argument in arguments]
    for value in values:
        option = value.split("=", 1)[0].casefold()
        if option in reserved:
            raise ValueError(f"llama-server argument {option} is reserved by the local comparison harness")
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
    """Confirm the current Bun source binds to loopback; refuse broad binds."""
    root = Path(repo_root).resolve(strict=True)
    index_source = (root / "server-jarvis" / "src" / "index.ts").read_text(encoding="utf-8")
    guards_source = (root / "server-jarvis" / "src" / "server-guards.ts").read_text(encoding="utf-8")
    call = re.search(r"resolveBindTarget\(\s*PORT\s*(?:,\s*(['\"])(.*?)\1)?\s*\)", index_source)
    if not call:
        raise RuntimeError("cannot verify that the Bun server binds to loopback")
    explicit_host = call.group(2)
    if explicit_host is not None:
        host = explicit_host
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
            if re.search(r"(api[_-]?key|token|secret|password|authorization)", key, re.IGNORECASE):
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


def _wait_for_json(url: str, process: subprocess.Popen, *, timeout_s: float, expected_alias: str | None = None) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    last_error = "not yet ready"
    while time.monotonic() < deadline:
        code = process.poll()
        if code is not None:
            raise RuntimeError(f"owned process {process.pid} exited before readiness (code {code})")
        try:
            body = _local_json_request(url, timeout=1.0)
            if expected_alias is not None:
                models = body.get("data")
                if isinstance(models, list) and any(isinstance(model, dict) and model.get("id") == expected_alias for model in models):
                    return body
                last_error = "served alias not present in /v1/models"
            elif body.get("ok") is True or body.get("status") == "ok":
                return body
            else:
                last_error = "health response did not report ok=true"
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
        if re.search(r"(api[_-]?key|token|secret|password|authorization)", value, re.IGNORECASE):
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
    return tasks


def _new_output_dir(out_dir: Path) -> Path:
    resolved = out_dir.expanduser().resolve()
    if resolved.exists():
        if not resolved.is_dir() or any(resolved.iterdir()):
            raise FileExistsError(f"--out-dir must be a new or empty directory: {resolved}")
    else:
        resolved.mkdir(parents=True)
    return resolved


def run_comparison(args: argparse.Namespace) -> Path:
    """Start only owned loopback processes, validate readiness, then clean up."""
    repo_root = REPO_ROOT.resolve(strict=True)
    # This guard is deliberately before directory creation and before Popen.
    # The current source binds 0.0.0.0, so a caller must first use a source
    # version with a real loopback bind. An ignored environment hint is not
    # sufficient evidence of the actual socket address.
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
    bun_model_argv = [str(bun_path), "run", "src/index.ts"]
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

    server_root = repo_root / "server-jarvis"
    commands = [
        llama_argv,
        [str(bun_path), "run", "src/index.ts"],
        [str(bun_path), "run", "src/index.ts"],
    ]
    child_envs = [
        child_env(homes / "model", port=ports["llama_cpp"], workspace=fixture_dir),
        child_env(homes / "direct", port=ports["direct"], workspace=fixture_dir),
        child_env(homes / "orchestrated", port=ports["orchestrated"], workspace=fixture_dir),
    ]
    child_envs[1]["JARVIS_SERVER_PORT"] = str(ports["direct"])
    child_envs[2]["JARVIS_SERVER_PORT"] = str(ports["orchestrated"])
    child_cwds = [homes / "model", server_root, server_root]
    process_names = ["llama_cpp", "direct", "orchestrated"]
    readiness: list[dict[str, Any]] = []

    try:
        with _open_process_logs(out_dir, process_names) as logs:
            with owned_processes(
                commands,
                ports=list(ports.values()),
                env=child_envs,
                cwd=child_cwds,
                stdout_targets=logs,
            ) as processes:
                for name, process, command, working_dir in zip(process_names, processes, commands, child_cwds):
                    manifest["processes"].append({
                        "name": name,
                        "pid": process.pid,
                        "argv_redacted": _redact_argv(command),
                        "cwd": str(working_dir),
                        "owned_handle": True,
                    })
                _atomic_write_json(manifest_path, manifest)

                model_health = _wait_for_json(f"http://127.0.0.1:{ports['llama_cpp']}/health", processes[0], timeout_s=120.0)
                model_list = _wait_for_json(f"http://127.0.0.1:{ports['llama_cpp']}/v1/models", processes[0], timeout_s=5.0, expected_alias=served_alias)
                readiness.append({"component": "llama_cpp", "status": "ready", "health": model_health, "served_alias": served_alias, "model_count": len(model_list.get("data", []))})
                for mode, process, port in (("direct", processes[1], ports["direct"]), ("orchestrated", processes[2], ports["orchestrated"])):
                    health = _wait_for_json(f"http://127.0.0.1:{port}/health", process, timeout_s=30.0)
                    config_response = _wait_for_json(f"http://127.0.0.1:{port}/config", process, timeout_s=5.0)
                    expected_enabled = configs[mode]["orchestrator"]["enabled"]
                    if health.get("backend") != "llama_cpp" or health.get("configured_model") != served_alias:
                        raise RuntimeError(f"{mode} Bun health did not confirm the expected local backend and alias")
                    actual_orchestrator = config_response.get("orchestrator")
                    actual_llama = config_response.get("llama_cpp")
                    if not isinstance(actual_orchestrator, dict) or actual_orchestrator.get("enabled") is not expected_enabled:
                        raise RuntimeError(f"{mode} Bun /config did not confirm the intended orchestration mode")
                    if not isinstance(actual_llama, dict) or actual_llama.get("base_url") != model_url or actual_llama.get("model") != served_alias:
                        raise RuntimeError(f"{mode} Bun /config did not confirm the isolated llama.cpp target")
                    readiness.append({
                        "component": f"bun_{mode}",
                        "status": "ready",
                        "health": {key: health.get(key) for key in ("ok", "backend", "model", "configured_model", "git_sha", "source_tree_sha256")},
                        "effective_config_redacted": redact_config(config_response),
                        "effective_config_fingerprint": _fingerprint(redact_config(config_response)),
                    })
                manifest["readiness"] = readiness
                manifest["run_status"] = "ready"
                _atomic_write_json(manifest_path, manifest)
    except BaseException as exc:
        manifest["readiness"] = readiness
        manifest["run_status"] = "failed"
        manifest["failure"] = {"type": type(exc).__name__, "reason": str(exc)}
        _atomic_write_json(manifest_path, manifest)
        raise

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
