import unittest


def build_report(manifest, observations, rubric_results):
    from scripts.direct_vs_orchestrated.report import build_report

    return build_report(manifest, observations, rubric_results)


class ComparisonReportTests(unittest.TestCase):
    def test_report_includes_every_failed_and_timed_out_trial(self):
        report = build_report(
            {"served_alias": "local-alias"},
            [
                {"observation_id": "direct-ok", "phase": "warm", "mode": "direct", "task_id": "arithmetic", "pair_id": "arithmetic_pair_01", "outcome": "success", "trial_status": "success", "total_wall_ms": 120},
                {"observation_id": "orch-timeout", "phase": "warm", "mode": "orchestrated", "task_id": "arithmetic", "pair_id": "arithmetic_pair_01", "outcome": "timeout", "trial_status": "timeout", "total_wall_ms": 120000, "cancel_confirmed": False},
                {"observation_id": "direct-error", "phase": "warm", "mode": "direct", "task_id": "code_explanation", "outcome": "error", "trial_status": "error", "code": "provider_error", "reason": "failed"},
            ],
            [],
        )

        self.assertIn("orch-timeout", report)
        self.assertIn("direct-error", report)
        self.assertIn("timeout", report)
        self.assertIn("provider_error", report)
        self.assertIn("cancel_confirmed=false", report)

    def test_report_shows_pairwise_latency_and_acceptance_separately(self):
        report = build_report(
            {"served_alias": "local-alias"},
            [
                {"observation_id": "pair-a", "phase": "warm", "mode": "direct", "task_id": "arithmetic", "pair_id": "arithmetic_pair_01", "pair_order": "direct_then_orchestrated", "outcome": "success", "trial_status": "success", "total_wall_ms": 100, "first_visible_ms": 10, "last_visible_to_terminal_ms": 20},
                {"observation_id": "pair-b", "phase": "warm", "mode": "orchestrated", "task_id": "arithmetic", "pair_id": "arithmetic_pair_01", "pair_order": "direct_then_orchestrated", "outcome": "success", "trial_status": "success", "total_wall_ms": 150, "first_visible_ms": 15, "last_visible_to_terminal_ms": 25, "code": "ok", "reason": "completed"},
            ],
            [
                {"assessment_type": "mechanical", "observation_id": "pair-a", "task_id": "arithmetic", "criterion_id": "exact", "status": "pass"},
                {"assessment_type": "mechanical", "observation_id": "pair-b", "task_id": "arithmetic", "criterion_id": "exact", "status": "fail"},
            ],
        )

        self.assertIn("Paired wall time", report)
        self.assertIn("+50 ms", report)
        self.assertIn("wall=100 ms; first=10 ms; last→terminal=20 ms", report)
        self.assertIn("wall=150 ms; first=15 ms; last→terminal=25 ms", report)
        self.assertIn("terminal=ok: completed", report)
        self.assertIn("Acceptance results", report)
        self.assertIn("pass", report)
        self.assertIn("fail", report)
        self.assertLess(report.index("Paired wall time"), report.index("Acceptance results"))

    def test_blocked_success_is_not_used_for_pairwise_latency(self):
        report = build_report(
            {},
            [
                {"observation_id": "direct", "phase": "warm", "mode": "direct", "task_id": "arithmetic", "pair_id": "pair-1", "outcome": "success", "trial_status": "success", "total_wall_ms": 100},
                {"observation_id": "orchestrated", "phase": "warm", "mode": "orchestrated", "task_id": "arithmetic", "pair_id": "pair-1", "outcome": "success", "trial_status": "blocked", "safety_reasons": ["cloud_route"], "total_wall_ms": 90},
            ],
            [],
        )

        self.assertIn("not comparable (failure retained)", report)
        self.assertIn("outcome=success/blocked", report)
        self.assertIn("cloud_route", report)

    def test_unknown_token_and_route_fields_are_not_imputed(self):
        report = build_report(
            {"served_alias": "configured-alias", "generation_defaults": {"arithmetic": {"max_tokens": 999}}},
            [{
                "observation_id": "route-unknown",
                "phase": "warm",
                "mode": "direct",
                "task_id": "arithmetic",
                "pair_id": "arithmetic_pair_01",
                "outcome": "success",
                "trial_status": "success",
                "total_wall_ms": 50,
                "route_attempts": None,
                "answered_by": None,
                "tokens_in": None,
                "tokens_out": None,
                "tokens_total": None,
            }],
            [],
        )

        self.assertIn("| unknown | in=unknown", report)
        self.assertIn("in=unknown", report)
        self.assertIn("out=unknown", report)
        self.assertNotIn("out=999", report)
        self.assertEqual(report.count("configured-alias"), 1)

    def test_report_includes_provenance_and_redacts_credentials(self):
        report = build_report(
            {
                "source_sha": "source-sha",
                "source_tree_sha256": "tree-sha",
                "llama_server_path": "C:/local/llama-server.exe",
                "llama_server_sha256": "binary-sha",
                "gguf_path": "C:/models/local.gguf",
                "gguf_sha256": "model-sha",
                "bun_path": "C:/tools/bun.exe",
                "bun_sha256": "bun-sha",
                "served_alias": "comparison-local",
                "llama_argv_redacted": ["llama-server", "--api-key=[REDACTED]"],
                "generation_defaults": {"arithmetic": {"max_tokens": 64}},
                "openrouter": {"api_key": "secret-value-must-not-appear"},
                "hardware": {"machine": "test-host"},
            },
            [],
            [],
        )

        for value in ("source-sha", "tree-sha", "binary-sha", "model-sha", "bun-sha", "comparison-local", "[REDACTED]", '"max_tokens": 64'):
            self.assertIn(value, report)
        self.assertNotIn("secret-value-must-not-appear", report)

    def test_small_sample_is_labeled_descriptive_only(self):
        report = build_report(
            {"expected_counts": {"warm_reported": 24}},
            [],
            [],
        )

        self.assertIn("descriptive-only", report.lower())
        self.assertIn("does not establish general quality superiority", report.lower())

    def test_write_report_reads_saved_artifacts_and_creates_report_md(self):
        import json
        import tempfile
        from pathlib import Path

        from scripts.direct_vs_orchestrated.report import write_report

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "manifest.json").write_text(json.dumps({"run_status": "incomplete"}), encoding="utf-8")
            (root / "observations.jsonl").write_text(
                json.dumps({"observation_id": "failed-1", "outcome": "timeout", "trial_status": "timeout"}) + "\n",
                encoding="utf-8",
            )
            (root / "rubric.jsonl").write_text("", encoding="utf-8")

            report_path = write_report(root)

            self.assertEqual(report_path, root / "report.md")
            report = report_path.read_text(encoding="utf-8")
            self.assertIn("failed-1", report)
            self.assertIn("timeout", report)


if __name__ == "__main__":
    unittest.main()
