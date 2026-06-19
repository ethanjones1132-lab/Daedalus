#!/usr/bin/env python3
"""Automate inference metrics collection and reporting.

This script automates the collection of inference metrics from the Jarvis
database, generates reports on model performance, token usage, and latency,
and outputs JSON/CSV files for analysis.

Usage:
    python automate_inference_metrics.py [--output-dir ./reports] [--days 7]
"""

import argparse
import json
import csv
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict


def get_default_db_path() -> Path:
    """Get the default Jarvis database path."""
    home = Path.home()
    # Try common locations
    candidates = [
        home / ".openclaw" / "agents" / "coderclaw" / "workspace" / "home-base" / "jarvis.db",
        home / ".openclaw" / "jarvis" / "jarvis.db",
        home / "jarvis.db",
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]  # Default even if not found


def collect_metrics(db_path: Path, days: int = 7) -> dict:
    """Collect inference metrics from the Jarvis database."""
    if not db_path.exists():
        return {"error": f"Database not found: {db_path}"}

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()

    # Agent runs metrics
    runs = conn.execute(
        "SELECT * FROM agent_runs WHERE created_at > ? ORDER BY created_at DESC",
        (cutoff,)
    ).fetchall()

    # Stage runs metrics
    stages = conn.execute(
        "SELECT * FROM stage_runs WHERE created_at > ? ORDER BY created_at DESC",
        (cutoff,)
    ).fetchall()

    # Tuning proposals
    proposals = conn.execute(
        "SELECT * FROM tuning_proposals WHERE created_at > ? ORDER BY created_at DESC",
        (cutoff,)
    ).fetchall()

    conn.close()

    # Aggregate metrics
    total_runs = len(runs)
    total_stages = len(stages)

    # Model usage breakdown
    model_usage = defaultdict(lambda: {"count": 0, "total_tokens": 0, "total_duration": 0.0})
    for run in runs:
        model = run["model"] if isinstance(run, sqlite3.Row) else run[2]  # Adjust index as needed
        tokens = run["token_count"] if isinstance(run, sqlite3.Row) else run[5] or 0
        duration = run["duration"] if isinstance(run, sqlite3.Row) else run[6] or 0.0
        model_usage[model]["count"] += 1
        model_usage[model]["total_tokens"] += tokens
        model_usage[model]["total_duration"] += duration

    # Average metrics
    avg_duration = sum(
        (r["duration"] if isinstance(r, sqlite3.Row) else r[6] or 0.0) for r in runs
    ) / max(total_runs, 1)

    avg_tokens = sum(
        (r["token_count"] if isinstance(r, sqlite3.Row) else r[5] or 0) for r in runs
    ) / max(total_runs, 1)

    # User ratings
    rated_runs = [r for r in runs if (r["user_rating"] if isinstance(r, sqlite3.Row) else r[7]) is not None]
    avg_rating = sum(
        (r["user_rating"] if isinstance(r, sqlite3.Row) else r[7] or 0) for r in rated_runs
    ) / max(len(rated_runs), 1)

    return {
        "period_days": days,
        "generated_at": datetime.utcnow().isoformat(),
        "total_runs": total_runs,
        "total_stages": total_stages,
        "avg_duration_seconds": round(avg_duration, 2),
        "avg_tokens_per_run": round(avg_tokens, 1),
        "avg_user_rating": round(avg_rating, 2),
        "total_proposals": len(proposals),
        "model_usage": dict(model_usage),
    }


def write_json_report(metrics: dict, output_dir: Path) -> Path:
    """Write metrics as JSON."""
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"inference_metrics_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return path


def write_csv_report(metrics: dict, output_dir: Path) -> Path:
    """Write model usage as CSV."""
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"model_usage_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["model", "run_count", "total_tokens", "total_duration_s", "avg_tokens", "avg_duration_s"])
        for model, usage in metrics.get("model_usage", {}).items():
            count = usage["count"]
            writer.writerow([
                model,
                count,
                usage["total_tokens"],
                round(usage["total_duration"], 2),
                round(usage["total_tokens"] / max(count, 1), 1),
                round(usage["total_duration"] / max(count, 1), 2),
            ])
    return path


def main():
    parser = argparse.ArgumentParser(description="Automate Jarvis inference metrics collection")
    parser.add_argument("--db", type=str, default=None, help="Path to jarvis.db")
    parser.add_argument("--output-dir", type=str, default="./reports", help="Output directory")
    parser.add_argument("--days", type=int, default=7, help="Number of days to look back")
    parser.add_argument("--format", choices=["json", "csv", "both"], default="both", help="Output format")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else get_default_db_path()
    output_dir = Path(args.output_dir)

    print(f"Collecting metrics from {db_path} (last {args.days} days)...")
    metrics = collect_metrics(db_path, args.days)

    if "error" in metrics:
        print(f"Error: {metrics['error']}", file=sys.stderr)
        sys.exit(1)

    print(f"  Total runs: {metrics['total_runs']}")
    print(f"  Avg duration: {metrics['avg_duration_seconds']}s")
    print(f"  Avg tokens: {metrics['avg_tokens_per_run']}")
    print(f"  Avg rating: {metrics['avg_user_rating']}")

    if args.format in ("json", "both"):
        path = write_json_report(metrics, output_dir)
        print(f"  JSON report: {path}")

    if args.format in ("csv", "both"):
        path = write_csv_report(metrics, output_dir)
        print(f"  CSV report: {path}")

    print("Done.")


if __name__ == "__main__":
    main()
