from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .approval import pending_approval_actions


def _load_notifications(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "alerts": [], "suppressed": {}}
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload.setdefault("version", 1)
    payload.setdefault("alerts", [])
    payload.setdefault("suppressed", {})
    return payload


def _save_notifications(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _alert_key(alert: dict[str, Any]) -> str:
    action_id = alert.get("action_id") or ""
    return f"{alert.get('kind')}:{action_id}"


def build_alerts(store_summary: dict[str, int], buckets: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    stamp = datetime.now().isoformat(timespec="seconds")
    alerts: list[dict[str, Any]] = []

    for bucket_name, actions in buckets.items():
        for action in actions:
            if action.get("escalated"):
                alerts.append(
                    {
                        "id": f"escalated-{action['id']}",
                        "kind": "escalation",
                        "severity": "high",
                        "title": action.get("title", action["id"]),
                        "message": action.get("escalation_note", "P0 action escalated"),
                        "action_id": action["id"],
                        "bucket": bucket_name,
                        "created_at": stamp,
                    }
                )
            if action.get("approval_required") and action.get("approval_status") not in {"approved", "waived"}:
                alerts.append(
                    {
                        "id": f"approval-{action['id']}",
                        "kind": "approval_required",
                        "severity": "medium",
                        "title": action.get("title", action["id"]),
                        "message": "This action requires user approval before side effects can run.",
                        "action_id": action["id"],
                        "bucket": bucket_name,
                        "created_at": stamp,
                    }
                )

    pending = pending_approval_actions(buckets.get("active", []) + buckets.get("blocked", []))
    if pending:
        alerts.append(
            {
                "id": f"approval-summary-{stamp}",
                "kind": "approval_summary",
                "severity": "medium",
                "title": "Actions awaiting approval",
                "message": f"{len(pending)} action(s) require approval before execution.",
                "count": len(pending),
                "created_at": stamp,
            }
        )

    if store_summary.get("blocked", 0) > 0:
        alerts.append(
            {
                "id": f"blocked-summary-{stamp}",
                "kind": "blocked_summary",
                "severity": "medium",
                "title": "Blocked actions need attention",
                "message": f"{store_summary['blocked']} blocked action(s) are waiting on dependencies or access.",
                "count": store_summary["blocked"],
                "created_at": stamp,
            }
        )

    return alerts


def _filter_suppressed(alerts: list[dict[str, Any]], suppressed: dict[str, str]) -> list[dict[str, Any]]:
    now = datetime.now().isoformat(timespec="seconds")
    active: list[dict[str, Any]] = []
    for alert in alerts:
        key = _alert_key(alert)
        until = suppressed.get(key)
        if until and until > now:
            continue
        active.append(alert)
    return active


def dismiss_alert(notifications_path: Path, alert_id: str, *, hours: int = 24) -> bool:
    payload = _load_notifications(notifications_path)
    alert = next((item for item in payload.get("alerts", []) if item.get("id") == alert_id), None)
    if alert is None:
        return False
    until = datetime.now().timestamp() + hours * 3600
    payload.setdefault("suppressed", {})[_alert_key(alert)] = datetime.fromtimestamp(until).isoformat(timespec="seconds")
    _save_notifications(notifications_path, payload)
    return True


def refresh_notifications(
    store_summary: dict[str, int],
    buckets: dict[str, list[dict[str, Any]]],
    *,
    notifications_path: Path,
) -> list[dict[str, Any]]:
    payload = _load_notifications(notifications_path)
    alerts = _filter_suppressed(build_alerts(store_summary, buckets), payload.get("suppressed", {}))
    payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
    payload["alerts"] = alerts
    _save_notifications(notifications_path, payload)
    return alerts