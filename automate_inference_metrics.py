#!/usr/bin/env python3
"""Build Jarvis inference latency/reliability reports and a routing policy.

The source of truth is ``~/.openclaw/jarvis/self-tuning.db``.  The generated
JSON is deliberately provider-key-safe: it contains model identifiers and
aggregate telemetry only, never request bodies, outputs, or credentials.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
DEFAULT_MIN_SAMPLES = 5
MIN_FIRST_TOKEN_SAMPLES = 20
POLICY_TTL_HOURS = 48


def get_default_db_path(home: Path | None = None) -> Path:
    """Return the dedicated live self-tuning database path."""
    return (home or Path.home()) / ".openclaw" / "jarvis" / "self-tuning.db"


def get_default_policy_path(home: Path | None = None) -> Path:
    return (home or Path.home()) / ".openclaw" / "jarvis" / "inference-feedback.json"


def _iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _percentile(values: Iterable[float | int | None], percentile: float) -> int | None:
    ordered = sorted(float(value) for value in values if value is not None and math.isfinite(float(value)))
    if not ordered:
        return None
    index = (len(ordered) - 1) * percentile
    low = math.floor(index)
    high = math.ceil(index)
    value = ordered[low] + (ordered[high] - ordered[low]) * (index - low)
    return round(value)


def _latency_stats(values: Iterable[float | int | None]) -> dict[str, int | None]:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return {
        "mean": round(sum(clean) / len(clean)) if clean else None,
        "p50": _percentile(clean, 0.50),
        "p95": _percentile(clean, 0.95),
        "p99": _percentile(clean, 0.99),
        "max": round(max(clean)) if clean else None,
    }


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _model_policy(model: dict[str, Any], min_samples: int) -> dict[str, Any] | None:
    if model["sample_count"] < min_samples:
        return None

    success_rate = float(model["success_rate"])
    p95_duration = float(model["p95_duration_ms"] or 0)
    reliability_delta = _clamp((success_rate - 0.75) * 0.4, -0.15, 0.10)
    speed_delta = _clamp((30_000 - p95_duration) / 200_000, -0.15, 0.10)
    routing_delta = round(_clamp(reliability_delta + speed_delta, -0.25, 0.15), 4)
    adjustment: dict[str, Any] = {
        "sample_count": model["sample_count"],
        "routing_score_delta": routing_delta,
        "speed_capability_delta": round(speed_delta, 4),
        "reliability_capability_delta": round(reliability_delta, 4),
    }

    # A first-token watchdog must be based on first-token observations, never
    # total completion duration. Tightening a production watchdog on the five
    # samples needed for routing proved too eager under free-tier variance, so
    # require a deeper tail sample and use p99 with bounded headroom. Older rows
    # without first_token_ms still influence routing only, not timeout policy.
    if (
        model["first_token_sample_count"] >= max(min_samples, MIN_FIRST_TOKEN_SAMPLES)
        and model["p99_first_token_ms"] is not None
    ):
        empirical = math.ceil((float(model["p99_first_token_ms"]) * 1.25) / 1_000) * 1_000
        adjustment["first_token_timeout_ms"] = int(_clamp(empirical, 5_000, 55_000))
    return adjustment


def collect_metrics(
    db_path: Path,
    days: int = 7,
    *,
    now: datetime | None = None,
    min_samples: int = DEFAULT_MIN_SAMPLES,
) -> dict[str, Any]:
    """Collect real-schema metrics and derive a bounded feedback policy."""
    if not db_path.exists():
        return {"error": f"Database not found: {db_path}"}

    generated = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = generated - timedelta(days=max(1, days))
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        attribution_columns = _columns(conn, "model_attributions")
        first_token_expr = "first_token_ms" if "first_token_ms" in attribution_columns else "NULL AS first_token_ms"
        runs = conn.execute(
            "SELECT id, duration_ms, outcome, token_count, user_rating, created_at "
            "FROM agent_runs WHERE completed = 1 AND created_at >= ? ORDER BY created_at",
            (_iso_z(cutoff),),
        ).fetchall()
        stages = conn.execute(
            "SELECT mode_id, duration_ms, was_successful, had_error, created_at "
            "FROM stage_runs WHERE created_at >= ? ORDER BY created_at",
            (_iso_z(cutoff),),
        ).fetchall()
        models = conn.execute(
            f"SELECT provider, model_id, duration_ms, {first_token_expr}, was_successful, had_error, fallback_used, created_at "
            "FROM model_attributions WHERE created_at >= ? ORDER BY created_at",
            (_iso_z(cutoff),),
        ).fetchall()
        proposals = conn.execute(
            "SELECT applied FROM tuning_proposals WHERE created_at >= ?",
            (_iso_z(cutoff),),
        ).fetchall()
    finally:
        conn.close()

    stage_groups: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in stages:
        stage_groups[str(row["mode_id"])].append(row)
    stage_report: dict[str, Any] = {}
    for stage, rows in sorted(stage_groups.items()):
        latency = _latency_stats(row["duration_ms"] for row in rows)
        stage_report[stage] = {
            "sample_count": len(rows),
            "success_rate": round(sum(int(row["was_successful"] or 0) for row in rows) / len(rows), 4),
            "error_count": sum(int(row["had_error"] or 0) for row in rows),
            "mean_duration_ms": latency["mean"],
            "p50_duration_ms": latency["p50"],
            "p95_duration_ms": latency["p95"],
            "p99_duration_ms": latency["p99"],
            "max_duration_ms": latency["max"],
        }

    model_groups: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in models:
        model_groups[f'{row["provider"]}:{row["model_id"]}'].append(row)
    model_report: dict[str, Any] = {}
    for key, rows in sorted(model_groups.items()):
        latency = _latency_stats(row["duration_ms"] for row in rows)
        first_tokens = [row["first_token_ms"] for row in rows if row["first_token_ms"] is not None]
        model_report[key] = {
            "provider": rows[0]["provider"],
            "model_id": rows[0]["model_id"],
            "sample_count": len(rows),
            "success_rate": round(sum(int(row["was_successful"] or 0) for row in rows) / len(rows), 4),
            "error_count": sum(int(row["had_error"] or 0) for row in rows),
            "fallback_rate": round(sum(int(row["fallback_used"] or 0) for row in rows) / len(rows), 4),
            "mean_duration_ms": latency["mean"],
            "p50_duration_ms": latency["p50"],
            "p95_duration_ms": latency["p95"],
            "p99_duration_ms": latency["p99"],
            "max_duration_ms": latency["max"],
            "first_token_sample_count": len(first_tokens),
            "p50_first_token_ms": _percentile(first_tokens, 0.50),
            "p95_first_token_ms": _percentile(first_tokens, 0.95),
            "p99_first_token_ms": _percentile(first_tokens, 0.99),
        }

    adjustments = {
        key: policy
        for key, model in model_report.items()
        if (policy := _model_policy(model, max(1, min_samples))) is not None
    }
    run_latency = _latency_stats(row["duration_ms"] for row in runs)
    report: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _iso_z(generated),
        "expires_at": _iso_z(generated + timedelta(hours=POLICY_TTL_HOURS)),
        "window": {"days": max(1, days), "cutoff": _iso_z(cutoff)},
        "totals": {
            "agent_runs": len(runs),
            "stage_runs": len(stages),
            "model_attributions": len(models),
            "tuning_proposals": len(proposals),
        },
        "run_latency_ms": run_latency,
        "stages": stage_report,
        "models": model_report,
        "tuning": {
            "proposal_count": len(proposals),
            "applied_count": sum(int(row["applied"] or 0) for row in proposals),
        },
        "routing_policy": {
            "min_samples": max(1, min_samples),
            "first_token_min_samples": max(max(1, min_samples), MIN_FIRST_TOKEN_SAMPLES),
            "model_adjustments": adjustments,
        },
    }
    return report


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)
    return path


def write_json_report(metrics: dict[str, Any], output_dir: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return _atomic_json_write(output_dir / f"inference_metrics_{timestamp}.json", metrics)


def write_csv_report(metrics: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = output_dir / f"model_usage_{timestamp}.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "provider", "model_id", "sample_count", "success_rate", "fallback_rate",
            "p50_duration_ms", "p95_duration_ms", "p95_first_token_ms",
        ])
        for model in metrics.get("models", {}).values():
            writer.writerow([
                model["provider"], model["model_id"], model["sample_count"],
                model["success_rate"], model["fallback_rate"], model["p50_duration_ms"],
                model["p95_duration_ms"], model["p95_first_token_ms"],
            ])
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Jarvis inference feedback metrics")
    parser.add_argument("--db", type=Path, default=get_default_db_path())
    parser.add_argument("--output-dir", type=Path, default=Path("./reports"))
    parser.add_argument("--policy-out", type=Path, default=get_default_policy_path())
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--min-samples", type=int, default=DEFAULT_MIN_SAMPLES)
    parser.add_argument("--format", choices=("json", "csv", "both"), default="both")
    args = parser.parse_args()

    metrics = collect_metrics(args.db, args.days, min_samples=args.min_samples)
    if "error" in metrics:
        print(f"Error: {metrics['error']}", file=sys.stderr)
        return 1

    policy_path = _atomic_json_write(args.policy_out, metrics)
    print(f"Policy: {policy_path}")
    print(f"Runs: {metrics['totals']['agent_runs']}; model samples: {metrics['totals']['model_attributions']}")
    if args.format in ("json", "both"):
        print(f"JSON report: {write_json_report(metrics, args.output_dir)}")
    if args.format in ("csv", "both"):
        print(f"CSV report: {write_csv_report(metrics, args.output_dir)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
