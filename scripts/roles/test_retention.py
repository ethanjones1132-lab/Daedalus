import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import retention  # noqa: E402


class RetentionTest(unittest.TestCase):
    def test_letter_parsing(self):
        self.assertEqual(retention.letter("B"), "B")
        self.assertEqual(retention.letter("The answer is C."), "C")
        self.assertEqual(retention.letter("(D) because"), "D")
        self.assertIsNone(retention.letter("no idea"))

    def test_prompt_lists_four_choices(self):
        q = {"question": "Q?", "choices": ["w", "x", "y", "z"]}
        text = retention.mmlu_prompt(q)
        for line in ("A. w", "B. x", "C. y", "D. z"):
            self.assertIn(line, text)

    def test_noninferiority(self):
        self.assertTrue(retention.noninferior(0.60, 0.62)["passed"])
        self.assertFalse(retention.noninferior(0.55, 0.62)["passed"])


if __name__ == "__main__":
    unittest.main()
