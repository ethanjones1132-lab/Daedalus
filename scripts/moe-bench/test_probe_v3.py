import os
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("TIER2B_DIR", str(HERE.parents[1] / "scripts" / "benchmark-tier2b"))
import laya_v3_text as lt  # noqa: E402


class TextTest(unittest.TestCase):
    def test_options_and_notes(self):
        self.assertIn("none", lt.EVIDENCE_OPTIONS)
        self.assertEqual(set(lt.NOTE_PHRASES), set(lt.EVIDENCE_OPTIONS) - {"none"})
        self.assertEqual(lt.note_text("scale"),
                         "Note: the probe output suggests the helper's units or scale differ from what the entry file "
                         "assumes.")

    def test_states_are_capped(self):
        s = lt.evidence_state("req", "x" * 5000, "y" * 5000)
        self.assertLess(len(s), 2000)
        self.assertIn("Requirement: req", s)
        self.assertEqual(lt.valid_state("req", "from m import f", "assert f(1) == 2"),
                         "Requirement: req\n\nCheck:\nfrom m import f\nassert f(1) == 2")


import probe_v3 as pv  # noqa: E402

TASK = dict(name="t_demo", category="B", entry="calc.py", hidden_file="units.py",
            files={"units.py": "def grams(x):\n    return x * 1000\n",
                   "calc.py": "from units import grams\n\n\ndef kg(x):\n    return grams(x)\n"},
            spec="kg(2) returns 2000, but 2 kilograms is 2.", test="from calc import kg\nassert kg(2) == 2\n",
            reference="from units import grams\n\n\ndef kg(x):\n    return grams(x) / 1000\n")


class ProbeV3Test(unittest.TestCase):
    def test_probe_prompt_names_the_helper(self):
        p = pv.probe_prompt_v3(TASK)
        self.assertIn("units", p)
        self.assertIn("type(result).__name__", p)
        self.assertIn("Do not call calc.py's own functions", p)

    def test_fix_prompt_note_first(self):
        p = pv.fix_prompt_v3(TASK, "print(1)", "1", "Note: X.")
        self.assertTrue(p.startswith("Note: X.\n\n"))
        self.assertNotIn("Note:", pv.fix_prompt_v3(TASK, "print(1)", "1", None))

    def test_example_prompt_shows_the_names_to_call(self):
        # 2026-10-08 smoke run: without the file, Qwen guessed function names (run_length_encode for rle_encode),
        # so every example assert failed with ImportError, even on the reference
        p = pv.example_prompt(TASK)
        self.assertIn("def kg(x)", p)
        self.assertIn("only from concrete examples the text states", p)

    def test_split_asserts(self):
        imports, asserts = pv.split_asserts("from calc import kg\nimport math\nassert kg(2) == 2\nx = 1\n"
                                            "assert kg(0) == 0, 'zero'\n")
        self.assertEqual(imports, "from calc import kg\nimport math")
        self.assertEqual(asserts, ["assert kg(2) == 2", "assert kg(0) == 0, 'zero'"])
        self.assertEqual(pv.split_asserts("not python ("), ("", []))

    def test_run_asserts_on_reference_and_buggy(self):
        imports, asserts = "from calc import kg", ["assert kg(2) == 2", "assert kg(0) == 0"]
        self.assertEqual([ok for ok, _ in pv.run_asserts(TASK, TASK["reference"], imports, asserts)], [True, True])
        res = pv.run_asserts(TASK, TASK["files"]["calc.py"], imports, asserts)
        self.assertEqual([ok for ok, _ in res], [False, True])
        self.assertIn("AssertionError", res[0][1])


if __name__ == "__main__":
    unittest.main()
