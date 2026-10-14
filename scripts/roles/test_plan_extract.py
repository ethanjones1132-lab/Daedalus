import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import plan_extract  # noqa: E402

FENCE = "`" * 3


class ExtractTest(unittest.TestCase):
    def test_blocks(self):
        text = f"intro\n{FENCE}python file=a/b.py\nx = 1\ny = 2\n{FENCE}\n\n{FENCE}bash\necho hi\n{FENCE}\n"
        self.assertEqual(plan_extract.blocks(text), {"a/b.py": "x = 1\ny = 2\n"})


if __name__ == "__main__":
    unittest.main()
