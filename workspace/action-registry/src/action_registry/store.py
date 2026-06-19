from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from .audit import append_audit
from .lockfile import registry_lock
from .models import bucket_for_status, infer_track_key, normalize_action, validate_action

PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
RISK_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
BUCKETS = ("active", "blocked", "done")
DEDUPE_BUCKETS = ("active", "blocked")
DEDUPABLE_STATUSES = {"open", "in_progress", "blocked"}
ESCALATION_STATUSES = {"open", "in_progress"}
TITLE_SIMILARITY_THRESHOLD = 0.72
ESCALATION_RUN_LIMIT = 2


class RegistryStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.data_dir = self.root / "data"
        self.paths = {bucket: self.data_dir / f"{bucket}.json" for bucket in BUCKETS}

    @classmethod
    def at_root(cls, root: Path | None = None) -> "RegistryStore":
        workspace_root = Path(root) if root is not None else Path(__file__).resolve().parents[2]
        return cls(workspace_root)

    def load_bucket(self, bucket: str) -> dict[str, Any]:
        if bucket not in self.paths:
            raise KeyError(f"unknown bucket: {bucket}")
        path = self.paths[bucket]
        if not path.exists():
            return {"bucket": bucket, "version": 1, "actions": []}
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or "actions" not in payload:
            raise ValueError(f"bucket file {path} is malformed")
        payload.setdefault("bucket", bucket)
        payload.setdefault("version", 1)
        payload.setdefault("actions", [])
        return payload

    def save_bucket(self, bucket: str, payload: dict[str, Any]) -> None:
        path = self.paths[bucket]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def all_actions(self) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        for bucket in BUCKETS:
            for action in self.load_bucket(bucket).get("actions", []):
                if isinstance(action, dict):
                    item = deepcopy(action)
                    item["_bucket"] = bucket
                    actions.append(item)
        return actions

    def list_actions(
        self,
        *,
        project: str | None = None,
        priority: str | None = None,
        status: str | None = None,
        bucket: str | None = None,
    ) -> list[dict[str, Any]]:
        actions = self.all_actions()
        if bucket is not None:
            actions = [item for item in actions if item.get("_bucket") == bucket]
        if project is not None:
            actions = [item for item in actions if item.get("project") == project]
        if priority is not None:
            actions = [item for item in actions if item.get("priority") == priority]
        if status is not None:
            actions = [item for item in actions if item.get("status") == status]
        return actions

    def summary(self) -> dict[str, int]:
        return {bucket: len(self.load_bucket(bucket).get("actions", [])) for bucket in BUCKETS}

    def get(self, action_id: str) -> dict[str, Any] | None:
        for bucket in BUCKETS:
            for action in self.load_bucket(bucket).get("actions", []):
                if action.get("id") == action_id:
                    return {"bucket": bucket, "action": deepcopy(action)}
        return None

    def get_by_track_key(self, project: str, track_key: str) -> dict[str, Any] | None:
        for bucket in BUCKETS:
            for action in self.load_bucket(bucket).get("actions", []):
                if action.get("project") == project and infer_track_key(action) == track_key:
                    return {"bucket": bucket, "action": deepcopy(action)}
        return None

    def upsert(self, action: dict[str, Any], *, audit_event: str = "upsert") -> str:
        action = normalize_action(deepcopy(action))
        errors = validate_action(action)
        if errors:
            raise ValueError("; ".join(errors))

        with registry_lock(self.root):
            target_bucket = bucket_for_status(action["status"])
            for bucket in BUCKETS:
                payload = self.load_bucket(bucket)
                filtered = [item for item in payload.get("actions", []) if item.get("id") != action["id"]]
                if bucket == target_bucket:
                    filtered.append(deepcopy(action))
                    filtered = self._sort_actions(filtered)
                payload["actions"] = filtered
                self.save_bucket(bucket, payload)
        append_audit(self.root, audit_event, action_id=action["id"], details={"bucket": target_bucket})
        return target_bucket

    def ingest_actions(
        self,
        actions: list[Any],
        *,
        run_number: int | None = None,
        seen_at: str | None = None,
    ) -> dict[str, int]:
        stats = {"ingested": 0, "duplicates_skipped": 0, "escalated": 0, "new": 0}
        if not actions:
            return stats

        prepared_actions = self._prepare_actions_for_ingest(actions)
        stamp = seen_at or datetime.now().isoformat(timespec="seconds")
        with registry_lock(self.root):
            for action in prepared_actions:
                if action.get("status") in DEDUPABLE_STATUSES:
                    similar = self._find_similar_action(action)
                    if similar is not None:
                        merged = self._merge_similar_action(
                            similar["action"],
                            action,
                            run_number=run_number,
                            seen_at=stamp,
                        )
                        self._upsert_unlocked(merged)
                        stats["duplicates_skipped"] += 1
                        continue

                fresh = deepcopy(action)
                fresh["updated_at"] = stamp
                if run_number is not None:
                    fresh.setdefault("created_run", run_number)
                    fresh["last_seen_run"] = run_number
                    if fresh.get("priority") == "P0":
                        fresh.setdefault("priority_promoted_run", fresh["created_run"])
                self._upsert_unlocked(fresh)
                stats["new"] += 1

            if run_number is not None:
                stats["escalated"] = self._escalate_stale_p0s(run_number, seen_at=stamp)

        stats["ingested"] = stats["new"] + stats["duplicates_skipped"]
        append_audit(self.root, "ingest", details=stats)
        return stats

    def start_action(self, action_id: str) -> dict[str, Any]:
        return self._transition(action_id, status="in_progress", audit_event="start")

    def approve_action(self, action_id: str, *, status: str = "approved") -> dict[str, Any]:
        located = self.get(action_id)
        if not located:
            raise KeyError(action_id)
        action = located["action"]
        action["approval_status"] = status
        action["updated_at"] = datetime.now().isoformat(timespec="seconds")
        self.upsert(action, audit_event="approve")
        return action

    def block_action(self, action_id: str, *, reason: str) -> dict[str, Any]:
        located = self.get(action_id)
        if not located:
            raise KeyError(action_id)
        action = located["action"]
        action["status"] = "blocked"
        action["block_reason"] = reason
        action["updated_at"] = datetime.now().isoformat(timespec="seconds")
        self.upsert(action, audit_event="block")
        return action

    def cancel_action(self, action_id: str, *, reason: str | None = None) -> dict[str, Any]:
        located = self.get(action_id)
        if not located:
            raise KeyError(action_id)
        action = located["action"]
        action["status"] = "cancelled"
        action["updated_at"] = datetime.now().isoformat(timespec="seconds")
        if reason:
            action["result_summary"] = reason
        self.upsert(action, audit_event="cancel")
        return action

    def mark_done(
        self,
        action_id: str,
        *,
        result_summary: str | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any]:
        located = self.get(action_id)
        if not located:
            raise KeyError(action_id)
        action = located["action"]
        stamp = completed_at or datetime.now().isoformat(timespec="seconds")
        action["status"] = "done"
        action["updated_at"] = stamp
        action["completed_at"] = stamp
        if result_summary is not None:
            action["result_summary"] = result_summary
        self.upsert(action, audit_event="done")
        return action

    def validate_bucket(self, bucket: str) -> list[str]:
        payload = self.load_bucket(bucket)
        errors: list[str] = []
        actions = payload.get("actions", [])
        if not isinstance(actions, list):
            return [f"{bucket}: actions must be a list"]
        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                errors.append(f"{bucket}[{index}] must be an object")
                continue
            for error in validate_action(action):
                errors.append(f"{bucket}[{index}] {error}")
        return errors

    def _transition(self, action_id: str, *, status: str, audit_event: str) -> dict[str, Any]:
        located = self.get(action_id)
        if not located:
            raise KeyError(action_id)
        action = located["action"]
        action["status"] = status
        action["updated_at"] = datetime.now().isoformat(timespec="seconds")
        self.upsert(action, audit_event=audit_event)
        return action

    def _upsert_unlocked(self, action: dict[str, Any]) -> str:
        action = normalize_action(deepcopy(action))
        errors = validate_action(action)
        if errors:
            raise ValueError("; ".join(errors))
        target_bucket = bucket_for_status(action["status"])
        for bucket in BUCKETS:
            payload = self.load_bucket(bucket)
            filtered = [item for item in payload.get("actions", []) if item.get("id") != action["id"]]
            if bucket == target_bucket:
                filtered.append(deepcopy(action))
                filtered = self._sort_actions(filtered)
            payload["actions"] = filtered
            self.save_bucket(bucket, payload)
        return target_bucket

    def _find_similar_action(self, candidate: dict[str, Any]) -> dict[str, Any] | None:
        candidate_key = infer_track_key(candidate)
        for bucket in DEDUPE_BUCKETS:
            for action in self.load_bucket(bucket).get("actions", []):
                if action.get("project") == candidate.get("project") and infer_track_key(action) == candidate_key:
                    return {"bucket": bucket, "action": deepcopy(action)}
        for bucket in DEDUPE_BUCKETS:
            for action in self.load_bucket(bucket).get("actions", []):
                if not self._is_same_legacy_scope(action, candidate):
                    continue
                title = action.get("title")
                candidate_title = candidate.get("title")
                if not isinstance(title, str) or not isinstance(candidate_title, str):
                    continue
                if self._title_similarity(title, candidate_title) >= TITLE_SIMILARITY_THRESHOLD:
                    return {"bucket": bucket, "action": deepcopy(action)}
        return None

    def _merge_similar_action(
        self,
        existing: dict[str, Any],
        incoming: dict[str, Any],
        *,
        run_number: int | None,
        seen_at: str,
    ) -> dict[str, Any]:
        merged = deepcopy(existing)
        merged["track_key"] = infer_track_key(incoming) or infer_track_key(existing)
        if incoming.get("action_kind"):
            merged["action_kind"] = incoming["action_kind"]
        merged["status"] = incoming.get("status", merged.get("status"))
        merged["updated_at"] = seen_at
        if run_number is not None:
            merged.setdefault("created_run", existing.get("created_run", run_number))
            merged["last_seen_run"] = run_number

        for field in ("title", "description", "category", "action_type"):
            value = incoming.get(field)
            if isinstance(value, str) and value.strip():
                merged[field] = value

        incoming_criteria = incoming.get("acceptance_criteria")
        if incoming_criteria:
            merged["acceptance_criteria"] = deepcopy(incoming_criteria)

        incoming_dependencies = incoming.get("dependencies")
        if incoming_dependencies:
            merged["dependencies"] = deepcopy(incoming_dependencies)

        old_priority = merged.get("priority", "P3")
        incoming_priority = incoming.get("priority", old_priority)
        if self._priority_rank(incoming_priority) < self._priority_rank(old_priority):
            merged["priority"] = incoming_priority
            if incoming_priority == "P0" and old_priority != "P0" and run_number is not None:
                merged["priority_promoted_run"] = run_number
        elif merged.get("priority") == "P0" and run_number is not None:
            merged.setdefault("priority_promoted_run", merged.get("created_run", run_number))

        if self._risk_rank(incoming.get("risk_level", "low")) > self._risk_rank(merged.get("risk_level", "low")):
            merged["risk_level"] = incoming["risk_level"]

        if incoming.get("approval_required"):
            merged["approval_required"] = True

        incoming_due = incoming.get("next_due")
        if isinstance(incoming_due, str) and incoming_due.strip():
            current_due = merged.get("next_due")
            if not isinstance(current_due, str) or not current_due.strip() or incoming_due < current_due:
                merged["next_due"] = incoming_due

        incoming_evidence = incoming.get("evidence")
        if isinstance(incoming_evidence, list) and incoming_evidence:
            merged["evidence"] = self._merge_unique_evidence(merged.get("evidence", []), incoming_evidence)

        if incoming.get("confidence") is not None:
            merged["confidence"] = incoming["confidence"]
        if incoming.get("confidence_reason"):
            merged["confidence_reason"] = incoming["confidence_reason"]

        return merged

    def _escalate_stale_p0s(self, run_number: int, *, seen_at: str) -> int:
        payload = self.load_bucket("active")
        escalated = 0
        changed = False
        for action in payload.get("actions", []):
            if action.get("status") not in ESCALATION_STATUSES:
                continue
            if action.get("priority") != "P0":
                continue
            stale_since = action.get("priority_promoted_run", action.get("created_run"))
            if not isinstance(stale_since, int):
                continue
            runs_open = run_number - stale_since
            if runs_open < ESCALATION_RUN_LIMIT or action.get("escalated"):
                continue
            action["escalated"] = True
            action["escalated_at"] = seen_at
            action["escalation_note"] = (
                f"Open for {runs_open}+ runs without completion. "
                f"Consider marking blocked or requesting user status."
            )
            action["updated_at"] = seen_at
            escalated += 1
            changed = True

        if changed:
            payload["actions"] = self._sort_actions(payload.get("actions", []))
            self.save_bucket("active", payload)
        return escalated

    @staticmethod
    def _prepare_actions_for_ingest(actions: list[Any]) -> list[dict[str, Any]]:
        prepared: list[dict[str, Any]] = []
        errors: list[str] = []
        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                errors.append(f"actions[{index}] must be an object")
                continue
            item_errors = validate_action(action)
            if item_errors:
                errors.extend(f"actions[{index}] {error}" for error in item_errors)
                continue
            prepared.append(normalize_action(deepcopy(action)))
        if errors:
            raise ValueError("; ".join(errors))
        return prepared

    @staticmethod
    def _is_same_legacy_scope(existing: dict[str, Any], candidate: dict[str, Any]) -> bool:
        return all(
            existing.get(field) == candidate.get(field)
            for field in ("project", "source_system", "source_area")
        )

    @staticmethod
    def _title_similarity(a: str, b: str) -> float:
        return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()

    @staticmethod
    def _priority_rank(value: str) -> int:
        return PRIORITY_ORDER.get(value, 99)

    @staticmethod
    def _risk_rank(value: str) -> int:
        return RISK_ORDER.get(value, -1)

    @staticmethod
    def _merge_unique_evidence(
        existing: list[dict[str, Any]] | Any,
        incoming: list[dict[str, Any]] | Any,
    ) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in list(existing or []) + list(incoming or []):
            if not isinstance(item, dict):
                continue
            key = json.dumps(item, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            merged.append(deepcopy(item))
        return merged

    @staticmethod
    def _sort_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        def sort_key(item: dict[str, Any]) -> tuple[int, int, str, str]:
            priority_rank = PRIORITY_ORDER.get(item.get("priority", "P3"), 99)
            due = item.get("next_due")
            due_rank = 0 if isinstance(due, str) and due.strip() else 1
            due_text = due or ""
            return priority_rank, due_rank, due_text, item.get("id", "")

        return sorted(actions, key=sort_key)