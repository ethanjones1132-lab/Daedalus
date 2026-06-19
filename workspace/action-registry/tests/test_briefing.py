from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from action_registry.briefing import build_brief, select_next
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

    def test_select_next_prefers_p0(self):
        self.store.upsert(self.sample(id="p1", priority="P1", track_key="home-base:b"))
        self.store.upsert(self.sample(id="p0", priority="P0", track_key="home-base:a"))
        nxt = select_next(self.store)
        self.assertEqual(nxt["id"], "p0")

    def test_build_brief_includes_counts(self):
        self.store.upsert(self.sample())
        brief = build_brief(self.store)
        self.assertEqual(brief["summary"]["active"], 1)
        self.assertIsNotNone(brief["next"])


if __name__ == "__main__":
    unittest.main()