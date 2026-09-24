from __future__ import annotations

import json
import os
import unittest
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from action_registry.adapters import default_context
from action_registry.adapters.jarvis import JarvisAdapter
from action_registry.adapters.jonesinsrc_products import JonesinSrcProductsAdapter
from action_registry.store import RegistryStore
from action_registry.sync import sync_registry


class IdentityContractTests(unittest.TestCase):
    def make_registry_root(self, root: Path) -> None:
        data_dir = root / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        for bucket in ("active", "blocked", "done"):
            (data_dir / f"{bucket}.json").write_text(
                json.dumps({"bucket": bucket, "version": 1, "actions": []}, indent=2) + "\n",
                encoding="utf-8",
            )

    def sample_action(self, **overrides):
        action = {
            "id": "demo-001",
            "project": "home-base",
            "source_system": "tests",
            "source_area": "unit",
            "track_key": "home-base:unit",
            "action_kind": "task",
            "priority": "P1",
            "risk_level": "medium",
            "category": "execution_required",
            "action_type": "execution_required",
            "title": "Shared surface title",
            "description": "A synthetic action used to verify identity boundaries.",
            "acceptance_criteria": ["The action validates correctly"],
            "dependencies": [],
            "status": "open",
            "owner": "shared",
            "approval_required": False,
            "created_at": "2026-06-16T10:00:00",
            "updated_at": "2026-06-16T10:00:00",
            "evidence": [{"kind": "test", "value": "synthetic"}],
        }
        action.update(overrides)
        return action

    def test_jarvis_signals_and_platform_track_have_distinct_identities(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root / "target" / "x86_64-pc-windows-gnu" / "release" / "home-base.exe"
            binary.parent.mkdir(parents=True)
            binary.write_text("binary\n", encoding="utf-8")
            source = root / "src-ui" / "src" / "App.tsx"
            source.parent.mkdir(parents=True)
            source.write_text("new source\n", encoding="utf-8")
            (root / "AGENTS.md").write_text("# priorities\n", encoding="utf-8")
            os.utime(binary, (100, 100))
            os.utime(source, (200, 200))

            ctx = default_context(root)
            ctx.home_base_root = str(root)
            ctx.now = datetime(2026, 6, 21, 12, 0, 0)
            actions = JarvisAdapter().collect(ctx)
            by_type = {action["action_type"]: action for action in actions}

            self.assertEqual(
                {
                    action_type: (action["track_key"], action["action_kind"])
                    for action_type, action in by_type.items()
                },
                {
                    "release_guard": ("home-base:stale-binary", "signal"),
                    "verification_task": ("home-base:eval-harness", "signal"),
                    "project_track": ("home-base:jarvis", "track"),
                },
            )
            self.assertEqual({action["track_key"] for action in actions}, {
                "home-base:stale-binary",
                "home-base:eval-harness",
                "home-base:jarvis",
            })
            self.assertEqual({action["id"] for action in actions}, {
                "home-base-stale-binary-signal-20260621",
                "home-base-eval-harness-signal-20260621",
                "home-base-platform-track-20260621",
            })
            self.assertTrue(by_type["release_guard"]["approval_required"])
            self.assertEqual({action["source_area"] for action in actions}, {"jarvis"})

    def test_product_adapter_emits_explicit_tracks(self):
        actions = JonesinSrcProductsAdapter().collect(default_context())
        self.assertEqual({action["source_area"] for action in actions}, {
            "wallslayer",
            "prizepicks-monster",
            "kalshi-monster",
        })
        self.assertEqual(
            {action["track_key"] for action in actions},
            {"jonesinsrc:wallslayer", "jonesinsrc:prizepicks-monster", "jonesinsrc:kalshi-monster"},
        )
        self.assertTrue(all(action["action_kind"] == "track" for action in actions))

    def test_product_tracks_keep_identity_through_repeated_ingest(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_registry_root(root)
            store = RegistryStore(root)
            ctx = default_context(root)
            ctx.now = datetime(2026, 6, 21, 12, 0, 0)
            actions = JonesinSrcProductsAdapter().collect(ctx)
            first = store.ingest_actions(actions, run_number=1, seen_at="2026-06-16T12:00:00")
            second = store.ingest_actions(actions, run_number=2, seen_at="2026-06-17T12:00:00")

            self.assertEqual(first["new"], 3)
            self.assertEqual(second["duplicates_skipped"], 3)
            stored = store.list_actions(bucket="active")
            self.assertEqual(len(stored), 3)
            self.assertEqual(
                {(action["id"], action["track_key"], action["action_kind"]) for action in stored},
                {
                    ("jonesinsrc-wallslayer-20260621", "jonesinsrc:wallslayer", "track"),
                    ("jonesinsrc-prizepicks-monster-20260621", "jonesinsrc:prizepicks-monster", "track"),
                    ("jonesinsrc-kalshi-monster-20260621", "jonesinsrc:kalshi-monster", "track"),
                },
            )

    def test_explicit_keys_do_not_merge_by_legacy_scope_and_title(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_registry_root(root)
            store = RegistryStore(root)
            actions = [
                self.sample_action(
                    id="track-001",
                    track_key="home-base:platform",
                    action_kind="track",
                    source_system="tests",
                    source_area="jarvis",
                    title="Shared surface title",
                ),
                self.sample_action(
                    id="signal-001",
                    track_key="home-base:stale-binary",
                    action_kind="signal",
                    source_system="tests",
                    source_area="jarvis",
                    title="Shared surface title",
                    priority="P0",
                    approval_required=True,
                    approval_status="approved",
                    evidence=[{"kind": "first", "value": "one"}],
                ),
                self.sample_action(
                    id="signal-002",
                    track_key="home-base:eval-harness",
                    action_kind="signal",
                    source_system="tests",
                    source_area="jarvis",
                    title="Shared surface title",
                    evidence=[{"kind": "other", "value": "two"}],
                ),
            ]

            stats = store.ingest_actions(actions, run_number=4, seen_at="2026-06-16T12:00:00")
            self.assertEqual(stats["new"], 3)
            self.assertEqual(stats["duplicates_skipped"], 0)
            self.assertEqual(store.summary()["active"], 3)
            self.assertEqual(
                {action["track_key"] for action in store.list_actions(bucket="active")},
                {"home-base:platform", "home-base:stale-binary", "home-base:eval-harness"},
            )

            refreshed_signal = deepcopy(actions[1])
            refreshed_signal["acceptance_criteria"] = ["Refreshed criteria"]
            refreshed_signal["evidence"] = [{"kind": "second", "value": "two"}]
            second_stats = store.ingest_actions(
                [refreshed_signal], run_number=5, seen_at="2026-06-17T12:00:00"
            )
            self.assertEqual(second_stats["duplicates_skipped"], 1)
            signal = store.get("signal-001")["action"]
            self.assertEqual(signal["track_key"], "home-base:stale-binary")
            self.assertEqual(signal["action_kind"], "signal")
            self.assertEqual(signal["created_run"], 4)
            self.assertEqual(signal["last_seen_run"], 5)
            self.assertEqual(signal["priority_promoted_run"], 4)
            self.assertTrue(signal["approval_required"])
            self.assertEqual(signal["approval_status"], "approved")
            self.assertEqual(signal["acceptance_criteria"], ["Refreshed criteria"])
            self.assertEqual(
                signal["evidence"],
                [{"kind": "first", "value": "one"}, {"kind": "second", "value": "two"}],
            )

    def test_ingest_rejects_batch_id_collisions_before_writing(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_registry_root(root)
            store = RegistryStore(root)
            actions = [
                self.sample_action(id="duplicate-001", track_key="home-base:one"),
                self.sample_action(id="duplicate-001", track_key="home-base:two"),
            ]

            with self.assertRaises(ValueError):
                store.ingest_actions(actions, run_number=1, seen_at="2026-06-16T12:00:00")

            self.assertEqual(store.summary(), {"active": 0, "blocked": 0, "done": 0})

    def test_reusing_a_physical_id_for_another_track_is_rejected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_registry_root(root)
            store = RegistryStore(root)
            original = self.sample_action(id="stable-001", track_key="home-base:one")
            store.upsert(original)

            with self.assertRaises(ValueError):
                store.upsert(self.sample_action(id="stable-001", track_key="home-base:two"))

            self.assertEqual(store.get("stable-001")["action"]["track_key"], "home-base:one")

    def test_distinct_signals_keep_independent_lifecycles(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_registry_root(root)
            store = RegistryStore(root)
            platform = self.sample_action(
                id="platform-001",
                track_key="home-base:jarvis",
                action_kind="track",
                source_area="jarvis",
            )
            stale = self.sample_action(
                id="signal-stale",
                track_key="home-base:stale-binary",
                action_kind="signal",
                source_area="jarvis",
                last_seen_run=1,
            )
            eval_signal = self.sample_action(
                id="signal-eval",
                track_key="home-base:eval-harness",
                action_kind="signal",
                source_area="jarvis",
                last_seen_run=1,
            )
            for action in (platform, stale, eval_signal):
                store.upsert(action)
            (root / "data" / "sync-state.json").write_text(
                json.dumps({"last_run_number": 1, "last_run_at": "2026-06-16T10:00:00", "last_stats": {}}) + "\n",
                encoding="utf-8",
            )

            with patch("action_registry.sync.collect_all", return_value=[platform]):
                first_result = sync_registry(root)
            self.assertEqual(first_result["ingest"]["resolved_signals"], 0)
            self.assertEqual(len(RegistryStore(root).list_actions(bucket="active")), 3)

            with patch("action_registry.sync.collect_all", return_value=[platform]):
                second_result = sync_registry(root)
            self.assertEqual(second_result["ingest"]["resolved_signals"], 2)
            active = RegistryStore(root).list_actions(bucket="active")
            done = RegistryStore(root).list_actions(bucket="done")
            self.assertEqual([action["id"] for action in active], ["platform-001"])
            self.assertEqual({action["id"] for action in done}, {"signal-stale", "signal-eval"})

    def test_sync_repairs_collapsed_legacy_row_without_manual_data_edit(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_registry_root(root)
            legacy_id = "home-base-eval-harness-20260621"
            legacy = self.sample_action(
                id=legacy_id,
                project="home-base",
                source_system="jarvis-adapter",
                source_area="jarvis",
                track_key="home-base:jarvis",
                action_kind="task",
                category="project_registry",
                action_type="project_track",
                title="Jarvis platform follow-through",
                description="AGENTS.md lists active platform priorities.",
                acceptance_criteria=["Platform priorities are represented"],
                created_run=3,
                last_seen_run=4,
                evidence=[{"kind": "legacy", "value": "preserved"}],
            )
            (root / "data" / "active.json").write_text(
                json.dumps({"bucket": "active", "version": 1, "actions": [legacy]}, indent=2) + "\n",
                encoding="utf-8",
            )
            (root / "data" / "sync-state.json").write_text(
                json.dumps({"last_run_number": 4, "last_run_at": "2026-06-21T14:39:45", "last_stats": {}}) + "\n",
                encoding="utf-8",
            )
            binary = root / "target" / "x86_64-pc-windows-gnu" / "release" / "home-base.exe"
            binary.parent.mkdir(parents=True)
            binary.write_text("binary\n", encoding="utf-8")
            source = root / "src-ui" / "src" / "App.tsx"
            source.parent.mkdir(parents=True)
            source.write_text("new source\n", encoding="utf-8")
            (root / "AGENTS.md").write_text("# priorities\n", encoding="utf-8")
            os.utime(binary, (100, 100))
            os.utime(source, (200, 200))

            ctx = default_context(root)
            ctx.home_base_root = str(root)
            ctx.now = datetime(2026, 6, 21, 12, 0, 0)
            actions = JarvisAdapter().collect(ctx)
            with patch("action_registry.sync.collect_all", return_value=actions):
                result = sync_registry(root)

            store = RegistryStore(root)
            active = store.list_actions(bucket="active")
            by_key = {action["track_key"]: action for action in active}
            self.assertEqual(result["ingest"]["new"], 2)
            self.assertEqual(
                set(by_key),
                {"home-base:jarvis", "home-base:stale-binary", "home-base:eval-harness"},
            )

            repaired = store.get(legacy_id)["action"]
            self.assertEqual(repaired["track_key"], "home-base:jarvis")
            self.assertEqual(repaired["action_kind"], "track")
            self.assertEqual(repaired["title"], "Jarvis platform follow-through")
            self.assertEqual(repaired["created_run"], 3)
            self.assertEqual(repaired["last_seen_run"], 5)
            self.assertIn({"kind": "legacy", "value": "preserved"}, repaired["evidence"])

            stale = by_key["home-base:stale-binary"]
            eval_signal = by_key["home-base:eval-harness"]
            self.assertNotEqual(stale["id"], legacy_id)
            self.assertNotEqual(eval_signal["id"], legacy_id)
            self.assertEqual(stale["action_kind"], "signal")
            self.assertEqual(eval_signal["action_kind"], "signal")
            self.assertEqual(stale["priority"], "P0")
            self.assertTrue(stale["approval_required"])
            self.assertEqual(stale["created_run"], 5)
            self.assertEqual(stale["priority_promoted_run"], 5)

            ids = {action["id"] for action in active}
            with patch("action_registry.sync.collect_all", return_value=actions):
                second_result = sync_registry(root)
            second_active = RegistryStore(root).list_actions(bucket="active")
            self.assertEqual(second_result["ingest"]["new"], 0)
            self.assertEqual({action["id"] for action in second_active}, ids)
            self.assertEqual(len(second_active), 3)
            self.assertEqual(
                RegistryStore(root).get(legacy_id)["action"]["last_seen_run"],
                6,
            )


if __name__ == "__main__":
    unittest.main()
