from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from action_registry.dedupe import run_dedupe
from action_registry.store import RegistryStore


class DedupeTests(unittest.TestCase):
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

    def base(self, **overrides):
        action = {
            "id": "keep",
            "project": "jonesinsrc",
            "track_key": "jonesinsrc:wallslayer",
            "source_system": "a",
            "source_area": "wallslayer",
            "action_kind": "track",
            "priority": "P1",
            "risk_level": "medium",
            "category": "product_registry",
            "action_type": "product_track",
            "title": "WallSlayer product track",
            "description": "One",
            "acceptance_criteria": ["A"],
            "dependencies": [],
            "status": "open",
            "owner": "shared",
            "approval_required": False,
            "created_at": "2026-06-16T10:00:00",
            "updated_at": "2026-06-16T10:00:00",
        }
        action.update(overrides)
        return action

    def test_dedupe_merges_same_track_key(self):
        self.store.upsert(self.base(id="keep"))
        self.store.upsert(self.base(id="dup", source_system="b", title="WallSlayer zero-sales funnel diagnostic"))
        result = run_dedupe(self.store)
        self.assertEqual(result["groups"], 1)
        self.assertEqual(self.store.summary()["active"], 1)


if __name__ == "__main__":
    unittest.main()