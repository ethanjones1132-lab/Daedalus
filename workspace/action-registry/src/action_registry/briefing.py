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


def _sort_key(item: dict[str, Any]) -> tuple[int, int, float, str, str]:
    return (
        PRIORITY_ORDER.get(item.get("priority", "P3"), 99),
        _due_rank(item)[0],
        -_confidence_rank(item),
        _due_rank(item)[1],
        item.get("id", ""),
    )


def rank_executable_with_reasons(
    actions: list[dict[str, Any]],
    all_actions: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    catalog = all_actions if all_actions is not None else actions
    executable: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for action in sorted(actions, key=_sort_key):
        allowed, reason = can_execute(action, catalog)
        if allowed and action.get("status") in {"open", "in_progress"}:
            executable.append(action)
        else:
            excluded.append({"id": action.get("id"), "reason": reason})
    return executable, excluded


def rank_executable(
    actions: list[dict[str, Any]],
    all_actions: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    executable, _ = rank_executable_with_reasons(actions, all_actions)
    return executable


def _selection_payload(
    selected: dict[str, Any] | None,
    excluded: list[dict[str, Any]],
) -> dict[str, Any]:
    if selected is not None:
        reason = "all dependencies are done" if selected.get("dependencies") else "no dependencies to satisfy"
    else:
        reason = next(
            (item["reason"] for item in excluded if item.get("reason")),
            "no executable actions in queue",
        )
    return {"id": selected.get("id") if selected is not None else None, "reason": reason}


def select_next_with_reason(store: RegistryStore) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    all_actions = store.all_actions()
    active = [action for action in all_actions if action.get("_bucket") == "active"]
    ranked, excluded = rank_executable_with_reasons(active, all_actions)
    selected = ranked[0] if ranked else None
    return selected, _selection_payload(selected, excluded)


def select_next(store: RegistryStore) -> dict[str, Any] | None:
    selected, _ = select_next_with_reason(store)
    return selected


def build_brief(store: RegistryStore) -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    all_actions = store.all_actions()
    active = [action for action in all_actions if action.get("_bucket") == "active"]
    blocked = [action for action in all_actions if action.get("_bucket") == "blocked"]
    done = [action for action in all_actions if action.get("_bucket") == "done"]
    ranked, excluded = rank_executable_with_reasons(active, all_actions)
    selected = ranked[0] if ranked else None

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
        "next": selected,
        "selection": _selection_payload(selected, excluded),
        "excluded": excluded,
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
    selection = brief.get("selection") or {}
    if nxt:
        lines.extend([
            "## Next action",
            f"**{nxt['title']}** (`{nxt['id']}`)",
            f"- Priority: {nxt.get('priority')}",
            f"- Track: {infer_track_key(nxt)}",
            f"- Selection: {selection.get('reason', '')}",
            "",
        ])
    else:
        lines.extend([
            "## Next action",
            "No executable actions in queue.",
            f"- Selection: {selection.get('reason', '')}",
            "",
        ])
    if brief.get("top_executable"):
        lines.append("## Top executable")
        for item in brief["top_executable"]:
            lines.append(f"- [{item.get('priority')}] {item['title']} ({item['id']})")
    return "\n".join(lines) + "\n"