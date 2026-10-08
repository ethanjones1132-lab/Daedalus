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

    def test_task_sign_counts_tasks_not_trials(self):
        # (task, a_ok, b_ok) per trial: t1 a wins 3-0, t2 a wins 2-1, t3 tie 1-1, t4 b wins 0-1
        pairs = ([("t1", True, False)] * 3 + [("t2", True, True), ("t2", True, False), ("t2", False, False)]
                 + [("t3", True, False), ("t3", False, True), ("t3", False, False)]
                 + [("t4", False, True), ("t4", False, False), ("t4", False, False)])
        wins, losses, p = pb.task_sign(pairs)
        self.assertEqual((wins, losses), (2, 1))
        self.assertAlmostEqual(p, pb.mcnemar_p(2, 1))
        self.assertEqual(pb.task_sign([]), (0, 0, 1.0))


class TargetedTest(unittest.TestCase):
    RULE = dict(form="targeted", c_hidden=0.1, t_hi=pb.NEVER, t_lo=-1.0)

    def test_choose(self):
        self.assertEqual(pb.choose(dict(card(), hidden=0.2), self.RULE), "P")
        self.assertEqual(pb.choose(dict(card(), hidden=0.05), self.RULE), "R")
        self.assertEqual(pb.choose(None, self.RULE), "R")

    def test_decile_grid(self):
        g = pb.decile_grid([i / 100 for i in range(60)])
        self.assertEqual(len(g), 11)
        self.assertEqual((g[0], g[-1]), (0.0, pb.NEVER))

    def test_fit_targeted_probes_only_where_it_pays(self):
        tests = {"r8s0": [True], "r8s1": [True], "prs0": [True]}
        b = rec([cand("r8", i, False, tests) for i in range(8)], [cand("pr", i, True, tests) for i in range(3)],
                task="b")
        a = rec([cand("r8", i, True, tests) for i in range(8)], [cand("pr", i, False, tests) for i in range(3)],
                task="a")
        cards = {"b": dict(card(), hidden=0.3), "a": dict(card(), hidden=0.05)}
        rule, solved, _ = pb.fit_targeted([a, b], cards, budget=1e9, use_p=False)
        self.assertEqual((rule["form"], rule["c_hidden"], solved), ("targeted", 0.3, 2))


class NoteTest(unittest.TestCase):
    def test_note_for(self):
        os.environ.setdefault("TIER2B_DIR", str(HERE.parents[1] / "scripts" / "benchmark-tier2b"))
        import playbook_tier2b as pt
        tgt = dict(form="targeted", c_hidden=0.1, t_hi=pb.NEVER, t_lo=-1.0)
        c = dict(card(kind="library"), hidden=0.3)
        self.assertEqual(pt.note_for(c, "P", tgt), pt.NOTES["unseen"] + "\n\n")
        self.assertEqual(pt.note_for(c, "R", tgt), "")
        self.assertEqual(pt.note_for(c, "R", RULE), pt.NOTES["library"] + "\n\n")
        self.assertEqual(pt.note_for(None, "R", tgt), "")


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


class CommandsTest(unittest.TestCase):
    def test_fit_commands_end_to_end(self):
        import argparse
        import tempfile
        import laya_calibrate as lc
        d = pathlib.Path(tempfile.mkdtemp())
        trials, labels = [], []
        for t in range(10):
            cat = "B" if t < 3 else "A"
            easy = t >= 6
            for trial in range(3):
                cands = []
                for run, n in (("r8", 8), ("pr", 3)):
                    for c in range(n):
                        ok = easy or (cat == "B" and run == "pr") or (c == 1 and run == "r8")
                        cands.append({"run": run, "cand": c, "secs": 1.0, "compiles": True, "imports": True,
                                      "graded_ok": ok, "code": "x = 1",
                                      "self": {s: {"t0": ok} for s in ("r8s0", "r8s1", "prs0")}})
                        labels.append({"type": "verify", "task": f"t{t}", "trial": trial, "run": run, "cand": c,
                                       "form": "noul", "p": 0.8 if ok else 0.3, "secs": 0.3})
                        labels.append({"type": "verify", "task": f"t{t}", "trial": trial, "run": run, "cand": c,
                                       "form": "rubric", "p": 0.5, "secs": 0.3})
                trials.append({"type": "trial", "task": f"t{t}", "category": cat, "trial": trial,
                               "suites": {s: {"secs": 1.0} for s in ("r8s0", "r8s1", "prs0")},
                               "probe": {"secs_gen": 1.0, "secs_exec": 0.2}, "cands": cands})
            for w in ("v1", "v2"):
                labels.append({"type": "card", "task": f"t{t}", "wording": w, "secs": 0.35,
                               "card": {"kind": "unseen" if cat == "B" else "algorithm",
                                        "kind_p": {"unseen": 0.6 if cat == "B" else 0.1},
                                        "unseen": (0.9 if cat == "B" else 0.2) if w == "v1" else 0.5,
                                        "effort_p": [0.8, 0.1, 0.1] if easy else [0.1, 0.3, 0.6]}})
        (d / "n.jsonl").write_text("\n".join(map(json.dumps, trials)), encoding="utf-8")
        (d / "l.jsonl").write_text("\n".join(map(json.dumps, labels)), encoding="utf-8")
        lc.fit_cmd(argparse.Namespace(trials=str(d / "n.jsonl"), labels=str(d / "l.jsonl"), out=str(d / "c.json")))
        calib = json.loads((d / "c.json").read_text(encoding="utf-8"))
        self.assertEqual(calib["classify_wording"], "v1")
        self.assertEqual(calib["verify_form"], "noul")
        pb.fit_cmd(argparse.Namespace(trials=str(d / "n.jsonl"), labels=str(d / "l.jsonl"),
                                      calib=str(d / "c.json"), out=str(d / "r.json")))
        rule = json.loads((d / "r.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(rule["verify_fit"]["solved"], rule["calib_pool"]["R"])
        self.assertLessEqual(rule["verify_fit"]["mean_secs"], rule["budget_secs"])


def p3(fixes, asserts=("assert f(1) == 2",), valid_p=(0.9,), ev=None, probe_secs=2.0):
    return {"probe_secs": probe_secs, "evidence": ev, "evidence_secs": 0.3, "examples_secs": 0.5,
            "asserts": list(asserts), "valid_p": list(valid_p), "valid_secs": [0.3] * len(valid_p), "fixes": fixes}


def fix(ok, asserts_ok=(True,), repair=None, secs=1.0):
    return {"graded_ok": ok, "secs": secs, "asserts_ok": list(asserts_ok), "repair": repair}


class V3Test(unittest.TestCase):
    RULE = dict(form="v3", c_hidden=0.1, c_lib=0.5, c_note=0.5, c_valid=0.5, t_hi=pb.NEVER, t_lo=-1.0, e_fail=True)

    def test_route_library_gate(self):
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.2, library=0.1), self.RULE), "P3")
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.2, library=0.9), self.RULE), "R")
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.05, library=0.1), self.RULE), "R")
        self.assertEqual(pb.route_v3(None, self.RULE), "R")

    def test_probe_note_and_gate(self):
        ev = {"choice": "scale", "probabilities": {"scale": 0.8, "none": 0.2}}
        r = {"p3": p3([fix(False, (False,), repair={"graded_ok": False, "secs": 1.0}),
                       fix(False, (False,), repair={"graded_ok": True, "secs": 1.0})], ev=ev)}
        self.assertEqual(pb.probe_outcome_v3(r, self.RULE)[0], True)            # note -> fix 1, gate passes -> repair
        self.assertEqual(pb.probe_outcome_v3(r, self.RULE, use_a=False)[0], False)
        self.assertEqual(pb.probe_outcome_v3(r, dict(self.RULE, c_valid=pb.NEVER))[0], False)
        self.assertEqual(pb.probe_outcome_v3(r, self.RULE, repair="never")[0], False)

    def test_recipe_escalates_on_failing_selftest(self):
        tests_bad, tests_good = {"r8s0": [False], "r8s1": [True]}, {"r8s0": [True], "r8s1": [True]}
        r8 = [cand("r8", i, False, tests_bad) for i in range(3)] + [cand("r8", 3, True, tests_good)] + \
             [cand("r8", i, False, tests_bad) for i in range(4, 8)]
        r = rec(r8, [cand("pr", i, False) for i in range(3)])
        self.assertEqual(pb.recipe_outcome_v3(r, self.RULE)[0], True)
        self.assertEqual(pb.recipe_outcome_v3(r, self.RULE, use_c=False)[0], False)

    def test_route_v1_probe_band(self):
        # amendment 2026-10-08: no v3 rule fit the recipe's seconds on the pool, so v1's probe P is a third route,
        # taken when the hidden-code signal clears c_probe but P3's conditions fail
        rule = dict(self.RULE, c_probe=0.02)
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.2, library=0.1), rule), "P3")
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.05, library=0.1), rule), "P")
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.2, library=0.9), rule), "P")
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.01, library=0.1), rule), "R")
        self.assertEqual(pb.route_v3(dict(card(), hidden=0.05, library=0.1), self.RULE), "R")  # no c_probe: as specified

    def test_v1_route_outcome_and_ablation(self):
        tests = {"r8s0": [False], "r8s1": [False]}
        r = dict(rec([cand("r8", i, False, tests) for i in range(8)],
                     [cand("pr", 0, True)] + [cand("pr", i, False) for i in (1, 2)]), p3=p3([fix(False)]))
        c, rule = dict(card(), hidden=0.05, library=0.1), dict(self.RULE, c_probe=0.02)
        self.assertEqual(pb.outcome_v3(r, c, rule), pb.outcome(r, "P"))
        self.assertTrue(pb.outcome_v3(r, c, rule)[0])
        self.assertFalse(pb.outcome_v3(r, c, rule, dict(pb.FULL, v1_route=False))[0])

    def test_fit_takes_the_v1_route_when_only_it_fits(self):
        tests = {"r8s0": [False], "r8s1": [False]}
        recs = [dict(rec([cand("r8", i, False, tests) for i in range(8)],
                         [cand("pr", 0, True, secs=0.5)] + [cand("pr", i, False) for i in (1, 2)],
                         probe_secs=0.5, task=t), p3=p3([fix(False, secs=5.0)])) for t in ("a", "b")]
        cards = {t: dict(card(), hidden=0.05, library=0.1) for t in ("a", "b")}
        rule, solved, secs = pb.fit_v3(recs, cards, pb.fixed(recs, "R")[1])
        self.assertEqual((rule["c_probe"], solved), (0.05, 2))
        self.assertEqual({pb.route_v3(c, rule) for c in cards.values()}, {"P"})
        # the recipe settings do not change this score; the tie goes to the recipe's own best on the whole pool,
        # where escalating on failed self-tests (e_fail) only adds seconds
        self.assertFalse(rule["e_fail"])

    def test_tier2b_guard(self):
        pairs = [(f"t{i}", False, True) for i in range(6)]
        self.assertTrue(pb.tier2b_guard(pairs)["fails"])
        self.assertFalse(pb.tier2b_guard([(f"t{i}", True, True) for i in range(6)])["fails"])


if __name__ == "__main__":
    unittest.main()
