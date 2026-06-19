from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from action_registry.adapters import collect_all, default_context
from action_registry.adapters.jarvis import JarvisAdapter
from action_registry.adapters.jonesinsrc_products import JonesinSrcProductsAdapter
from action_registry.approval import can_execute, pending_approval_actions
from action_registry.notifications import build_alerts
from action_registry.sync import sync_registry


class AdapterTests(unittest.TestCase):
    def test_jarvis_adapter_emits_platform_action(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("# priorities\n", encoding="utf-8")
            ctx = default_context(root)
            ctx.home_base_root = str(root)
            actions = JarvisAdapter().collect(ctx)
            self.assertTrue(any(action["project"] == "home-base" for action in actions))

    def test_product_adapter_emits_three_products(self):
        actions = JonesinSrcProductsAdapter().collect(default_context())
        slugs = {action["source_area"] for action in actions}
        self.assertEqual(slugs, {"wallslayer", "prizepicks-monster", "kalshi-monster"})

    def test_collect_all_returns_valid_actions(self):
        actions = collect_all()
        self.assertGreaterEqual(len(actions), 5)
        for action in actions:
            self.assertIn("id", action)
            self.assertIn("title", action)

    def test_sync_registry_writes_notifications(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            data_dir = root / "data"
            data_dir.mkdir(parents=True)
            for bucket in ("active", "blocked", "done"):
                (data_dir / f"{bucket}.json").write_text(
                    json.dumps({"bucket": bucket, "version": 1, "actions": []}, indent=2) + "\n",
                    encoding="utf-8",
                )
            result = sync_registry(root)
            self.assertTrue(result["ingest"]["ingested"] >= 1)
            self.assertTrue((root / "data" / "notifications.json").exists())
            self.assertTrue((root / "data" / "sync-state.json").exists())

    def test_approval_gate_blocks_execution(self):
        action = {
            "id": "demo",
            "status": "open",
            "approval_required": True,
        }
        allowed, reason = can_execute(action)
        self.assertFalse(allowed)
        self.assertEqual(reason, "approval required before execution")
        self.assertEqual(len(pending_approval_actions([action])), 1)

    def test_build_alerts_includes_blocked_summary(self):
        alerts = build_alerts({"active": 1, "blocked": 2, "done": 0}, {"active": [], "blocked": [], "done": []})
        kinds = {alert["kind"] for alert in alerts}
        self.assertIn("blocked_summary", kinds)


if __name__ == "__main__":
    unittest.main()