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


if __name__ == "__main__":
    unittest.main()
