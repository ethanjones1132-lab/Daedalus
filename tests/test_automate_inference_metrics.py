import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from automate_inference_metrics import _model_policy, collect_metrics, get_default_db_path


SCHEMA = """
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, session_id TEXT, user_request TEXT, task_type TEXT,
  pipeline TEXT, completed INTEGER, final_output TEXT, user_rating INTEGER,
  duration_ms INTEGER, tool_calls_count INTEGER, token_count INTEGER,
  created_at TEXT, outcome TEXT
);
CREATE TABLE stage_runs (
  id TEXT PRIMARY KEY, agent_run_id TEXT, mode_id TEXT, turn_number INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, tool_calls_json TEXT,
  duration_ms INTEGER, was_successful INTEGER, had_error INTEGER,
  error_message TEXT, created_at TEXT
);
CREATE TABLE model_attributions (
  id TEXT PRIMARY KEY, agent_run_id TEXT, stage_id TEXT, agent_id TEXT,
  provider TEXT, model_id TEXT, was_successful INTEGER, had_error INTEGER,
  duration_ms INTEGER, first_token_ms INTEGER, fallback_used INTEGER,
  created_at TEXT
);
CREATE TABLE tuning_proposals (
  id TEXT PRIMARY KEY, agent_run_id TEXT, proposal_type TEXT, task_type TEXT,
  current_value TEXT, proposed_value TEXT, rationale TEXT, applied INTEGER,
  created_at TEXT
);
"""


class InferenceMetricsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "self-tuning.db"
        conn = sqlite3.connect(self.db_path)
        conn.executescript(SCHEMA)
        created_at = "2026-07-09T12:00:00.000Z"
        for i, (duration, first_token, success) in enumerate(
            zip((10_000, 20_000, 30_000, 40_000, 50_000),
                (5_000, 10_000, 15_000, 20_000, 25_000),
                (1, 1, 1, 1, 0)),
            start=1,
        ):
            run_id = f"run_{i}"
            conn.execute(
                "INSERT INTO agent_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, "session", "question", "general", '["synthesizer"]', 1,
                 "answer", None, duration, 0, 100, created_at, "success" if success else "failed"),
            )
            conn.execute(
                "INSERT INTO stage_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"stage_{i}", run_id, "synthesizer", 1, 50, 50, "[]", duration,
                 success, 1 - success, None if success else "timeout", created_at),
            )
            conn.execute(
                "INSERT INTO model_attributions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"attr_{i}", run_id, "synthesizer", "slow-agent", "openrouter",
                 "slow-model", success, 1 - success, duration, first_token, i == 5, created_at),
            )
        conn.execute(
            "INSERT INTO tuning_proposals VALUES (?,?,?,?,?,?,?,?,?)",
            ("proposal", "run_1", "model_routing", "general", "a", "b", "test", 0, created_at),
        )
        conn.commit()
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_path_targets_live_self_tuning_database(self):
        self.assertEqual(
            get_default_db_path(Path("C:/Users/test")),
            Path("C:/Users/test/.openclaw/jarvis/self-tuning.db"),
        )

    def test_collect_metrics_uses_real_schema_and_emits_empirical_policy(self):
        report = collect_metrics(
            self.db_path,
            days=7,
            now=datetime(2026, 7, 10, tzinfo=timezone.utc),
            min_samples=5,
        )

        self.assertEqual(report["schema_version"], 1)
        self.assertEqual(report["totals"], {
            "agent_runs": 5,
            "stage_runs": 5,
            "model_attributions": 5,
            "tuning_proposals": 1,
        })
        self.assertEqual(report["run_latency_ms"]["p95"], 48_000)
        self.assertEqual(report["stages"]["synthesizer"]["p95_duration_ms"], 48_000)
        model = report["models"]["openrouter:slow-model"]
        self.assertEqual(model["sample_count"], 5)
        self.assertEqual(model["success_rate"], 0.8)
        self.assertEqual(model["p95_duration_ms"], 48_000)
        self.assertEqual(model["p95_first_token_ms"], 24_000)
        self.assertEqual(model["fallback_rate"], 0.2)
        policy = report["routing_policy"]["model_adjustments"]["openrouter:slow-model"]
        # Five completed first-token observations are enough to influence
        # routing, but not enough to tighten a production watchdog.
        self.assertNotIn("first_token_timeout_ms", policy)
        self.assertIn("routing_score_delta", policy)

    def test_timeout_policy_requires_a_deeper_sample_and_uses_the_first_token_tail(self):
        policy = _model_policy({
            "sample_count": 20,
            "success_rate": 0.95,
            "p95_duration_ms": 30_000,
            "first_token_sample_count": 20,
            "p95_first_token_ms": 10_000,
            "p99_first_token_ms": 20_000,
        }, min_samples=5)

        self.assertIsNotNone(policy)
        self.assertEqual(policy["first_token_timeout_ms"], 25_000)


if __name__ == "__main__":
    unittest.main()
