import json
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


if __name__ == "__main__":
    unittest.main()
