import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import moe_sweep  # noqa: E402


class ServerCmdTest(unittest.TestCase):
    def test_cache_type_and_window(self):
        args = moe_sweep.server_cmd("m.gguf", 0, 2, 65536, 512, None, "q4_0")
        self.assertEqual(args[args.index("-c") + 1], "65536")
        self.assertEqual(args[args.index("-ctk") + 1], "q4_0")
        self.assertEqual(args[args.index("-ctv") + 1], "q4_0")

    def test_default_is_q8(self):
        args = moe_sweep.server_cmd("m.gguf", 0, 2, 16384, 512, None)
        self.assertEqual(args[args.index("-ctk") + 1], "q8_0")


import speed_pair as sp  # noqa: E402


def grow(ctx, ub, tps, spill, ctk="q8_0", deep_gen=100.0):
    return {"tag": f"c{ctx}u{ub}{ctk}", "ctx": ctx, "ubatch": ub, "ctk": ctk, "shared_spill_mib": spill,
            "vram_delta_mib_peak": 6000,
            "runs": [{"prompt": "gen#0", "gen_tps": tps}, {"prompt": "edit2k#0", "gen_tps": 2 * tps},
                     {"prompt": "deep54k", "gen_tps": deep_gen, "prompt_tps": 900}]}


class GridTest(unittest.TestCase):
    rows = [grow(16384, 512, 100, 200), grow(65536, 512, 97, 250), grow(98304, 512, 90, 200),
            grow(131072, 512, 100, 900)]

    def test_deep_for(self):
        self.assertEqual(sp.deep_for(16384), [])
        self.assertEqual(sp.deep_for(32768), [26000])
        self.assertEqual(sp.deep_for(65536), [26000, 54000])
        self.assertEqual(sp.deep_for(98304), [26000, 54000, 80000])
        self.assertEqual(sp.deep_for(131072), [26000, 54000, 80000, 108000])

    def test_deep_prompt(self):
        name, content, max_tokens = sp.deep_prompt(26000)
        self.assertEqual((name, max_tokens), ("deep26k", 300))
        self.assertLess(abs(len(content) - 26000 * sp.CHARS_PER_TOKEN), 200)
        self.assertTrue(content.endswith("with a one-line description of each."))

    def test_grid_prompt_names(self):
        self.assertEqual([n for n, _, _ in sp.grid_prompts(65536)],
                         ["gen#0", "edit2k#0", "gen#1", "edit2k#1", "gen#2", "edit2k#2", "long10k",
                          "deep26k", "deep54k"])

    def test_verdict(self):
        # 2026-10-07 deviation: the shared-memory counter grows with the window at unchanged speed, so overflow is
        # judged by speed: the same deep prompt within 5% of the smallest q8_0 ub-512 window that ran it
        v = sp.verdict(self.rows + [grow(131072, 512, 99, 210, "q4_0", deep_gen=50.0)])
        self.assertEqual([r["pass"] for r in v["rows"]], [True, True, False, True, False])
        self.assertEqual(v["ctk"], {"16384": "q8_0", "65536": "q8_0", "131072": "q8_0"})
        self.assertEqual(v["largest_pass"], 131072)
        self.assertEqual(v["rows"][4]["depth_ratio"], 0.5)

    def test_a_slower_deep_prompt_fails_the_row(self):
        v = sp.verdict([self.rows[0], self.rows[1], grow(98304, 512, 100, 200, deep_gen=94.0)])
        self.assertEqual([r["pass"] for r in v["rows"]], [True, True, False])

    def test_a_failed_prompt_fails_the_row(self):
        bad = grow(32768, 512, 100, 200)
        bad["runs"][0] = {"prompt": "gen#0", "error": "HTTPError"}
        self.assertFalse(sp.verdict([self.rows[0], bad])["rows"][1]["pass"])

    def test_extra_and_top_rows(self):
        self.assertEqual(sp.extra_rows(self.rows), [(98304, 512, "q4_0")])
        self.assertEqual(sp.top_row(self.rows), [(131072, 1024, "q8_0")])
        self.assertEqual(sp.top_row(self.rows[:2]), [])


if __name__ == "__main__":
    unittest.main()
