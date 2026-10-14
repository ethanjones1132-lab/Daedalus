import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import longctx_build as lb  # noqa: E402
from bestofn_tier2b import TASKS  # noqa: E402


def fake_count(text):
    return len(text) // 4


class FillerTest(unittest.TestCase):
    counts = {f"u{i}": 50 + (i * 37) % 200 for i in range(200)}

    def test_hits_target_within_tolerance(self):
        for target in (1000, 5000, 12000):
            uids, total = lb.build_filler(list(self.counts), self.counts, target, 1)
            self.assertGreaterEqual(total, target * 0.95)
            self.assertLessEqual(total, target * 1.05)
            self.assertEqual(total, sum(self.counts[u] for u in uids))

    def test_same_seed_same_filler(self):
        a = lb.build_filler(list(self.counts), self.counts, 5000, 1)
        self.assertEqual(a, lb.build_filler(list(reversed(list(self.counts))), self.counts, 5000, 1))
        self.assertNotEqual(a[0], lb.build_filler(list(self.counts), self.counts, 5000, 2)[0])

    def test_runs_out(self):
        with self.assertRaises(ValueError):
            lb.build_filler(["a"], {"a": 10}, 1000, 1)

    def test_unit_tokens(self):
        self.assertEqual(lb.unit_tokens([("user", "abcd"), ("assistant", "abcdefgh")], fake_count), 13)


class UnitsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.units = lb.all_units(failure=lambda t: "AssertionError")

    def test_only_pool_and_stdlib(self):
        pool = {t["name"] for t in lb.load_tasks(lb.DOCS / "laya-calib" / "tasks.py", "_t_pool")}
        for uid, _ in self.units:
            kind, _, rest = uid.partition(":")
            self.assertIn(kind, ("ep", "file"))
            if kind == "ep":
                self.assertIn(rest, pool)
        self.assertGreaterEqual(sum(u.startswith("ep:") for u, _ in self.units), 55)

    def test_no_tier2b_or_judge_names(self):
        rx = lb.block_regex()
        self.assertTrue(rx.search("x = merge_intervals(a)"))
        self.assertTrue(rx.search(TASKS[-1]["name"]))
        self.assertFalse(rx.search("merge the intervals"))
        for uid, msgs in self.units:
            self.assertIsNone(rx.search("\n".join(c for _, c in msgs)), uid)

    def test_units_alternate_roles(self):
        for uid, msgs in self.units:
            roles = [r for r, _ in msgs]
            self.assertEqual(roles, ["user", "assistant"] * (len(roles) // 2), uid)

    def test_enough_material_for_the_largest_target(self):
        total = sum(lb.unit_tokens(m, fake_count) for _, m in self.units)
        self.assertGreater(total, 116000 * 1.3)


class SessionTest(unittest.TestCase):
    filler = [{"role": "user", "content": "f1"}, {"role": "assistant", "content": "a1"}]

    def test_late_ends_with_short(self):
        for task in TASKS[:5]:
            late = lb.late(task, self.filler)
            self.assertEqual(late[-1], lb.short(task)[0])
            self.assertEqual(late[:-1], self.filler)

    def test_early_shape(self):
        e = lb.early(TASKS[0], self.filler)
        self.assertEqual(e[0], lb.short(TASKS[0])[0])
        self.assertEqual([m["role"] for m in e], ["user", "assistant", "user", "assistant", "user"])
        self.assertEqual(e[-1]["content"], lb.EARLY_BACK)

    def test_messages_expand_units(self):
        units = {"a": [("user", "x"), ("assistant", "y")], "b": [("user", "z"), ("assistant", "w")]}
        self.assertEqual([m["content"] for m in lb.messages(units, ["b", "a"])], ["z", "w", "x", "y"])


class FailureTest(unittest.TestCase):
    def test_failure_output_has_no_local_paths(self):
        pool = lb.load_tasks(lb.DOCS / "laya-calib" / "tasks.py", "_t_pool2")
        out = lb.failure_output(pool[0])
        self.assertTrue(out)
        self.assertNotIn("lc-", out)
        self.assertNotIn(sys.base_prefix, out)
        self.assertNotIn("Users", out)


if __name__ == "__main__":
    unittest.main()
