from __future__ import annotations

from datetime import datetime
from typing import Any

from .approval import can_execute, pending_approval_actions
from .models import infer_track_key
from .store import PRIORITY_ORDER, RegistryStore


def _confidence_rank(action: dict[str, Any]) -> float:
    value = action.get("confidence")
    if isinstance(value, (int, float)):
        return float(value)
    return 0.5


def _due_rank(action: dict[str, Any]) -> tuple[int, str]:
    due = action.get("next_due")
    if isinstance(due, str) and due.strip():
        return 0, due
    return 1, ""


def rank_executable(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    executable = []
    for action in actions:
        ok, _ = can_execute(action)
        if ok and action.get("status") in {"open", "in_progress"}:
            executable.append(action)

    def sort_key(item: dict[str, Any]) -> tuple[int, int, float, str, str]:
        return (
            PRIORITY_ORDER.get(item.get("priority", "P3"), 99),
            _due_rank(item)[0],
            -_confidence_rank(item),
            _due_rank(item)[1],
            item.get("id", ""),
        )

    return sorted(executable, key=sort_key)


def select_next(store: RegistryStore) -> dict[str, Any] | None:
    active = store.list_actions(bucket="active")
    ranked = rank_executable(active)
    return ranked[0] if ranked else None


def build_brief(store: RegistryStore) -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    active = store.list_actions(bucket="active")
    blocked = store.list_actions(bucket="blocked")
    done = store.list_actions(bucket="done")
    ranked = rank_executable(active)

    p0s = [a for a in active if a.get("priority") == "P0"]
    overdue = [
        a for a in active
        if isinstance(a.get("next_due"), str) and a["next_due"] < now
    ]
    approvals = pending_approval_actions(active + blocked)
    escalated = [a for a in active if a.get("escalated")]

    return {
        "generated_at": now,
        "summary": store.summary(),
        "p0_count": len(p0s),
        "overdue_count": len(overdue),
        "blocked_count": len(blocked),
        "approval_count": len(approvals),
        "escalated_count": len(escalated),
        "done_count": len(done),
        "top_executable": ranked[:3],
        "next": ranked[0] if ranked else None,
        "p0s": [{"id": a["id"], "title": a["title"], "track_key": infer_track_key(a)} for a in p0s],
        "approvals": [{"id": a["id"], "title": a["title"]} for a in approvals],
    }


def brief_markdown(brief: dict[str, Any]) -> str:
    lines = [
        "# Action Registry Brief",
        "",
        f"Generated: {brief['generated_at']}",
        "",
        f"- Active: {brief['summary']['active']}",
        f"- Blocked: {brief['blocked_count']}",
        f"- Done: {brief['done_count']}",
        f"- P0: {brief['p0_count']}",
        f"- Overdue: {brief['overdue_count']}",
        f"- Approvals pending: {brief['approval_count']}",
        "",
    ]
    nxt = brief.get("next")
    if nxt:
        lines.extend([
            "## Next action",
            f"**{nxt['title']}** (`{nxt['id']}`)",
            f"- Priority: {nxt.get('priority')}",
            f"- Track: {infer_track_key(nxt)}",
            "",
        ])
    else:
        lines.extend(["## Next action", "No executable actions in queue.", ""])
    if brief.get("top_executable"):
        lines.append("## Top executable")
        for item in brief["top_executable"]:
            lines.append(f"- [{item.get('priority')}] {item['title']} ({item['id']})")
    return "\n".join(lines) + "\n"