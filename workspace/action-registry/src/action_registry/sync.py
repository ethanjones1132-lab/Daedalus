from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .adapters import collect_all, default_context
from .audit import append_audit
from .models import infer_track_key
from .notifications import refresh_notifications
from .store import RegistryStore

MISSING_RUNS_THRESHOLD = 2
SIGNAL_KIND = "signal"


def _run_state_path(root: Path) -> Path:
    return root / "data" / "sync-state.json"


def next_run_number(root: Path) -> int:
    path = _run_state_path(root)
    if not path.exists():
        return 1
    payload = json.loads(path.read_text(encoding="utf-8"))
    return int(payload.get("last_run_number", 0)) + 1


def save_run_state(root: Path, run_number: int, stats: dict[str, int | Any]) -> None:
    path = _run_state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "last_run_number": run_number,
        "last_run_at": datetime.now().isoformat(timespec="seconds"),
        "last_stats": stats,
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _auto_resolve_signals(
    store: RegistryStore,
    emitted_keys: set[tuple[str, str]],
    *,
    run_number: int,
    seen_at: str,
) -> int:
    resolved = 0
    for action in store.list_actions(bucket="active"):
        if action.get("action_kind") != SIGNAL_KIND:
            continue
        key = (action.get("project", ""), infer_track_key(action))
        if key in emitted_keys:
            continue
        last_seen = action.get("last_seen_run")
        if not isinstance(last_seen, int):
            continue
        if run_number - last_seen < MISSING_RUNS_THRESHOLD:
            continue
        store.mark_done(
            action["id"],
            result_summary="Signal cleared — adapter stopped emitting this condition",
            completed_at=seen_at,
        )
        resolved += 1
    return resolved


def sync_registry(root: Path | None = None) -> dict[str, Any]:
    store = RegistryStore.at_root(root)
    run_number = next_run_number(store.root)
    actions = collect_all(default_context(store.root))
    emitted_keys = {(item.get("project", ""), infer_track_key(item)) for item in actions}
    stats = store.ingest_actions(actions, run_number=run_number)
    stats["resolved_signals"] = _auto_resolve_signals(
        store,
        emitted_keys,
        run_number=run_number,
        seen_at=datetime.now().isoformat(timespec="seconds"),
    )

    save_run_state(store.root, run_number, stats)

    buckets = {bucket: store.load_bucket(bucket).get("actions", []) for bucket in ("active", "blocked", "done")}
    summary = store.summary()
    alerts = refresh_notifications(summary, buckets, notifications_path=store.root / "data" / "notifications.json")

    from .adapters import ADAPTERS

    append_audit(store.root, "sync", details={"run_number": run_number, **stats})
    return {
        "run_number": run_number,
        "ingest": stats,
        "summary": summary,
        "alerts": alerts,
        "adapters": [adapter.name for adapter in ADAPTERS],
    }