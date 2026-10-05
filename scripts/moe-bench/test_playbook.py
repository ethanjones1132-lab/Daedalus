import collections
import json
import os
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import playbook as pb  # noqa: E402

RULE = dict(c_u=0.5, c_easy=0.5, c_hard=0.5, t_hi=pb.NEVER, t_lo=-1.0)


def cand(run, i, ok, tests=None, p=None, secs=1.0, vs=0.3, compiles=True):
    """tests: {suite: [passed, ...]}"""
    return {"run": run, "cand": i, "secs": secs, "compiles": compiles, "imports": compiles, "graded_ok": ok,
            "self": {s: {f"t{j}": v for j, v in enumerate(vals)} for s, vals in (tests or {}).items()},
            "p": p, "verify_secs": vs}


def rec(r8, pr, probe_secs=2.0, suite_secs=1.0, classify_secs=0.4, task="t"):
    return {"task": task, "category": "A", "trial": 0, "probe_secs": probe_secs, "classify_secs": classify_secs,
            "suites": {k: {"secs": suite_secs} for k in ("r8s0", "r8s1", "prs0")}, "cands": {"r8": r8, "pr": pr}}


def card(unseen=0.0, p_little=0.0, p_alot=0.0, effort_top=1, kind="algorithm"):
    return {"kind": kind, "unseen": unseen, "p_little": p_little, "p_alot": p_alot, "effort_top": effort_top}


def plain_rec(r8_ok=(False,) * 8, pr_ok=(False,) * 3):
    tests = {"r8s0": [False], "r8s1": [False], "prs0": [False]}
    return rec([cand("r8", i, ok, tests) for i, ok in enumerate(r8_ok)],
               [cand("pr", i, ok, tests) for i, ok in enumerate(pr_ok)])


class ChooseTest(unittest.TestCase):
    def test_no_card_runs_the_recipe(self):
        self.assertEqual(pb.choose(None, RULE), "R")

    def test_rule_order(self):
        self.assertEqual(pb.choose(card(unseen=0.9, effort_top=0), RULE), "P")
        self.assertEqual(pb.choose(card(unseen=0.9, effort_top=2), RULE), "PR")
        self.assertEqual(pb.choose(card(p_little=0.9, p_alot=0.9), RULE), "S")
        self.assertEqual(pb.choose(card(p_alot=0.9), RULE), "R8")
        self.assertEqual(pb.choose(card(), RULE), "R")


class PickTest(unittest.TestCase):
    def test_most_tests_then_p_then_group_then_index(self):
        a = cand("r8", 0, False, {"r8s0": [True, False]}, p=0.2)
        b = cand("r8", 1, True, {"r8s0": [True, False]}, p=0.9)
        c = cand("r8", 2, False, {"r8s0": [False, False]}, p=1.0)
        self.assertIs(pb.pick([a, b, c], ("r8s0",)), a)  # no P: tie goes to the lowest index
        self.assertIs(pb.pick([a, b, c], ("r8s0",), lambda x: x["p"]), b)

    def test_p_asked_only_for_ties_at_the_top(self):
        a = cand("r8", 0, True, {"r8s0": [True, True]})
        b = cand("r8", 1, False, {"r8s0": [True, False]})
        asked = []
        pb.pick([a, b], ("r8s0",), lambda x: asked.append(x["cand"]) or 0.5)
        self.assertEqual(asked, [])

    def test_non_compiling_candidates_are_skipped(self):
        a = cand("r8", 0, False, {"r8s0": [True]}, compiles=False)
        b = cand("r8", 1, True, {"r8s0": [False]})
        self.assertIs(pb.pick([a, b], ("r8s0",)), b)


class OutcomeTest(unittest.TestCase):
    def test_plain_costs(self):
        r = plain_rec()
        self.assertEqual(pb.outcome(r, "S")[1], 1.0)
        self.assertEqual(pb.outcome(r, "R")[1], 1.0 + 3)
        self.assertEqual(pb.outcome(r, "R8")[1], 2.0 + 8)
        self.assertEqual(pb.outcome(r, "P")[1], 2.0 + 1)
        self.assertEqual(pb.outcome(r, "PR")[1], 2.0 + 1.0 + 3)

    def test_plain_picks(self):
        self.assertTrue(pb.outcome(plain_rec(r8_ok=(True,) + (False,) * 7), "S")[0])
        self.assertFalse(pb.outcome(plain_rec(pr_ok=(True, False, False)), "S")[0])
        self.assertTrue(pb.outcome(plain_rec(pr_ok=(True, False, False)), "P")[0])

    def test_early_stop(self):
        r8 = [cand("r8", 0, True, {"r8s0": [True, True]}, p=0.95)] + \
             [cand("r8", i, False, {"r8s0": [False, False]}) for i in range(1, 8)]
        r = rec(r8, [cand("pr", i, False) for i in range(3)])
        ok, secs = pb.outcome(r, "R8", t_hi=0.9, use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 1.0 + 0.3)  # first suite + candidate 0 + one verify

    def test_no_early_stop_when_p_is_low(self):
        r8 = [cand("r8", 0, True, {"r8s0": [True]}, p=0.5)] + \
             [cand("r8", i, False, {"r8s0": [False]}) for i in range(1, 8)]
        r = rec(r8, [cand("pr", i, False) for i in range(3)])
        ok, secs = pb.outcome(r, "R", t_hi=0.9, use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 3 + 0.3)  # verify of candidate 0 is still paid

    def test_escalation_adds_the_probe_fix(self):
        r8 = [cand("r8", i, False, p=0.1) for i in range(8)]
        pr = [cand("pr", 0, True, p=0.8)] + [cand("pr", i, False) for i in (1, 2)]
        ok, secs = pb.outcome(rec(r8, pr), "S", t_lo=0.3, use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 2.0 + 1.0 + 0.3 + 0.3)  # S + probe + fix + two verifies

    def test_no_verify_cost_without_ties(self):
        r8 = [cand("r8", 0, True, {"r8s0": [True, True]}, p=0.4)] + \
             [cand("r8", i, False, {"r8s0": [False, True]}, p=0.4) for i in range(1, 8)]
        ok, secs = pb.outcome(rec(r8, [cand("pr", i, False) for i in range(3)]), "R", use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 3)


class FitTest(unittest.TestCase):
    def test_fit_routes_easy_tasks_to_single_shot_within_budget(self):
        easy = [plain_rec(r8_ok=(True,) * 8) for _ in range(4)]
        hard = [plain_rec(r8_ok=(False, True, False, False, False, False, False, False)) for _ in range(4)]
        for i, r in enumerate(easy):
            r["task"] = f"e{i}"
        for i, r in enumerate(hard):
            r["task"] = f"h{i}"
            r["cands"]["r8"][1]["self"]["r8s0"] = {"t0": True}
        cards = {r["task"]: card(p_little=0.9) for r in easy} | {r["task"]: card(p_little=0.1) for r in hard}
        recs = easy + hard
        budget = pb.fixed(recs, "R")[1]
        rule, solved, secs = pb.fit(recs, cards, budget, use_p=False)
        self.assertEqual(solved, 8)
        self.assertLessEqual(secs, budget)
        self.assertEqual(pb.choose(cards["e0"], rule), "S")


class StatsTest(unittest.TestCase):
    def test_mcnemar(self):
        self.assertEqual(pb.mcnemar_p(0, 0), 1.0)
        self.assertAlmostEqual(pb.mcnemar_p(8, 1), 0.0390625)


class MatchesBestofnTest(unittest.TestCase):
    def test_pick_equals_bestofn_selftest_on_a_stored_run(self):
        os.environ.setdefault("TIER2B_DIR", str(HERE.parents[1] / "scripts" / "benchmark-tier2b"))
        import bestofn_tier2b as bon
        path = HERE.parents[1] / "docs" / "benchmarks" / "2026-10-05" / "bestofn-keep96-recipe-replication.jsonl"
        latest = {}
        for r in map(json.loads, path.read_text(encoding="utf-8").splitlines()):
            if r.get("type") == "cand":
                latest[(r["task"], r["trial"], r["cand"])] = r
        by = collections.defaultdict(list)
        for r in latest.values():
            by[(r["task"], r["trial"])].append(r)
        for cands in by.values():
            cands.sort(key=lambda r: r["cand"])
            self.assertEqual(pb.pick(cands, ("s0",))["cand"], bon.pick(cands, "selftest")["cand"])


if __name__ == "__main__":
    unittest.main()
