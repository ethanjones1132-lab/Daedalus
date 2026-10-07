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


if __name__ == "__main__":
    unittest.main()
