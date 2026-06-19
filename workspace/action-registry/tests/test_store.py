from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

from action_registry.cli import main
from action_registry.models import validate_action
from action_registry.store import RegistryStore


class RegistryStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        data_dir = self.root / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        for bucket in ("active", "blocked", "done"):
            (data_dir / f"{bucket}.json").write_text(
                json.dumps({"bucket": bucket, "version": 1, "actions": []}, indent=2) + "\n",
                encoding="utf-8",
            )
        self.store = RegistryStore(self.root)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def sample_action(self, **overrides):
        action = {
            "id": "demo-001",
            "project": "home-base",
            "source_system": "tests",
            "source_area": "unit",
            "priority": "P1",
            "risk_level": "medium",
            "category": "execution_required",
            "action_type": "execution_required",
            "title": "Exercise the registry store",
            "description": "A synthetic test action used to verify bucket movement.",
            "acceptance_criteria": ["The action validates correctly"],
            "dependencies": [],
            "status": "open",
            "owner": "shared",
            "approval_required": False,
            "next_due": "2026-06-17T12:00:00",
            "created_at": "2026-06-16T10:00:00",
            "updated_at": "2026-06-16T10:00:00",
            "evidence": [{"kind": "test", "value": "synthetic"}],
        }
        action.update(overrides)
        return action

    def load_bucket(self, bucket: str):
        return json.loads((self.root / "data" / f"{bucket}.json").read_text(encoding="utf-8"))

    def find_action(self, bucket: str, action_id: str):
        for action in self.load_bucket(bucket)["actions"]:
            if action["id"] == action_id:
                return action
        self.fail(f"action {action_id!r} not found in {bucket}")

    def test_upsert_places_open_actions_in_active_bucket(self):
        self.store.upsert(self.sample_action())
        self.assertEqual(len(self.load_bucket("active")["actions"]), 1)
        self.assertEqual(self.load_bucket("done")["actions"], [])

    def test_blocked_status_routes_to_blocked_bucket(self):
        self.store.upsert(self.sample_action(status="blocked"))
        self.assertEqual(len(self.load_bucket("blocked")["actions"]), 1)
        self.assertEqual(self.load_bucket("active")["actions"], [])

    def test_mark_done_moves_action_to_done_bucket(self):
        self.store.upsert(self.sample_action())
        action = self.store.mark_done(
            "demo-001",
            result_summary="Verified in unit test",
            completed_at="2026-06-16T11:00:00",
        )
        self.assertEqual(action["status"], "done")
        self.assertEqual(len(self.load_bucket("done")["actions"]), 1)
        self.assertEqual(self.load_bucket("active")["actions"], [])
        self.assertEqual(self.load_bucket("done")["actions"][0]["result_summary"], "Verified in unit test")

    def test_validate_action_rejects_missing_fields(self):
        errors = validate_action({"id": "broken"})
        self.assertTrue(errors)
        self.assertIn("missing required fields", errors[0])

    def test_ingest_actions_deduplicates_similar_titles_in_same_source(self):
        self.store.upsert(
            self.sample_action(
                title="Review billing anomalies",
                created_run=1,
                last_seen_run=1,
            )
        )

        stats = self.store.ingest_actions(
            [
                self.sample_action(
                    id="demo-002",
                    title="Review billing anomaly",
                    priority="P0",
                    acceptance_criteria=["Use the refreshed criteria"],
                )
            ],
            run_number=1,
            seen_at="2026-06-16T12:00:00",
        )

        self.assertEqual(stats, {"ingested": 1, "duplicates_skipped": 1, "escalated": 0, "new": 0})
        self.assertEqual(len(self.load_bucket("active")["actions"]), 1)
        merged = self.find_action("active", "demo-001")
        self.assertEqual(merged["priority"], "P0")
        self.assertEqual(merged["acceptance_criteria"], ["Use the refreshed criteria"])
        self.assertEqual(merged["last_seen_run"], 1)
        self.assertEqual(merged["updated_at"], "2026-06-16T12:00:00")

    def test_ingest_actions_moves_duplicate_into_blocked_bucket_when_status_changes(self):
        self.store.upsert(
            self.sample_action(
                title="Fix stale binary before release",
                created_run=1,
                last_seen_run=1,
            )
        )

        stats = self.store.ingest_actions(
            [
                self.sample_action(
                    id="demo-002",
                    title="Fix stale binaries before release",
                    status="blocked",
                )
            ],
            run_number=2,
            seen_at="2026-06-17T12:00:00",
        )

        self.assertEqual(stats, {"ingested": 1, "duplicates_skipped": 1, "escalated": 0, "new": 0})
        self.assertEqual(self.load_bucket("active")["actions"], [])
        blocked = self.find_action("blocked", "demo-001")
        self.assertEqual(blocked["status"], "blocked")
        self.assertEqual(blocked["updated_at"], "2026-06-17T12:00:00")

    def test_ingest_actions_escalates_stale_p0_actions(self):
        self.store.upsert(
            self.sample_action(
                id="demo-p0",
                title="Fix the release gate",
                priority="P0",
                created_run=1,
                last_seen_run=1,
                priority_promoted_run=1,
            )
        )

        stats = self.store.ingest_actions(
            [
                self.sample_action(
                    id="demo-002",
                    title="Check a different queue",
                    source_area="other",
                )
            ],
            run_number=3,
            seen_at="2026-06-18T09:30:00",
        )

        self.assertEqual(stats, {"ingested": 1, "duplicates_skipped": 0, "escalated": 1, "new": 1})
        escalated = self.find_action("active", "demo-p0")
        self.assertTrue(escalated["escalated"])
        self.assertEqual(escalated["escalated_at"], "2026-06-18T09:30:00")
        self.assertIn("Open for 2+ runs without completion", escalated["escalation_note"])

    def test_ingest_actions_does_not_immediately_escalate_newly_promoted_p0(self):
        self.store.upsert(
            self.sample_action(
                id="demo-promo",
                title="Fix the release gate",
                priority="P1",
                created_run=1,
                last_seen_run=1,
            )
        )

        stats = self.store.ingest_actions(
            [
                self.sample_action(
                    id="demo-002",
                    title="Fix the release gates",
                    priority="P0",
                )
            ],
            run_number=3,
            seen_at="2026-06-18T09:30:00",
        )

        self.assertEqual(stats, {"ingested": 1, "duplicates_skipped": 1, "escalated": 0, "new": 0})
        promoted = self.find_action("active", "demo-promo")
        self.assertEqual(promoted["priority"], "P0")
        self.assertEqual(promoted["priority_promoted_run"], 3)
        self.assertFalse(promoted.get("escalated", False))

    def test_ingest_actions_prevalidates_batch_before_mutating_buckets(self):
        with self.assertRaises(ValueError):
            self.store.ingest_actions(
                [self.sample_action(id="good"), {"id": "broken"}],
                run_number=1,
                seen_at="2026-06-16T12:00:00",
            )

        self.assertEqual(self.load_bucket("active")["actions"], [])
        self.assertEqual(self.load_bucket("blocked")["actions"], [])
        self.assertEqual(self.load_bucket("done")["actions"], [])

    def test_cli_ingest_rejects_non_object_items_with_json_error(self):
        bad_file = self.root / "bad.actions.json"
        bad_file.write_text(json.dumps([123], indent=2) + "\n", encoding="utf-8")

        stdout = io.StringIO()
        with redirect_stdout(stdout):
            rc = main(["--root", str(self.root), "ingest", str(bad_file)])

        payload = json.loads(stdout.getvalue())
        self.assertEqual(rc, 1)
        self.assertEqual(payload["ok"], False)
        self.assertIn("actions[0] must be an object", payload["errors"][0])


if __name__ == "__main__":
    unittest.main()
