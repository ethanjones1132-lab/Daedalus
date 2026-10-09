import os
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
os.environ.setdefault("TIER2B_DIR", str(HERE.parents[1] / "docs" / "benchmarks" / "laya-calib"))
sys.path.insert(0, str(HERE))
import headroom_iq3 as h  # noqa: E402


def row(**kw):
    base = {"fit_ok": True, "short_gen_tps": [30, 31], "deep": {"gen_tps": 27.0}, "followup": {"first": {}}}
    base.update(kw)
    return base


def laya(**kw):
    base = {"ram_after_load_mb": 2500, "ok": 20, "dead": False, "p95_s": 1.0}
    base.update(kw)
    return base


class VerdictTest(unittest.TestCase):
    def test_passes(self):
        v = h.window_verdict(row(laya={"int8": laya()}))
        self.assertTrue(v["none"]["pass"] and v["int8"]["pass"])
        self.assertEqual(v["int8"]["tier"], "base")

    def test_fallback_tier_between_1024_and_2048(self):
        v = h.window_verdict(row(laya={"fp32": laya(ram_after_load_mb=1500)}))
        self.assertTrue(v["fp32"]["pass"])
        self.assertEqual(v["fp32"]["tier"], "fallback")

    def test_ram_below_fallback_fails(self):
        v = h.window_verdict(row(laya={"fp32": laya(ram_after_load_mb=900)}))
        self.assertFalse(v["fp32"]["pass"])
        self.assertTrue(v["none"]["pass"])

    def test_slow_deep_generation_fails_everything(self):
        v = h.window_verdict(row(deep={"gen_tps": 20.0}, laya={"int8": laya()}))
        self.assertFalse(v["none"]["pass"] or v["int8"]["pass"])

    def test_laya_timeout_or_slow_p95_fails(self):
        self.assertFalse(h.window_verdict(row(laya={"int8": laya(ok=19, dead=True)}))["int8"]["pass"])
        self.assertFalse(h.window_verdict(row(laya={"int8": laya(p95_s=5.0)}))["int8"]["pass"])

    def test_deep_prompt_size(self):
        self.assertEqual(h.deep_tokens(16384), 13926)
        self.assertEqual(h.deep_tokens(131072), 108000)


if __name__ == "__main__":
    unittest.main()
