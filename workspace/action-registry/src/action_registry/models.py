from __future__ import annotations

from typing import Any

PRIORITIES = {"P0", "P1", "P2", "P3"}
RISK_LEVELS = {"low", "medium", "high", "critical"}
STATUSES = {"open", "in_progress", "blocked", "done", "cancelled"}
OWNERS = {"system", "user", "shared"}
ACTION_KINDS = {"track", "signal", "task"}
REQUIRED_FIELDS = {
    "id",
    "project",
    "source_system",
    "source_area",
    "priority",
    "risk_level",
    "category",
    "action_type",
    "title",
    "description",
    "acceptance_criteria",
    "dependencies",
    "status",
    "owner",
    "approval_required",
    "created_at",
    "updated_at",
}


def infer_track_key(action: dict[str, Any]) -> str:
    explicit = action.get("track_key")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    project = action.get("project", "").strip()
    source_area = action.get("source_area", "").strip()
    return f"{project}:{source_area}"


def normalize_action(action: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(action)
    normalized["track_key"] = infer_track_key(normalized)
    kind = normalized.get("action_kind")
    if kind not in ACTION_KINDS:
        normalized["action_kind"] = "task"
    return normalized


def bucket_for_status(status: str) -> str:
    if status == "done":
        return "done"
    if status == "blocked":
        return "blocked"
    return "active"


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(_is_non_empty_string(item) for item in value)


def validate_action(action: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    missing = sorted(field for field in REQUIRED_FIELDS if field not in action)
    if missing:
        errors.append(f"missing required fields: {', '.join(missing)}")
        return errors

    for field in [
        "id",
        "project",
        "source_system",
        "source_area",
        "category",
        "action_type",
        "title",
        "description",
        "created_at",
        "updated_at",
    ]:
        if not _is_non_empty_string(action.get(field)):
            errors.append(f"{field} must be a non-empty string")

    track_key = action.get("track_key")
    if track_key is not None and not _is_non_empty_string(track_key):
        errors.append("track_key must be a non-empty string when provided")

    action_kind = action.get("action_kind")
    if action_kind is not None and action_kind not in ACTION_KINDS:
        errors.append(f"action_kind must be one of {sorted(ACTION_KINDS)}")

    if action.get("priority") not in PRIORITIES:
        errors.append(f"priority must be one of {sorted(PRIORITIES)}")

    if action.get("risk_level") not in RISK_LEVELS:
        errors.append(f"risk_level must be one of {sorted(RISK_LEVELS)}")

    if action.get("status") not in STATUSES:
        errors.append(f"status must be one of {sorted(STATUSES)}")

    if action.get("owner") not in OWNERS:
        errors.append(f"owner must be one of {sorted(OWNERS)}")

    if not isinstance(action.get("approval_required"), bool):
        errors.append("approval_required must be a boolean")

    if not _is_string_list(action.get("acceptance_criteria")):
        errors.append("acceptance_criteria must be a list of non-empty strings")

    if not isinstance(action.get("dependencies"), list) or not all(
        _is_non_empty_string(item) for item in action.get("dependencies", [])
    ):
        errors.append("dependencies must be a list of non-empty strings")

    next_due = action.get("next_due")
    if next_due is not None and not _is_non_empty_string(next_due):
        errors.append("next_due must be a non-empty string or null")

    evidence = action.get("evidence", [])
    if evidence is not None:
        if not isinstance(evidence, list):
            errors.append("evidence must be a list when provided")
        else:
            for index, item in enumerate(evidence):
                if not isinstance(item, dict):
                    errors.append(f"evidence[{index}] must be an object")
                    continue
                if not _is_non_empty_string(item.get("kind")):
                    errors.append(f"evidence[{index}].kind must be a non-empty string")
                if not _is_non_empty_string(item.get("value")):
                    errors.append(f"evidence[{index}].value must be a non-empty string")

    confidence = action.get("confidence")
    if confidence is not None:
        if not isinstance(confidence, (int, float)) or not 0.0 <= float(confidence) <= 1.0:
            errors.append("confidence must be a number between 0.0 and 1.0 when provided")

    result_summary = action.get("result_summary")
    if result_summary is not None and not isinstance(result_summary, str):
        errors.append("result_summary must be a string when provided")

    completed_at = action.get("completed_at")
    if completed_at is not None and not _is_non_empty_string(completed_at):
        errors.append("completed_at must be a non-empty string or null")

    return errors