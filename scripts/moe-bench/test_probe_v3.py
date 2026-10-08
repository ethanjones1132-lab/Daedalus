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


if __name__ == "__main__":
    unittest.main()
