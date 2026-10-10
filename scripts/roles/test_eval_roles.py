import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import eval_roles  # noqa: E402


class StatsTest(unittest.TestCase):
    def test_one_sided_mcnemar(self):
        self.assertAlmostEqual(eval_roles.p_one_sided(8, 0), 1 / 256)
        self.assertEqual(eval_roles.p_one_sided(0, 0), 1.0)
        self.assertAlmostEqual(eval_roles.p_one_sided(3, 3), 0.65625)

    def test_gate_passes_with_a_clear_gain(self):
        base = {f"s{i}": i < 10 for i in range(40)}
        adapter = {f"s{i}": i < 10 or 10 <= i < 20 for i in range(40)}
        g = eval_roles.gate(adapter, base)
        self.assertEqual((g["n"], g["adapter_pass"], g["base_pass"]), (40, 20, 10))
        self.assertAlmostEqual(g["diff"], 0.25)
        self.assertTrue(g["passed"])
        self.assertLess(g["ci90"][0], 0.25)
        self.assertGreater(g["ci90"][1], 0.25)

    def test_gate_fails_on_a_small_or_noisy_gain(self):
        base = {f"s{i}": i < 20 for i in range(40)}
        small = {f"s{i}": i < 21 for i in range(40)}
        self.assertFalse(eval_roles.gate(small, base)["passed"])

    def test_only_shared_seeds_count(self):
        g = eval_roles.gate({"a": True, "b": True}, {"b": False, "c": True})
        self.assertEqual(g["n"], 1)


if __name__ == "__main__":
    unittest.main()
