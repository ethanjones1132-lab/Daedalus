from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

from action_registry.briefing import build_brief, rank_executable, select_next
from action_registry.cli import main
from action_registry.store import RegistryStore


class BriefingTests(unittest.TestCase):
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

    def sample(self, **overrides):
        action = {
            "id": "demo-001",
            "project": "home-base",
            "track_key": "home-base:jarvis",
            "source_system": "tests",
            "source_area": "jarvis",
            "action_kind": "task",
            "priority": "P0",
            "risk_level": "medium",
            "category": "execution_required",
            "action_type": "execution_required",
            "title": "Exercise the registry store",
            "description": "Synthetic action",
            "acceptance_criteria": ["Validates"],
            "dependencies": [],
            "status": "open",
            "owner": "shared",
            "approval_required": False,
            "created_at": "2026-06-16T10:00:00",
            "updated_at": "2026-06-16T10:00:00",
        }
        action.update(overrides)
        return action

    def clear_actions(self) -> None:
        for bucket in ("active", "blocked", "done"):
            (self.root / "data" / f"{bucket}.json").write_text(
                json.dumps({"bucket": bucket, "version": 1, "actions": []}, indent=2) + "\n",
                encoding="utf-8",
            )

    def test_select_next_prefers_p0(self):
        self.store.upsert(self.sample(id="p1", priority="P1", track_key="home-base:b"))
        self.store.upsert(self.sample(id="p0", priority="P0", track_key="home-base:a"))
        nxt = select_next(self.store)
        self.assertEqual(nxt["id"], "p0")

    def test_open_dependency_prevents_p0_selection(self):
        self.store.upsert(
            self.sample(
                id="dependent",
                priority="P0",
                dependencies=["dependency"],
                track_key="home-base:dependent",
            )
        )
        self.store.upsert(self.sample(id="dependency", priority="P1", track_key="home-base:dependency"))

        self.assertEqual(select_next(self.store)["id"], "dependency")
        self.assertEqual(
            {action["id"] for action in self.store.list_actions(bucket="active")},
            {"dependent", "dependency"},
        )

    def test_done_dependency_unlocks_p0_selection(self):
        self.store.upsert(
            self.sample(
                id="dependent",
                priority="P0",
                dependencies=["dependency"],
                track_key="home-base:dependent",
            )
        )
        self.store.upsert(
            self.sample(
                id="dependency",
                priority="P1",
                status="done",
                track_key="home-base:dependency",
            )
        )

        self.assertEqual(select_next(self.store)["id"], "dependent")

    def test_missing_blocked_and_cancelled_dependencies_fail_closed(self):
        cases = {
            "missing": ["not-present"],
            "blocked": ["blocked-dependency"],
            "cancelled": ["cancelled-dependency"],
        }
        for case, dependencies in cases.items():
            with self.subTest(case=case):
                self.clear_actions()
                self.store.upsert(
                    self.sample(
                        id=f"dependent-{case}",
                        dependencies=dependencies,
                        track_key=f"home-base:dependent-{case}",
                    )
                )
                if case == "blocked":
                    self.store.upsert(
                        self.sample(
                            id="blocked-dependency",
                            status="blocked",
                            track_key="home-base:blocked-dependency",
                        )
                    )
                elif case == "cancelled":
                    self.store.upsert(
                        self.sample(
                            id="cancelled-dependency",
                            status="cancelled",
                            track_key="home-base:cancelled-dependency",
                        )
                    )

                self.assertIsNone(select_next(self.store))

    def test_self_referential_and_cyclic_dependencies_fail_closed(self):
        self.store.upsert(
            self.sample(
                id="self",
                dependencies=["self"],
                track_key="home-base:self",
            )
        )
        self.assertIsNone(select_next(self.store))

        self.clear_actions()
        self.store.upsert(
            self.sample(
                id="cycle-a",
                dependencies=["cycle-b"],
                track_key="home-base:cycle-a",
            )
        )
        self.store.upsert(
            self.sample(
                id="cycle-b",
                dependencies=["cycle-a"],
                track_key="home-base:cycle-b",
            )
        )
        self.assertEqual(
            {action["id"] for action in self.store.list_actions(bucket="active")},
            {"cycle-a", "cycle-b"},
        )
        self.assertIsNone(select_next(self.store))

        self.clear_actions()
        self.store.upsert(
            self.sample(
                id="dependent",
                dependencies=["done-cycle-a"],
                track_key="home-base:dependent",
            )
        )
        self.store.upsert(
            self.sample(
                id="done-cycle-a",
                dependencies=["done-cycle-b"],
                status="done",
                track_key="home-base:done-cycle-a",
            )
        )
        self.store.upsert(
            self.sample(
                id="done-cycle-b",
                dependencies=["done-cycle-a"],
                status="done",
                track_key="home-base:done-cycle-b",
            )
        )
        self.assertIsNone(select_next(self.store))

    def test_dependency_gating_preserves_approval_and_ranking_order(self):
        self.store.upsert(
            self.sample(
                id="blocked-approval",
                priority="P0",
                approval_required=True,
                track_key="home-base:blocked-approval",
            )
        )
        self.store.upsert(
            self.sample(
                id="p1",
                priority="P1",
                next_due="2026-06-20T10:00:00",
                confidence=0.4,
                track_key="home-base:p1",
            )
        )
        self.store.upsert(
            self.sample(
                id="p2",
                priority="P2",
                next_due="2026-06-19T10:00:00",
                confidence=0.9,
                track_key="home-base:p2",
            )
        )
        self.assertEqual(select_next(self.store)["id"], "p1")

    def test_dependency_gating_preserves_due_and_confidence_order(self):
        self.store.upsert(
            self.sample(
                id="later-due",
                priority="P1",
                next_due="2026-06-20T10:00:00",
                confidence=0.9,
                track_key="home-base:later-due",
            )
        )
        self.store.upsert(
            self.sample(
                id="earlier-due",
                priority="P1",
                next_due="2026-06-19T10:00:00",
                confidence=0.1,
                track_key="home-base:earlier-due",
            )
        )
        self.store.upsert(
            self.sample(
                id="higher-confidence",
                priority="P1",
                next_due="2026-06-19T10:00:00",
                confidence=0.9,
                track_key="home-base:higher-confidence",
            )
        )
        self.store.upsert(
            self.sample(
                id="no-due",
                priority="P1",
                confidence=1.0,
                track_key="home-base:no-due",
            )
        )
        self.assertEqual(
            [action["id"] for action in rank_executable(self.store.list_actions(bucket="active"), self.store.all_actions())],
            ["higher-confidence", "later-due", "earlier-due", "no-due"],
        )

    def test_brief_and_cli_next_share_dependency_selection(self):
        self.store.upsert(
            self.sample(
                id="dependent",
                priority="P0",
                dependencies=["dependency"],
                track_key="home-base:dependent",
            )
        )
        self.store.upsert(self.sample(id="dependency", priority="P1", track_key="home-base:dependency"))

        brief = build_brief(self.store)
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            return_code = main(["--root", str(self.root), "next"])
        payload = json.loads(stdout.getvalue())

        self.assertEqual(return_code, 0)
        self.assertEqual(brief["selection"], payload["selection"])
        self.assertEqual(brief["selection"]["id"], "dependency")
        self.assertTrue(brief["selection"]["reason"])

    def test_build_brief_includes_counts(self):
        self.store.upsert(self.sample())
        brief = build_brief(self.store)
        self.assertEqual(brief["summary"]["active"], 1)
        self.assertIsNotNone(brief["next"])


if __name__ == "__main__":
    unittest.main()