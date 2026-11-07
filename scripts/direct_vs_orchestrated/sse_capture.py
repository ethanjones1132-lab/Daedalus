"""Capture and summarize the Bun chat-stream SSE contract."""

from __future__ import annotations

import copy
import ipaddress
import json
import math
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

_TERMINAL_TYPES = {"result", "error", "cancelled"}


def parse_sse_data_line(line: str) -> dict[str, Any] | None:
    """Parse one SSE data line containing a JSON object; ignore other lines."""
    if not isinstance(line, str):
        return None
    normalized = line.rstrip("\r\n")
    if not normalized.startswith("data:"):
        return None
    payload = normalized[5:]
    if payload.startswith(" "):
        payload = payload[1:]
    try:
        value = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _event_frame(event: Any) -> dict[str, Any] | None:
    if not isinstance(event, dict):
        return None
    frame = event.get("frame")
    if isinstance(frame, dict):
        return frame
    data = event.get("data")
    if isinstance(data, dict):
        return data
    return event if isinstance(event.get("type"), str) else None


def _event_time(event: Any) -> float | None:
    if not isinstance(event, dict):
        return None
    value = event.get("received_ms", event.get("timestamp_ms"))
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return max(0.0, float(value))


def _number_field(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _result_outcome(frame: dict[str, Any]) -> str:
    subtype = frame.get("subtype")
    is_error = frame.get("is_error")
    if is_error is True or subtype in {"error", "failed"}:
        return "error"
    if subtype == "success" and is_error is not True:
        return "success"
    if subtype == "partial" and is_error is False:
        return "partial"
    return "unknown"


def summarize_events(
    events: list[dict[str, Any]],
    *,
    total_wall_ms: float | None = None,
) -> dict[str, Any]:
    """Summarize actual visible text, terminal outcome, timing, and telemetry.

    ``message_stop`` is a transport marker only. It never determines the
    terminal outcome; ``result``, ``error`` and ``cancelled`` do.
    """
    frames: list[dict[str, Any]] = []
    first_visible_ms: float | None = None
    last_visible_ms: float | None = None
    message_stop_ms: float | None = None
    terminal_ms: float | None = None
    terminal_frame: dict[str, Any] | None = None
    stream_text: list[str] = []
    valid_result_text: str | None = None
    route_attempt_frames: list[dict[str, Any]] = []
    stage_routes: list[dict[str, Any]] = []
    stage_events: list[dict[str, Any]] = []
    tool_use_frames: list[dict[str, Any]] = []
    tool_result_frames: list[dict[str, Any]] = []
    orchestration_metrics: dict[str, Any] | None = None
    observed_times: list[float] = []

    for event in events:
        frame = _event_frame(event)
        if frame is None:
            continue
        frames.append(frame)
        received_ms = _event_time(event)
        if received_ms is not None:
            observed_times.append(received_ms)
        frame_type = frame.get("type")

        if frame_type == "stream_event":
            delta = frame.get("delta")
            text = delta.get("text") if isinstance(delta, dict) else None
            if isinstance(text, str) and text:
                stream_text.append(text)
                if first_visible_ms is None:
                    first_visible_ms = received_ms
                last_visible_ms = received_ms
        elif frame_type == "message_stop":
            if message_stop_ms is None:
                message_stop_ms = received_ms
        elif frame_type == "route_attempt":
            route_attempt_frames.append(frame)
        elif frame_type == "stage_route":
            stage_routes.append(frame)
        elif frame_type == "orchestrator_stage":
            stage_events.append(frame)
        elif frame_type == "tool_use":
            tool_use_frames.append(frame)
        elif frame_type == "tool_result":
            tool_result_frames.append(frame)
        elif frame_type == "orchestration_metrics":
            orchestration_metrics = frame

        if frame_type in _TERMINAL_TYPES and terminal_frame is None:
            terminal_frame = frame
            terminal_ms = received_ms
            if frame_type == "result":
                value = frame.get("result")
                if isinstance(value, str) and value and frame.get("is_error") is False:
                    valid_result_text = value

    visible_text = "".join(stream_text)
    if not visible_text and valid_result_text is not None:
        visible_text = valid_result_text
        if first_visible_ms is None:
            first_visible_ms = terminal_ms
        last_visible_ms = terminal_ms

    route_summary = terminal_frame.get("route") if terminal_frame and isinstance(terminal_frame.get("route"), dict) else None
    summary_attempts = route_summary.get("attempts") if route_summary and isinstance(route_summary.get("attempts"), list) else None
    if isinstance(summary_attempts, list) and summary_attempts:
        route_attempts: list[dict[str, Any]] | None = summary_attempts
    elif route_attempt_frames:
        route_attempts = route_attempt_frames
    elif isinstance(summary_attempts, list):
        route_attempts = summary_attempts
    else:
        route_attempts = None
    answered_by = route_summary.get("answered_by") if route_summary and isinstance(route_summary.get("answered_by"), dict) else None
    direct_attribution: list[dict[str, Any]] = route_attempt_frames + stage_routes

    if terminal_frame is None:
        outcome = "transport_failure"
    elif terminal_frame.get("type") == "result":
        outcome = _result_outcome(terminal_frame)
    else:
        outcome = terminal_frame["type"]

    if total_wall_ms is None:
        total_wall_ms = max(observed_times) if observed_times else None
    else:
        total_wall_ms = max(0.0, float(total_wall_ms))

    delay = None
    if last_visible_ms is not None and terminal_ms is not None:
        delay = max(0.0, terminal_ms - last_visible_ms)

    return {
        "outcome": outcome,
        "visible_text": visible_text,
        "first_visible_ms": first_visible_ms,
        "last_visible_ms": last_visible_ms,
        "message_stop_ms": message_stop_ms,
        "terminal_ms": terminal_ms,
        "last_visible_to_terminal_ms": delay,
        "total_wall_ms": total_wall_ms,
        "subtype": terminal_frame.get("subtype") if terminal_frame else None,
        "code": terminal_frame.get("code") if terminal_frame else None,
        "reason": terminal_frame.get("reason") if terminal_frame else terminal_frame.get("error") if terminal_frame else None,
        "error": terminal_frame.get("error") if terminal_frame else None,
        "route_attempts": route_attempts,
        "answered_by": answered_by,
        "direct_path_route_attribution": direct_attribution or None,
        "stage_routes": stage_routes or None,
        "stage_events": stage_events or None,
        "orchestration_metrics": orchestration_metrics,
        "tokens_in": _number_field(orchestration_metrics.get("tokens_in")) if orchestration_metrics else None,
        "tokens_out": _number_field(orchestration_metrics.get("tokens_out")) if orchestration_metrics else None,
        "tokens_total": _number_field(orchestration_metrics.get("tokens_total")) if orchestration_metrics else None,
        "tool_use_count": len(tool_use_frames) if terminal_frame is not None else None,
        "tool_result_count": len(tool_result_frames) if terminal_frame is not None else None,
        "failed_tool_result_count": (
            sum(frame.get("is_error") is True for frame in tool_result_frames)
            if terminal_frame is not None
            else None
        ),
        "tool_use_frames": tool_use_frames,
        "tool_result_frames": tool_result_frames,
        "raw_frames": frames,
    }


def _local_endpoint(base_url: str, suffix: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(base_url)
        host = parsed.hostname
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError("base URL must be a valid loopback HTTP URL") from exc
    if parsed.scheme != "http" or not host or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("base URL must be a loopback HTTP URL without credentials, query, or fragment")
    if host.lower() != "localhost":
        try:
            address = ipaddress.ip_address(host)
        except ValueError as exc:
            raise ValueError("base URL must use localhost or a loopback IP address") from exc
        if not address.is_loopback:
            raise ValueError("base URL must resolve to a loopback address")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("base URL port is outside the valid range")
    path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, f"{path}/{suffix}", "", ""))


def _validate_task(task: dict[str, Any], wall_cap_ms: int) -> None:
    if not isinstance(task, dict) or not isinstance(task.get("prompt"), str) or not task["prompt"].strip():
        raise ValueError("task must contain a nonempty prompt")
    if isinstance(wall_cap_ms, bool) or not isinstance(wall_cap_ms, int) or wall_cap_ms <= 0:
        raise ValueError("wall_cap_ms must be a positive integer")
    max_tokens = task.get("max_tokens")
    temperature = task.get("temperature")
    top_p = task.get("top_p")
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens <= 0:
        raise ValueError("task max_tokens must be a positive integer")
    for name, value in (("temperature", temperature), ("top_p", top_p)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"task {name} must be a finite number")


def validate_runtime_config(runtime_config: dict[str, Any]) -> dict[str, Any]:
    """Require the complete isolated comparison policy before sending a turn."""
    if not isinstance(runtime_config, dict):
        raise ValueError("runtime_config must be a complete isolated comparison object")
    llama = runtime_config.get("llama_cpp")
    if runtime_config.get("active_backend") != "llama_cpp" or not isinstance(llama, dict):
        raise ValueError("runtime_config must select the isolated llama.cpp backend")
    base_url = llama.get("base_url")
    model = llama.get("model")
    if not isinstance(base_url, str) or not isinstance(model, str) or not model.strip():
        raise ValueError("runtime_config must contain the isolated llama.cpp URL and alias")
    try:
        parsed = urllib.parse.urlsplit(base_url)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("runtime_config llama.cpp URL must be loopback HTTP") from exc
    if parsed.scheme != "http" or host != "127.0.0.1" or port is None or parsed.path.rstrip("/") != "/v1" or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("runtime_config llama.cpp URL must be http://127.0.0.1:<port>/v1")

    orchestrator = runtime_config.get("orchestrator")
    if not isinstance(orchestrator, dict) or not isinstance(orchestrator.get("enabled"), bool):
        raise ValueError("runtime_config must contain an explicit orchestration mode")
    if orchestrator.get("allow_cloud_helpers") is not False:
        raise ValueError("runtime_config must disable cloud helpers")
    for section in ("session_memory", "conductor_learning", "skill_distillation"):
        section_config = orchestrator.get(section)
        if not isinstance(section_config, dict) or section_config.get("enabled") is not False:
            raise ValueError(f"runtime_config must disable orchestrator.{section}")
    if orchestrator["conductor_learning"].get("trajectory_export") is not False:
        raise ValueError("runtime_config must disable conductor trajectory export")
    conductor = orchestrator.get("conductor")
    if not isinstance(conductor, dict):
        raise ValueError("runtime_config must configure the isolated resident conductor")
    expected_conductor = {
        "enabled": True,
        "base_url": base_url,
        "model": model,
        "fallback_model": "",
        "fallback_to_api": False,
        "keep_warm": False,
        "persist_sessions": False,
        "kv_persist": False,
        "kv_backend": "llama_cpp",
    }
    if any(conductor.get(key) != value for key, value in expected_conductor.items()):
        raise ValueError("runtime_config resident conductor must match the isolated local endpoint without warm-up, fallback, or persistence")

    claude = runtime_config.get("claude_cli")
    openrouter = runtime_config.get("openrouter")
    vllm = runtime_config.get("vllm")
    if not isinstance(claude, dict) or claude.get("enabled") is not False:
        raise ValueError("runtime_config must disable Claude CLI")
    if not isinstance(openrouter, dict) or openrouter.get("api_key") != "" or openrouter.get("enable_fallbacks") is not False or openrouter.get("enable_paid_fallbacks") is not False or openrouter.get("fallbacks") != []:
        raise ValueError("runtime_config must disable cloud model fallbacks")
    if not isinstance(vllm, dict) or vllm.get("enabled") is not False:
        raise ValueError("runtime_config must disable vLLM")
    for section in ("opencode_zen", "opencode_go"):
        provider = runtime_config.get(section)
        if not isinstance(provider, dict) or provider.get("api_key") != "":
            raise ValueError(f"runtime_config must omit credentials for {section}")
    return copy.deepcopy(runtime_config)


def _is_timeout_error(exc: BaseException) -> bool:
    current: Any = exc
    while isinstance(current, BaseException):
        if isinstance(current, (TimeoutError, socket.timeout)):
            return True
        if isinstance(current, urllib.error.URLError):
            current = current.reason
        else:
            current = current.__cause__
    return False


class _RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        close = getattr(file_pointer, "close", None)
        if callable(close):
            close()
        raise urllib.error.URLError("redirect blocked for local capture")


def _open_local(request: urllib.request.Request, *, timeout: float):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RejectRedirectHandler())
    return opener.open(request, timeout=timeout)

def _cancel_session(
    base_url: str,
    session_id: str,
    *,
    timeout_s: float = 5.0,
    deadline_mono: float | None = None,
) -> bool:
    """Request cancellation, bounding the whole HTTP operation by a monotonic deadline.

    urllib's timeout is a socket inactivity timeout and can be extended by a
    slow-drip response. The daemon worker lets the caller stop waiting at the
    absolute deadline; its owning server/process is then stopped by the runner.
    """
    if deadline_mono is None:
        if not math.isfinite(timeout_s) or timeout_s <= 0:
            return False
        deadline_mono = time.monotonic() + timeout_s
    elif not math.isfinite(deadline_mono):
        return False

    outcome: list[bool] = []

    def request_cancel() -> None:
        try:
            timeout = deadline_mono - time.monotonic()
            if timeout <= 0:
                outcome.append(False)
                return
            endpoint = _local_endpoint(base_url, "chat/cancel")
            request = urllib.request.Request(
                endpoint,
                data=json.dumps({"session_id": session_id}, separators=(",", ":")).encode("utf-8"),
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                method="POST",
            )
            with _open_local(request, timeout=timeout) as response:
                payload = json.loads(response.read(16_384).decode("utf-8"))
            outcome.append(isinstance(payload, dict) and payload.get("cancelled") is True)
        except (OSError, TimeoutError, ValueError, urllib.error.URLError):
            outcome.append(False)

    worker = threading.Thread(target=request_cancel, name="jarvis-session-cancel", daemon=True)
    worker.start()
    while worker.is_alive():
        remaining = deadline_mono - time.monotonic()
        if remaining <= 0:
            return False
        worker.join(remaining)
    return bool(outcome and outcome[0])


def capture_turn(
    base_url: str,
    *,
    session_id: str,
    task: dict[str, Any],
    wall_cap_ms: int,
    out_path: Path,
    runtime_config: dict[str, Any],
) -> dict[str, Any]:
    """Post one isolated turn, flushing each SSE line as JSONL evidence."""
    stream_url = _local_endpoint(base_url, "chat/stream")
    _validate_task(task, wall_cap_ms)
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("session_id must be a nonempty string")
    request_config = validate_runtime_config(runtime_config)
    request_config.update({
        "max_tokens": task["max_tokens"],
        "temperature": task["temperature"],
        "top_p": task["top_p"],
    })
    # Stage presets and local minimums normally override these root samplers.
    # This explicit opt-in applies the same effective values at final dispatch.
    request_config["comparison_generation"] = {
        key: task[key] for key in ("max_tokens", "temperature", "top_p")
    }

    request_body = {
        "message": task["prompt"],
        "history": [],
        "session_id": session_id,
        "surface": "chat",
        "config": request_config,
    }
    request = urllib.request.Request(
        stream_url,
        data=json.dumps(request_body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    output = Path(out_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    events: list[dict[str, Any]] = []
    started = time.perf_counter()
    timed_out = False
    transport_error: str | None = None
    timeout_seconds = wall_cap_ms / 1000.0

    with output.open("x", encoding="utf-8", newline="\n") as evidence:
        try:
            with _open_local(request, timeout=timeout_seconds) as response:
                while True:
                    if (time.perf_counter() - started) * 1000 >= wall_cap_ms:
                        timed_out = True
                        break
                    raw_bytes = response.readline()
                    if not raw_bytes:
                        break
                    received_ms = round((time.perf_counter() - started) * 1000, 3)
                    raw_line = raw_bytes.decode("utf-8", errors="replace").rstrip("\r\n")
                    frame = parse_sse_data_line(raw_line)
                    record: dict[str, Any] = {"received_ms": received_ms, "raw_line": raw_line, "frame": frame}
                    if raw_line.startswith("data:") and frame is None:
                        record["parse_error"] = "invalid_or_non_object_json"
                    evidence.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                    evidence.flush()
                    if frame is not None:
                        events.append(record)
                        if frame.get("type") in _TERMINAL_TYPES:
                            break
        except urllib.error.HTTPError as exc:
            transport_error = f"http_{exc.code}"
        except (TimeoutError, socket.timeout, urllib.error.URLError) as exc:
            if _is_timeout_error(exc):
                timed_out = True
            else:
                transport_error = type(exc).__name__
        except OSError as exc:
            if _is_timeout_error(exc):
                timed_out = True
            else:
                transport_error = type(exc).__name__

    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    observation = summarize_events(events, total_wall_ms=elapsed_ms)
    if timed_out and observation["terminal_ms"] is None:
        observation["outcome"] = "timeout"
        observation["timeout_ms"] = wall_cap_ms
        observation["cancel_confirmed"] = _cancel_session(base_url, session_id)
    elif transport_error and observation["terminal_ms"] is None:
        observation["outcome"] = "transport_failure"
        observation["transport_error"] = transport_error
    return observation
