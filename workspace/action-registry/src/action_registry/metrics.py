from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any

from .store import RegistryStore


def compute_metrics(store: RegistryStore) -> dict[str, Any]:
    actions = store.all_actions()
    by_project = Counter(item.get("project", "unknown") for item in actions)
    by_priority = Counter(item.get("priority", "unknown") for item in actions if item.get("_bucket") == "active")
    stale_p0 = sum(
        1 for item in actions
        if item.get("_bucket") == "active" and item.get("priority") == "P0" and item.get("escalated")
    )
    done = [item for item in actions if item.get("_bucket") == "done"]
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "totals": store.summary(),
        "by_project": dict(by_project),
        "active_by_priority": dict(by_priority),
        "stale_p0_escalated": stale_p0,
        "done_count": len(done),
    }