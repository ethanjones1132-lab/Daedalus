from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


def audit_path(root: Path) -> Path:
    return root / "data" / "audit.jsonl"


def append_audit(root: Path, event: str, *, action_id: str | None = None, details: dict[str, Any] | None = None) -> None:
    path = audit_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "at": datetime.now().isoformat(timespec="seconds"),
        "event": event,
        "action_id": action_id,
        "details": details or {},
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")