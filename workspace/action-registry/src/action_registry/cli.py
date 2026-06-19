from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .briefing import brief_markdown, build_brief, select_next
from .dedupe import run_dedupe
from .metrics import compute_metrics
from .models import validate_action
from .notifications import dismiss_alert
from .store import BUCKETS, RegistryStore
from .sync import sync_registry


def default_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _load_actions_file(path: Path) -> list[Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("actions"), list):
        return payload["actions"]
    raise ValueError(f"{path} must be a list or an object with an actions list")


def _collect_validation_errors(actions: list[Any], *, label: str) -> list[str]:
    errors: list[str] = []
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            errors.append(f"{label}[{index}] must be an object")
            continue
        for error in validate_action(action):
            errors.append(f"{label}[{index}] {error}")
    return errors


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Unified action registry workspace CLI")
    parser.add_argument("--root", type=Path, default=default_root(), help="Workspace root")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("summary", help="Print bucket counts")
    subparsers.add_parser("sync", help="Run adapters, ingest, refresh notifications")
    subparsers.add_parser("metrics", help="Print registry metrics")

    brief_parser = subparsers.add_parser("brief", help="Print agent briefing")
    brief_parser.add_argument("--format", choices=["json", "markdown"], default="json")

    next_parser = subparsers.add_parser("next", help="Print the top executable action")
    next_parser.add_argument("--format", choices=["json", "markdown"], default="json")

    dedupe_parser = subparsers.add_parser("dedupe", help="Merge duplicate track_key groups")
    dedupe_parser.add_argument("--dry-run", action="store_true")

    list_parser = subparsers.add_parser("list", help="List actions with optional filters")
    list_parser.add_argument("--project")
    list_parser.add_argument("--priority")
    list_parser.add_argument("--status")
    list_parser.add_argument("--bucket")

    get_parser = subparsers.add_parser("get", help="Get one action by id")
    get_parser.add_argument("action_id")

    start_parser = subparsers.add_parser("start", help="Mark action in_progress")
    start_parser.add_argument("action_id")

    approve_parser = subparsers.add_parser("approve", help="Approve or waive an action")
    approve_parser.add_argument("action_id")
    approve_parser.add_argument("--waive", action="store_true")

    block_parser = subparsers.add_parser("block", help="Block an action")
    block_parser.add_argument("action_id")
    block_parser.add_argument("--reason", required=True)

    done_parser = subparsers.add_parser("done", help="Mark action done")
    done_parser.add_argument("action_id")
    done_parser.add_argument("--result")

    cancel_parser = subparsers.add_parser("cancel", help="Cancel an action")
    cancel_parser.add_argument("action_id")
    cancel_parser.add_argument("--reason")

    dismiss_parser = subparsers.add_parser("dismiss-alert", help="Suppress a notification alert")
    dismiss_parser.add_argument("alert_id")

    validate_parser = subparsers.add_parser("validate", help="Validate registry buckets or a specific file")
    validate_parser.add_argument("--file", type=Path, default=None)

    ingest_parser = subparsers.add_parser("ingest", help="Merge an actions file into the registry")
    ingest_parser.add_argument("file", type=Path)
    ingest_parser.add_argument("--run-number", type=int, default=None)
    ingest_parser.add_argument("--seen-at", type=str, default=None)

    seed_parser = subparsers.add_parser("seed", help="Load bundled example actions")
    seed_parser.add_argument("--reset", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    store = RegistryStore.at_root(args.root)

    if args.command == "summary":
        print(json.dumps(store.summary(), indent=2))
        return 0

    if args.command == "metrics":
        print(json.dumps(compute_metrics(store), indent=2))
        return 0

    if args.command == "brief":
        brief = build_brief(store)
        if args.format == "markdown":
            print(brief_markdown(brief))
        else:
            print(json.dumps(brief, indent=2))
        return 0

    if args.command == "next":
        action = select_next(store)
        if action is None:
            print(json.dumps({"ok": True, "next": None}, indent=2))
            return 0
        if args.format == "markdown":
            print(f"# Next Action\n\n**{action['title']}** (`{action['id']}`)\n")
        else:
            print(json.dumps({"ok": True, "next": action}, indent=2))
        return 0

    if args.command == "dedupe":
        print(json.dumps(run_dedupe(store, dry_run=args.dry_run), indent=2))
        return 0

    if args.command == "list":
        actions = store.list_actions(
            project=args.project,
            priority=args.priority,
            status=args.status,
            bucket=args.bucket,
        )
        print(json.dumps(actions, indent=2))
        return 0

    if args.command == "get":
        located = store.get(args.action_id)
        if not located:
            print(json.dumps({"ok": False, "error": "not found"}, indent=2))
            return 1
        print(json.dumps(located, indent=2))
        return 0

    if args.command == "start":
        try:
            action = store.start_action(args.action_id)
        except KeyError:
            print(json.dumps({"ok": False, "error": "not found"}, indent=2))
            return 1
        print(json.dumps({"ok": True, "action": action}, indent=2))
        return 0

    if args.command == "approve":
        try:
            action = store.approve_action(args.action_id, status="waived" if args.waive else "approved")
        except KeyError:
            print(json.dumps({"ok": False, "error": "not found"}, indent=2))
            return 1
        print(json.dumps({"ok": True, "action": action}, indent=2))
        return 0

    if args.command == "block":
        try:
            action = store.block_action(args.action_id, reason=args.reason)
        except KeyError:
            print(json.dumps({"ok": False, "error": "not found"}, indent=2))
            return 1
        print(json.dumps({"ok": True, "action": action}, indent=2))
        return 0

    if args.command == "done":
        try:
            action = store.mark_done(args.action_id, result_summary=args.result)
        except KeyError:
            print(json.dumps({"ok": False, "error": "not found"}, indent=2))
            return 1
        print(json.dumps({"ok": True, "action": action}, indent=2))
        return 0

    if args.command == "cancel":
        try:
            action = store.cancel_action(args.action_id, reason=args.reason)
        except KeyError:
            print(json.dumps({"ok": False, "error": "not found"}, indent=2))
            return 1
        print(json.dumps({"ok": True, "action": action}, indent=2))
        return 0

    if args.command == "dismiss-alert":
        ok = dismiss_alert(store.root / "data" / "notifications.json", args.alert_id)
        print(json.dumps({"ok": ok}, indent=2))
        return 0 if ok else 1

    if args.command == "validate":
        errors: list[str] = []
        if args.file is not None:
            try:
                path = args.file if args.file.is_absolute() else (store.root / args.file)
                errors.extend(_collect_validation_errors(_load_actions_file(path), label=path.name))
            except ValueError as exc:
                errors.append(str(exc))
        else:
            for bucket in BUCKETS:
                errors.extend(store.validate_bucket(bucket))
        if errors:
            print(json.dumps({"ok": False, "errors": errors}, indent=2))
            return 1
        print(json.dumps({"ok": True}, indent=2))
        return 0

    if args.command == "ingest":
        path = args.file if args.file.is_absolute() else (store.root / args.file)
        try:
            stats = store.ingest_actions(
                _load_actions_file(path),
                run_number=args.run_number,
                seen_at=args.seen_at,
            )
        except ValueError as exc:
            print(json.dumps({"ok": False, "errors": str(exc).split("; ")}, indent=2))
            return 1
        print(json.dumps(stats, indent=2))
        return 0

    if args.command == "seed":
        if args.reset:
            for bucket in BUCKETS:
                store.save_bucket(bucket, {"bucket": bucket, "version": 1, "actions": []})
        seed_path = store.root / "examples" / "bootstrap.actions.json"
        for action in _load_actions_file(seed_path):
            store.upsert(action)
        print(json.dumps(store.summary(), indent=2))
        return 0

    if args.command == "sync":
        try:
            result = sync_registry(args.root)
        except ValueError as exc:
            print(json.dumps({"ok": False, "errors": str(exc).split("; ")}, indent=2))
            return 1
        print(json.dumps({"ok": True, **result}, indent=2))
        return 0

    parser.error(f"unknown command: {args.command}")
    return 2