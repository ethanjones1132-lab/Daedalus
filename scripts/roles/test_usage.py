import json
import os
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import teacher_gen as tg  # noqa: E402


class UsageTest(unittest.TestCase):
    def test_log_usage_appends_a_json_line(self):
        d = pathlib.Path(tempfile.mkdtemp())
        tg.USAGE_LOG = d / "usage.jsonl"
        tg.log_usage({"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}, "deepseek", 12.5)
        tg.log_usage(None, "deepseek", 1.0)
        rows = [json.loads(line) for line in tg.USAGE_LOG.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(rows[0]["completion_tokens"], 20)
        self.assertEqual(rows[0]["backend"], "deepseek")
        self.assertEqual(rows[1]["completion_tokens"], None)


class BudgetTest(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        tg.USAGE_LOG = self.d / "usage.jsonl"
        tg._stop.clear()

    def tearDown(self):
        tg._stop.clear()
        for k in ("TEACHER_TOKEN_CAP", "TEACHER_BUDGET_SINCE"):
            os.environ.pop(k, None)

    def test_spent_tokens_counts_only_deepseek_rows_since_the_start(self):
        rows = [{"t": 100, "backend": "deepseek", "total_tokens": 50}, {"t": 300, "backend": "deepseek", "total_tokens": 70},
                {"t": 300, "backend": "grok", "total_tokens": 999}, {"t": 400, "backend": "deepseek", "total_tokens": None}]
        tg.USAGE_LOG.write_text("\n".join(json.dumps(r) for r in rows) + "\nnot json\n", encoding="utf-8")
        self.assertEqual(tg.spent_tokens(0), 120)
        self.assertEqual(tg.spent_tokens(200), 70)

    def test_call_stops_at_the_cap_and_never_hides_it_as_an_ordinary_error(self):
        tg.USAGE_LOG.write_text(json.dumps({"t": 500, "backend": "deepseek", "total_tokens": 80}) + "\n", encoding="utf-8")
        os.environ["TEACHER_TOKEN_CAP"], os.environ["TEACHER_BUDGET_SINCE"] = "80", "0"
        with self.assertRaises(tg.Stop):
            tg.call("deepseek", "hi")
        with self.assertRaises(tg.Stop):  # once tripped, every worker stops, even before it reads the log
            tg.call("deepseek", "hi")

    def test_a_spent_plan_window_stops_the_pool_instead_of_recording_an_empty_reply(self):
        def spent(prompt, **kw):
            raise tg.opencode_go.GoUsageLimitError("HTTP 429, Retry-After 24600 s")
        old = tg.BACKENDS["deepseek"]
        tg.BACKENDS["deepseek"] = spent
        try:
            with self.assertRaises(tg.Stop):
                tg.call("deepseek", "hi")
        finally:
            tg.BACKENDS["deepseek"] = old

    def test_no_cap_means_no_limit(self):
        tg.USAGE_LOG.write_text(json.dumps({"t": 500, "backend": "deepseek", "total_tokens": 10**9}) + "\n", encoding="utf-8")
        tg.check_budget()


if __name__ == "__main__":
    unittest.main()
