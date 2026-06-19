from __future__ import annotations

from typing import Any


def requires_approval_gate(action: dict[str, Any]) -> bool:
    if not action.get("approval_required"):
        return False
    return action.get("approval_status") not in {"approved", "waived"}
    

def pending_approval_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [action for action in actions if requires_approval_gate(action)]


def can_execute(action: dict[str, Any]) -> tuple[bool, str | None]:
    if action.get("status") in {"done", "cancelled"}:
        return False, "action is already closed"
    if action.get("status") == "blocked":
            return False, "action is blocked"
    if requires_approval_gate(action):
        return False, "approval required before execution"
    return True, None
