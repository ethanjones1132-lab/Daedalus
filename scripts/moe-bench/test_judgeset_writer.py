import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import judgeset_writer as jw  # noqa: E402


class WriterTest(unittest.TestCase):
    def test_prompt_is_for_a_benchmark_not_training(self):
        p = jw.judge_prompts(per_family=2)
        self.assertEqual(len(p), 10)
        self.assertTrue(all("training" not in text for _, _, _, text in p))
        self.assertEqual({fam for _, fam, _, _ in p}, set("ABCDE"))

    def test_select_first_k_per_family_by_id(self):
        kept = [{"name": f"t_{f}{i}", "category": f, "id": f"{f}{i:04d}"} for f in "AB" for i in (3, 1, 2)]
        sel = jw.select(kept, k=2)
        self.assertEqual([t["id"] for t in sel], ["A0001", "A0002", "B0001", "B0002"])
        self.assertTrue(all(t["name"].startswith("d_") for t in sel))

    def test_counts(self):
        self.assertEqual(jw.short_families([{"category": "A"}] * 24 + [{"category": "B"}] * 3, k=24),
                         {"B": 21, "C": 24, "D": 24, "E": 24})


if __name__ == "__main__":
    unittest.main()
