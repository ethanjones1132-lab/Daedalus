from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any


class AdapterContext:
    def __init__(
        self,
        *,
        home_base_root: str,
        snitch_root: str,
        jonesinsrc_root: str,
        prizepicks_root: str,
        now: datetime | None = None,
    ):
        self.home_base_root = home_base_root
        self.snitch_root = snitch_root
        self.jonesinsrc_root = jonesinsrc_root
        self.prizepicks_root = prizepicks_root
        self.now = now or datetime.now()

    @property
    def stamp(self) -> str:
        return self.now.isoformat(timespec="seconds")


class BaseAdapter(ABC):
    name: str

    @abstractmethod
    def collect(self, ctx: AdapterContext) -> list[dict[str, Any]]:
        """Return normalized action dicts ready for ingest."""


def build_action(
    *,
    item_id: str,
    project: str,
    track_key: str,
    source_system: str,
    source_area: str,
    action_kind: str,
    title: str,
    description: str,
    priority: str,
    risk_level: str,
    category: str,
    action_type: str,
    acceptance_criteria: list[str],
    evidence: list[dict[str, str]],
    stamp: str,
    approval_required: bool = False,
    confidence: float | None = None,
    confidence_reason: str | None = None,
    next_due: str | None = None,
) -> dict[str, Any]:
    action: dict[str, Any] = {
        "id": item_id,
        "project": project,
        "track_key": track_key,
        "source_system": source_system,
        "source_area": source_area,
        "action_kind": action_kind,
        "priority": priority,
        "risk_level": risk_level,
        "category": category,
        "action_type": action_type,
        "title": title,
        "description": description,
        "acceptance_criteria": acceptance_criteria,
        "dependencies": [],
        "status": "open",
        "owner": "shared",
        "approval_required": approval_required,
        "created_at": stamp,
        "updated_at": stamp,
        "evidence": evidence,
    }
    if confidence is not None:
        action["confidence"] = confidence
    if confidence_reason:
        action["confidence_reason"] = confidence_reason
    if next_due:
        action["next_due"] = next_due
    return action