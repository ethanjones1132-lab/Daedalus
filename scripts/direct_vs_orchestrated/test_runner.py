import csv
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TASKS_PATH = ROOT / "tasks.json"
FIXTURE_PATH = ROOT / "fixtures" / "stock.csv"
EXPECTED_TASK_IDS = [
    "arithmetic",
    "code_explanation",
    "fixture_tool_read",
    "planning_no_implementation",
]


def load_tasks():
    return json.loads(TASKS_PATH.read_text(encoding="utf-8"))["tasks"]


class ComparisonCorpusTests(unittest.TestCase):
    def test_corpus_has_four_fixed_task_ids(self):
        tasks = load_tasks()
        self.assertEqual([task["id"] for task in tasks], EXPECTED_TASK_IDS)

    def test_fixture_task_expected_answer_matches_fixture_data(self):
        tasks = load_tasks()
        task = next(task for task in tasks if task["id"] == "fixture_tool_read")
        with FIXTURE_PATH.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        winner = max(rows, key=lambda row: int(row["quantity"]))
        expected = f'{winner["name"]}: {winner["quantity"]}'
        self.assertEqual(task["acceptance"]["expected_answer"], expected)

    def test_all_tasks_define_generation_limits_and_acceptance_ids(self):
        tasks = load_tasks()
        self.assertEqual(len(tasks), 4)
        for task in tasks:
            with self.subTest(task=task.get("id")):
                self.assertIsInstance(task.get("max_tokens"), int)
                self.assertGreater(task["max_tokens"], 0)
                self.assertIsInstance(task.get("temperature"), (int, float))
                self.assertIsInstance(task.get("top_p"), (int, float))
                acceptance = task.get("acceptance")
                self.assertIsInstance(acceptance, dict)
                self.assertTrue(acceptance.get("id"))
                self.assertTrue(acceptance.get("criteria"))


if __name__ == "__main__":
    unittest.main()
