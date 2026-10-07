import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import laya_calibrate as lc  # noqa: E402


class CalibrateTest(unittest.TestCase):
    def test_auc(self):
        self.assertEqual(lc.auc([0.9, 0.8], [0.1, 0.2]), 1.0)
        self.assertEqual(lc.auc([0.1], [0.9]), 0.0)
        self.assertEqual(lc.auc([0.5], [0.5]), 0.5)

    def test_ece(self):
        self.assertAlmostEqual(lc.ece([1.0, 1.0], [0, 0]), 1.0)
        self.assertAlmostEqual(lc.ece([0.25] * 4, [1, 0, 0, 0]), 0.0)

    def test_platt_pulls_overconfidence_to_the_base_rate(self):
        probs, labels = [0.9] * 40, [1, 0] * 20
        ab = lc.platt_fit(probs, labels)
        self.assertAlmostEqual(lc.platt_apply(0.9, ab), 0.5, delta=0.05)

    def test_platt_keeps_order(self):
        probs = [0.1, 0.2, 0.3, 0.6, 0.7, 0.8] * 5
        labels = [0, 0, 1, 0, 1, 1] * 5
        ab = lc.platt_fit(probs, labels)
        self.assertLess(lc.platt_apply(0.2, ab), lc.platt_apply(0.7, ab))

    def test_platt_apply_none(self):
        self.assertIsNone(lc.platt_apply(None, [1.0, 0.0]))

    def test_identity_card(self):
        raw = {"kind": "unseen", "kind_p": {}, "unseen": 0.7, "effort_p": [0.2, 0.3, 0.5]}
        card = lc.calibrate_card(raw, lc.IDENTITY["platt"])
        self.assertEqual(card["kind"], "unseen")
        self.assertAlmostEqual(card["unseen"], 0.7, places=3)
        self.assertAlmostEqual(card["p_little"], 0.2, places=3)
        self.assertAlmostEqual(card["p_alot"], 0.5, places=3)
        self.assertEqual(card["effort_top"], 2)

    def test_hidden_signal_on_the_card(self):
        raw = {"kind": "library", "kind_p": {"unseen": 0.2, "library": 0.7}, "unseen": 0.9,
               "effort_p": [0.5, 0.3, 0.2]}
        self.assertEqual(lc.calibrate_card(raw, lc.IDENTITY["platt"])["hidden"], 0.9)
        self.assertEqual(lc.calibrate_card(raw, lc.IDENTITY["platt"], "kind_p")["hidden"], 0.2)

    def test_hidden_report_scores_the_rule_signal(self):
        cards = {"b": {"kind_p": {"unseen": 0.4}, "unseen": 0.1}, "a": {"kind_p": {"unseen": 0.1}, "unseen": 0.9}}
        cats = {"b": "B", "a": "A"}
        self.assertEqual(lc.hidden_report(cards, cats, "kind_p"),
                         {"signal": "kind_p", "n": 2, "positives": 1, "auc": 1.0})
        self.assertEqual(lc.hidden_report(cards, cats, "noul")["auc"], 0.0)

    def test_hidden_aucs_pick_the_separating_signal(self):
        def raw(ku, nu):
            return {"kind": "library", "kind_p": {"unseen": ku}, "unseen": nu, "effort_p": [0.4, 0.3, 0.3]}
        cats = {"b1": "B", "b2": "B", "e1": "E", "a1": "A"}
        labels = [{"type": "card", "task": t, "wording": "v1", "card": raw(*v)}
                  for t, v in {"b1": (0.3, 0.5), "b2": (0.4, 0.4), "e1": (0.1, 0.9), "a1": (0.05, 0.6)}.items()]
        aucs = lc.hidden_aucs(labels, cats, wordings=("v1",))
        self.assertEqual(aucs[("v1", "kind_p")], 1.0)
        self.assertLess(aucs[("v1", "noul")], 0.5)
        self.assertEqual(max(aucs, key=aucs.get), ("v1", "kind_p"))


if __name__ == "__main__":
    unittest.main()
