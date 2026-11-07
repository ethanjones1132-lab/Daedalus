"""One-turn CLI worker; it never starts or configures Jarvis or llama.cpp."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from .sse_capture import capture_turn


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Capture one turn from an isolated local Jarvis server.")
    parser.add_argument("--base-url", required=True, help="isolated loopback Bun server base URL")
    parser.add_argument("--session-id", required=True, help="unique Session ID for this observation")
    parser.add_argument("--task-json", required=True, type=Path, help="JSON file containing one frozen task")
    parser.add_argument("--out", required=True, type=Path, help="new JSONL path for raw SSE evidence")
    parser.add_argument("--wall-cap-ms", required=True, type=_positive_int, help="request wall cap in milliseconds")
    args = parser.parse_args(argv)

    try:
        task = json.loads(args.task_json.read_text(encoding="utf-8"))
        if not isinstance(task, dict):
            raise ValueError("task JSON must contain one object")
        observation = capture_turn(
            args.base_url,
            session_id=args.session_id,
            task=task,
            wall_cap_ms=args.wall_cap_ms,
            out_path=args.out,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"outcome": "transport_failure", "error": str(exc)}, ensure_ascii=False))
        return 1

    print(json.dumps(observation, ensure_ascii=False, separators=(",", ":")))
    return 0 if observation.get("terminal_ms") is not None else 1


if __name__ == "__main__":
    sys.exit(main())
