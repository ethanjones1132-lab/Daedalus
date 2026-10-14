import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import exclude  # noqa: E402


class ExcludeTest(unittest.TestCase):
    def test_lab_terms_hit(self):
        self.assertIn("term", exclude.lab_hit("Simulate rabbits and foxes moving on a grid."))

    def test_phrase_hit(self):
        self.assertIn("phrase", exclude.lab_hit("A study of population dynamics over time."))

    def test_unrelated_request_is_clean(self):
        self.assertIsNone(exclude.lab_hit(
            "A command-line tool that converts CSV files to Markdown tables, aligning columns and escaping pipes."))

    def test_copy_of_the_lab_prompt_hits(self):
        text = exclude.LAB_PROMPT.read_text(encoding="utf-8")[:1500]
        self.assertIsNotNone(exclude.lab_hit(text))


if __name__ == "__main__":
    unittest.main()
