import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import longctx_sessions as ls  # noqa: E402


def row(cond, w, t, task, trial, ok):
    return {"cond": cond, "window": w, "target": t, "task": task, "category": "A", "trial": trial,
            "graded_ok": ok, "prompt_ms": 1000, "prompt_n": 100, "cache_n": 0, "content": f"{task}{trial}{ok}"}


def rows_for(late_ok, n_tasks=6, w=65536, t=56000):
    """Short solves everything; Late solves task i on every trial when late_ok(i)."""
    out = {}
    for i in range(n_tasks):
        for trial in range(3):
            for r in (row("short", w, 0, f"t{i}", trial, True), row("late", w, t, f"t{i}", trial, late_ok(i))):
                out[ls.key_of(r)] = r
    return out


class ReportTest(unittest.TestCase):
    def test_bar_b_fails_on_a_significant_loss(self):
        g = ls.summarize(rows_for(lambda i: False), expected=18)["65536/56000"]
        self.assertEqual(g["solved"], {"short": 18, "late": 0})
        self.assertEqual((g["late_vs_short"]["short_tasks"], g["late_vs_short"]["cond_tasks"]), (6, 0))
        self.assertLess(g["late_vs_short"]["sign_p"], 0.10)
        self.assertFalse(g["bar_b_pass"])

    def test_bar_b_passes_on_a_small_loss(self):
        g = ls.summarize(rows_for(lambda i: i > 0), expected=18)["65536/56000"]
        self.assertEqual(g["late_vs_short"]["short_tasks"], 1)
        self.assertTrue(g["bar_b_pass"])

    def test_incomplete_group_does_not_pass(self):
        g = ls.summarize(rows_for(lambda i: True), expected=117)["65536/56000"]
        self.assertFalse(g["complete"])
        self.assertFalse(g["bar_b_pass"])

    def test_short_against_stored(self):
        rs = rows_for(lambda i: True, n_tasks=2)
        stored = {(r["task"], r["trial"]): {"content": r["content"], "graded_ok": r["graded_ok"]}
                  for r in rs.values() if r["cond"] == "short"}
        stored[("t0", 0)] = {"content": "other", "graded_ok": False}
        rep = ls.summarize(rs, stored=stored, expected=6)
        self.assertEqual(rep["short_vs_stored"]["65536"],
                         {"n": 6, "same_text": 5, "same_grade": 5, "stored_solved": 5, "short_solved": 6})


class AnswerTest(unittest.TestCase):
    verdict = {"ctk": {"16384": "q8_0", "32768": "q8_0", "65536": "q8_0", "131072": "q4_0"}}

    @staticmethod
    def rep(passes):
        return {f"{w}/{ls.TARGETS[w]}": {"window": w, "target": ls.TARGETS[w], "complete": True, "bar_b_pass": p}
                for w, p in passes.items()}

    def ask(self, what, rep=None, bar_a=None):
        return ls.answer(what, self.verdict, rep or {}, bar_a or {})

    def test_queries(self):
        self.assertEqual(self.ask("ctk:65536"), "q8_0")
        self.assertEqual(self.ask("ctk:98304"), "none")
        self.assertEqual(self.ask("target:131072"), "116000")
        self.assertEqual(self.ask("top"), "131072")
        self.assertEqual(self.ask("barb:65536"), "missing")
        self.assertEqual(self.ask("barb:65536", self.rep({65536: True})), "pass")
        self.assertEqual(self.ask("barb:65536", self.rep({65536: False})), "fail")
        self.assertEqual(self.ask("bara:65536", bar_a={65536: True}), "pass")
        self.assertEqual(self.ask("bara:131072", bar_a={65536: True}), "missing")

    def test_chosen(self):
        both = self.rep({65536: True, 131072: True})
        self.assertEqual(self.ask("chosen", both, {65536: True, 131072: False}), "65536")
        self.assertEqual(self.ask("chosen", both, {65536: True, 131072: True}), "131072")
        self.assertEqual(self.ask("chosen", self.rep({65536: False}), {65536: True}), "none")

    def test_incomplete_group_is_missing(self):
        rep = self.rep({65536: True})
        rep["65536/56000"]["complete"] = False
        self.assertEqual(self.ask("barb:65536", rep), "missing")


class BarATest(unittest.TestCase):
    @staticmethod
    def outcomes(ok):
        return {(f"t{i}", "A", tr): {"single": ok(i), "recipe": ok(i)} for i in range(6) for tr in range(3)}

    def test_identical_runs_pass(self):
        o = self.outcomes(lambda i: i % 2 == 0)
        r = ls.bar_a(o, o)
        self.assertTrue(r["pass"])
        self.assertEqual((r["stored_only"], r["new_only"], r["new_solved"]), (0, 0, 9))

    def test_a_significant_loss_fails(self):
        r = ls.bar_a(self.outcomes(lambda i: True), self.outcomes(lambda i: False))
        self.assertFalse(r["pass"])
        self.assertEqual((r["stored_tasks"], r["new_tasks"]), (6, 0))


class CountsTest(unittest.TestCase):
    def test_cached_once_and_recounted_when_changed(self):
        calls = []

        def count(text):
            calls.append(text)
            return len(text)

        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "c.json"
            units = [("a", [("user", "xx"), ("assistant", "y")])]
            self.assertEqual(ls.unit_counts(units, p, count), {"a": 13})
            n = len(calls)
            ls.unit_counts(units, p, count)
            self.assertEqual(len(calls), n)
            ls.unit_counts([("a", [("user", "xxx"), ("assistant", "y")])], p, count)
            self.assertGreater(len(calls), n)


if __name__ == "__main__":
    unittest.main()
