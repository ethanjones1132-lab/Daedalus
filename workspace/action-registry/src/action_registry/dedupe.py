from __future__ import annotations

from copy import deepcopy
from typing import Any

from .models import infer_track_key
from .store import RegistryStore


def find_track_duplicates(store: RegistryStore) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for action in store.all_actions():
        key = (action.get("project", ""), infer_track_key(action))
        groups.setdefault(key, []).append(action)

    duplicates = []
    for (project, track_key), items in groups.items():
        if len(items) > 1:
            duplicates.append({"project": project, "track_key": track_key, "actions": items})
    return duplicates


def merge_group(actions: list[dict[str, Any]]) -> dict[str, Any]:
    sorted_actions = sorted(actions, key=lambda item: item.get("created_at", ""))
    keeper = deepcopy(sorted_actions[0])
    keeper["track_key"] = infer_track_key(keeper)

    for donor in sorted_actions[1:]:
        if donor.get("action_kind") == "track" and keeper.get("action_kind") != "track":
            keeper, donor = donor, keeper
            keeper = deepcopy(keeper)
        keeper.setdefault("evidence", [])
        donor_evidence = donor.get("evidence", [])
        if isinstance(donor_evidence, list):
            keeper["evidence"] = store_merge_evidence(keeper.get("evidence", []), donor_evidence)
        for field in ("title", "description", "next_due", "confidence", "confidence_reason"):
            if not keeper.get(field) and donor.get(field):
                keeper[field] = donor[field]
        if donor.get("approval_required"):
            keeper["approval_required"] = True
        if donor.get("priority", "P3") < keeper.get("priority", "P3"):
            keeper["priority"] = donor["priority"]

    keeper["updated_at"] = max(item.get("updated_at", "") for item in actions)
    return keeper


def store_merge_evidence(existing: list[Any], incoming: list[Any]) -> list[Any]:
    import json

    merged = list(existing or [])
    seen = {json.dumps(item, sort_keys=True) for item in merged if isinstance(item, dict)}
    for item in incoming or []:
        if not isinstance(item, dict):
            continue
        key = json.dumps(item, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


def run_dedupe(store: RegistryStore, *, dry_run: bool = False) -> dict[str, Any]:
    groups = find_track_duplicates(store)
    merged_ids: list[str] = []
    removed_ids: list[str] = []

    for group in groups:
        actions = group["actions"]
        keeper = merge_group(actions)
        removed = [item["id"] for item in actions if item["id"] != keeper["id"]]
        removed_ids.extend(removed)
        merged_ids.append(keeper["id"])
        if not dry_run:
            for action_id in removed:
                located = store.get(action_id)
                if located:
                    for bucket in ("active", "blocked", "done"):
                        payload = store.load_bucket(bucket)
                        payload["actions"] = [a for a in payload.get("actions", []) if a.get("id") != action_id]
                        store.save_bucket(bucket, payload)
            store.upsert(keeper, audit_event="dedupe_merge")

    return {
        "groups": len(groups),
        "keepers": merged_ids,
        "removed": removed_ids,
        "dry_run": dry_run,
    }