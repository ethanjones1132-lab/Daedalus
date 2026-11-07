"""Build a descriptive, provenance-backed comparison report from saved evidence."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Sequence

_SECRET_FIELD_RE = re.compile(
    r"(?:^|[_-])(?:api[_-]?key|access[_-]?key|(?:access|refresh|id|session)[_-]?token|client[_-]?secret|secret|password|passwd|authorization|auth|token)(?:$|[_-])",
    re.IGNORECASE,
)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if _SECRET_FIELD_RE.search(str(key)):
                result[key] = "[REDACTED]" if item not in (None, "", False) else item
            else:
                result[key] = _redact(item)
        return result
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    values: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSONL at {path}:{line_number}") from exc
            if isinstance(value, dict):
                values.append(value)
    return values


def _clean(value: Any) -> str:
    if value is None or value == "":
        return "unknown"
    if isinstance(value, bool):
        result = str(value).lower()
    elif isinstance(value, (dict, list)):
        result = json.dumps(_redact(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    else:
        result = str(value)
    return result.replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _format_ms(value: Any) -> str:
    number = _number(value)
    if number is None:
        return "unknown"
    return f"{number:.0f} ms"


def _route_records(observation: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    answer = observation.get("answered_by")
    if isinstance(answer, dict):
        records.append(answer)
    for key in ("route_attempts", "direct_path_route_attribution", "stage_routes"):
        value = observation.get(key)
        if isinstance(value, list):
            records.extend(record for record in value if isinstance(record, dict))
    return records


def _observed_route(observation: dict[str, Any]) -> str:
    records = _route_records(observation)
    if not records:
        return "unknown"
    rendered: list[str] = []
    for record in records:
        provider = record.get("provider", record.get("actual_provider"))
        model = record.get("model", record.get("actual_model"))
        if provider is None and model is None:
            continue
        label = f"{_clean(provider)}/{_clean(model)}"
        if record.get("cloud") is True:
            label += " (cloud)"
        rendered.append(label)
    return "; ".join(dict.fromkeys(rendered)) if rendered else "unknown"


def _observed_attempt_count(observation: dict[str, Any]) -> Any:
    for key in ("route_attempts", "direct_path_route_attribution"):
        value = observation.get(key)
        if isinstance(value, list):
            return len(value)
    return None


def _tool_counts(observation: dict[str, Any]) -> str:
    return (
        f"uses={_clean(observation.get('tool_use_count'))}, "
        f"results={_clean(observation.get('tool_result_count'))}, "
        f"failed={_clean(observation.get('failed_tool_result_count'))}"
    )


def _stage_count(observation: dict[str, Any]) -> Any:
    value = observation.get("stage_events")
    return len(value) if isinstance(value, list) else None


def _terminal_detail(observation: dict[str, Any]) -> str:
    code = observation.get("code")
    reason = observation.get("reason")
    if code is None and reason is None:
        return "unknown"
    if code is None:
        return _clean(reason)
    if reason is None:
        return _clean(code)
    return f"{_clean(code)}: {_clean(reason)}"


def _trial_row(observation: dict[str, Any]) -> str:
    pair = observation.get("pair_id")
    order = observation.get("pair_order")
    pair_label = "unknown" if pair is None else _clean(pair)
    if order:
        pair_label += f" ({_clean(order)})"
    return "| " + " | ".join([
        _clean(observation.get("observation_id")),
        _clean(observation.get("phase")),
        _clean(observation.get("mode")),
        _clean(observation.get("task_id")),
        pair_label,
        f"{_clean(observation.get('outcome'))}/{_clean(observation.get('trial_status'))}",
        _format_ms(observation.get("total_wall_ms")),
        _format_ms(observation.get("first_visible_ms")),
        _format_ms(observation.get("last_visible_to_terminal_ms")),
        _terminal_detail(observation),
        _clean(_stage_count(observation)),
        _tool_counts(observation),
        _clean(_observed_attempt_count(observation)),
        _clean(_observed_route(observation)),
        f"in={_clean(observation.get('tokens_in'))}, out={_clean(observation.get('tokens_out'))}, total={_clean(observation.get('tokens_total'))}",
    ]) + " |"


def _pair_delta(direct: dict[str, Any] | None, orchestrated: dict[str, Any] | None) -> str:
    if not direct or not orchestrated:
        return "incomplete pair"
    if any(
        row.get("outcome") != "success" or row.get("trial_status") not in (None, "success")
        for row in (direct, orchestrated)
    ):
        return "not comparable (failure retained)"
    direct_ms = _number(direct.get("total_wall_ms"))
    orchestrated_ms = _number(orchestrated.get("total_wall_ms"))
    if direct_ms is None or orchestrated_ms is None:
        return "unknown"
    delta = orchestrated_ms - direct_ms
    return f"{delta:+.0f} ms (Orchestrated - Direct)"


def _pair_observation_summary(observation: dict[str, Any] | None) -> str:
    if observation is None:
        return "unknown"
    return "; ".join([
        f"wall={_format_ms(observation.get('total_wall_ms'))}",
        f"first={_format_ms(observation.get('first_visible_ms'))}",
        f"last→terminal={_format_ms(observation.get('last_visible_to_terminal_ms'))}",
        f"outcome={_clean(observation.get('outcome'))}/{_clean(observation.get('trial_status'))}",
        f"terminal={_terminal_detail(observation)}",
    ])


def _paired_latency(observations: list[dict[str, Any]]) -> list[str]:
    pairs: dict[str, list[dict[str, Any]]] = {}
    for observation in observations:
        if observation.get("phase") == "warm" and isinstance(observation.get("pair_id"), str):
            pairs.setdefault(observation["pair_id"], []).append(observation)
    if not pairs:
        return ["No warm paired observations were recorded."]
    rows = [
        "| Task | Pair | Order | Direct | Orchestrated | Pair delta |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for pair_id, members in sorted(pairs.items(), key=lambda item: min(_number(m.get("order_index")) or 0 for m in item[1])):
        direct = next((row for row in members if row.get("mode") == "direct"), None)
        orchestrated = next((row for row in members if row.get("mode") == "orchestrated"), None)
        order = (direct or orchestrated or {}).get("pair_order")
        task_id = (direct or orchestrated or {}).get("task_id")
        rows.append("| " + " | ".join([
            _clean(task_id), _clean(pair_id), _clean(order),
            _pair_observation_summary(direct),
            _pair_observation_summary(orchestrated),
            _clean(_pair_delta(direct, orchestrated)),
        ]) + " |")
    return rows


def _acceptance_rows(rubric_results: list[dict[str, Any]], observations: list[dict[str, Any]]) -> list[str]:
    by_id = {row.get("observation_id"): row for row in observations if row.get("observation_id") is not None}
    if not rubric_results:
        return ["No acceptance results were recorded."]
    rows = [
        "| Observation | Mode | Pair | Assessment | Criterion | Result | Reviewer | Comment |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for result in rubric_results:
        observation = by_id.get(result.get("observation_id"), {})
        reviewer = result.get("reviewer") if isinstance(result.get("reviewer"), dict) else {}
        result_value = result.get("status", result.get("score", "unknown"))
        comment = result.get("comments", [])
        rows.append("| " + " | ".join([
            _clean(result.get("observation_id")),
            _clean(observation.get("mode")),
            _clean(observation.get("pair_id")),
            _clean(result.get("assessment_type")),
            _clean(result.get("criterion_id")),
            _clean(result_value),
            f"{_clean(reviewer.get('type'))}/{_clean(reviewer.get('identity'))}",
            _clean(comment),
        ]) + " |")
    return rows


def _provenance(manifest: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "source_sha", "source_tree_sha256", "source_dirty", "source_untracked_count",
        "source_inventory_complete", "llama_server_path", "llama_server_sha256",
        "gguf_path", "gguf_sha256", "served_alias", "llama_argv_redacted",
        "bun_path", "bun_sha256", "bun_argv_redacted", "hardware",
        "generation_defaults", "generation_policy", "mode_config_fingerprints", "ports", "readiness",
    )
    return {key: _redact(manifest[key]) for key in keys if key in manifest}


def build_report(
    manifest: dict[str, Any],
    observations: list[dict[str, Any]],
    rubric_results: list[dict[str, Any]],
) -> str:
    """Render all observations and scores without imputing unknown evidence."""
    counts = {
        phase: sum(row.get("phase") == phase for row in observations)
        for phase in ("process_cold", "warmup", "warm")
    }
    lines = [
        "# Direct vs Orchestrated Comparison",
        "",
        "**This is a small, descriptive-only comparison. It does not establish general quality superiority.**",
        "Attempt counts describe emitted route records. Native-conductor calls without per-attempt SSE are not included in those counts; wall time includes their work. Treat recorded attempt counts as observed counts rather than a complete inference-call total.",
        "",
        f"Run status: **{_clean(manifest.get('run_status'))}**. "
        f"Observed: {counts['warm']} warm, {counts['process_cold']} process-cold, "
        f"{counts['warmup']} unreported warm-up observations.",
        "",
        "## Paired wall time",
        "",
        "Deltas are shown only when both members completed successfully. Failures remain visible in the trial table and are not averaged away.",
        "",
        *_paired_latency(observations),
        "",
        "## Process-cold observations",
        "",
    ]
    cold = [row for row in observations if row.get("phase") == "process_cold"]
    if cold:
        lines.extend([
            "These timings are llama.cpp process/KV-cold. The harness does not clear the OS page cache or claim whole-machine cold state.",
            "",
            "| Observation | Mode | Model process ready | First visible output | Outcome |",
            "| --- | --- | ---: | ---: | --- |",
        ])
        for row in cold:
            lines.append("| " + " | ".join([
                _clean(row.get("observation_id")), _clean(row.get("mode")),
                _format_ms(row.get("model_process_ready_ms")), _format_ms(row.get("first_output_ms", row.get("first_visible_ms"))),
                _clean(row.get("outcome")),
            ]) + " |")
    else:
        lines.append("No process-cold observations were recorded.")
    lines.extend([
        "",
        "## Acceptance results",
        "",
        "Mechanical checks and independent subjective review are separate. Subjective scores remain pending until a reviewer who did not answer the Session records them.",
        "",
        *_acceptance_rows(rubric_results, observations),
        "",
        "## All trials",
        "",
        "Every captured trial is listed, including errors, timeouts, blocked trials, and unreported warm-ups.",
        "",
        "| Observation | Phase | Mode | Task | Pair/order | Outcome/status | Wall | First visible | Last-visible to terminal | Terminal code/reason | Stages | Tools | Attempts | Observed route | Tokens |",
        "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | --- | --- |",
    ])
    lines.extend(_trial_row(row) for row in observations)

    unsuccessful = [
        row for row in observations
        if row.get("outcome") != "success" or row.get("trial_status") not in (None, "success")
    ]
    lines.extend(["", "## Failures and stop reasons", ""])
    if unsuccessful:
        for row in unsuccessful:
            reasons = row.get("safety_reasons", [])
            if isinstance(reasons, list):
                reason = "; ".join(str(value) for value in reasons) or row.get("reason", "") or "unknown"
            else:
                reason = reasons
            cancel = row.get("cancel_confirmed")
            cancel_note = f"; cancel_confirmed={_clean(cancel)}" if cancel is not None else ""
            lines.append(
                f"- `{_clean(row.get('observation_id'))}`: {_clean(row.get('outcome'))}/"
                f"{_clean(row.get('trial_status'))}; {_clean(reason)}{cancel_note}"
            )
    else:
        lines.append("No failed or blocked observations were recorded.")

    provenance = _provenance(manifest)
    lines.extend([
        "",
        "## Provenance",
        "",
        "Only observed route and token fields are reported. Missing evidence is `unknown`; configured values are not substituted for observed values.",
        "",
        "```json",
        json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True),
        "```",
        "",
        "## Interpretation",
        "",
        "This fixed corpus and small number of pairs support descriptive inspection only. Review failures, unknown telemetry, and pending rubric scores with the raw evidence in `captures/`, `observations.jsonl`, and `rubric.jsonl`.",
        "",
    ])
    return "\n".join(lines)


def write_report(out_dir: Path | str) -> Path:
    root = Path(out_dir).expanduser().resolve(strict=True)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json must contain a JSON object")
    observations = read_jsonl(root / "observations.jsonl")
    rubric_results = read_jsonl(root / "rubric.jsonl")
    report_path = root / "report.md"
    report_path.write_text(build_report(manifest, observations, rubric_results), encoding="utf-8", newline="\n")
    return report_path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a report from saved comparison evidence.")
    parser.add_argument("out_dir", type=Path, help="comparison output directory containing manifest.json")
    args = parser.parse_args(argv)
    try:
        path = write_report(args.out_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"report failed: {exc}", file=sys.stderr)
        return 1
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
