from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def requires_approval_gate(action: dict[str, Any]) -> bool:
    if not action.get("approval_required"):
        return False
    return action.get("approval_status") not in {"approved", "waived"}


def pending_approval_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [action for action in actions if requires_approval_gate(action)]


def _action_index(
    actions: Mapping[str, dict[str, Any]] | list[dict[str, Any]] | None,
) -> tuple[dict[str, dict[str, Any]], set[str]]:
    index: dict[str, dict[str, Any]] = {}
    ambiguous: set[str] = set()
    if actions is None:
        return index, ambiguous

    values = actions.values() if isinstance(actions, Mapping) else actions
    for action in values:
        if not isinstance(action, dict):
            continue
        action_id = action.get("id")
        if not isinstance(action_id, str) or not action_id.strip():
            continue
        if action_id in index:
            ambiguous.add(action_id)
        else:
            index[action_id] = action
    return index, ambiguous


def _dependency_reason(
    action: dict[str, Any],
    index: Mapping[str, dict[str, Any]],
    ambiguous: set[str],
    visiting: set[str],
    memo: dict[str, str | None],
) -> str | None:
    action_id = action.get("id")
    if not isinstance(action_id, str) or not action_id.strip():
        return "action has no valid dependency id"
    if action_id in memo:
        return memo[action_id]
    if action_id in visiting:
        return f"dependency cycle detected at {action_id}"

    visiting.add(action_id)
    reason: str | None = None
    dependencies = action.get("dependencies", [])
    if not isinstance(dependencies, list):
        reason = "dependencies are invalid"
    else:
        for dependency_id in dependencies:
            if not isinstance(dependency_id, str) or not dependency_id.strip():
                reason = "dependency entry is invalid"
                break
            if dependency_id == action_id:
                reason = f"action {action_id} depends on itself"
                break
            if dependency_id in ambiguous:
                reason = f"dependency {dependency_id} is ambiguous"
                break
            dependency = index.get(dependency_id)
            if dependency is None:
                reason = f"dependency {dependency_id} is missing"
                break
            nested_reason = _dependency_reason(dependency, index, ambiguous, visiting, memo)
            if nested_reason:
                reason = nested_reason
                break
            if dependency.get("status") == "done":
                continue
            status = dependency.get("status")
            status_text = status if isinstance(status, str) and status.strip() else "not done"
            reason = f"dependency {dependency_id} is {status_text}"
            break

    visiting.remove(action_id)
    memo[action_id] = reason
    return reason


def can_execute(
    action: dict[str, Any],
    actions: Mapping[str, dict[str, Any]] | list[dict[str, Any]] | None = None,
) -> tuple[bool, str | None]:
    if action.get("status") in {"done", "cancelled"}:
        return False, "action is already closed"
    if action.get("status") == "blocked":
        return False, "action is blocked"
    if requires_approval_gate(action):
        return False, "approval required before execution"

    dependencies = action.get("dependencies", [])
    if not isinstance(dependencies, list):
        return False, "dependencies are invalid"
    if not dependencies:
        return True, None
    if actions is None:
        return False, "dependency context unavailable"

    index, ambiguous = _action_index(actions)
    reason = _dependency_reason(action, index, ambiguous, set(), {})
    if reason:
        return False, reason
    return True, None
