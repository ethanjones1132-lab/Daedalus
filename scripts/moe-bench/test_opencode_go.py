import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import opencode_go as og  # noqa: E402


class OpenCodeGoTest(unittest.TestCase):
    def test_pick_model_prefers_newest_flash(self):
        self.assertEqual(og.pick_model(["kimi-k2", "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-pro"]),
                         "deepseek-v4.1-flash")
        self.assertEqual(og.pick_model(["deepseek-v4-flash", "glm-5"]), "deepseek-v4-flash")
        with self.assertRaises(LookupError):
            og.pick_model(["glm-5"])

    def test_extract_json(self):
        self.assertEqual(og.extract_json('```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(og.extract_json('Here: {"a": {"b": 2}} done'), {"a": {"b": 2}})
        self.assertIsNone(og.extract_json("no json here"))

    def test_key_is_read_not_echoed(self):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / "auth.json").write_text(json.dumps({"opencode-go": {"type": "api", "key": "sk-test"}}), encoding="utf-8")
        self.assertEqual(og.read_key(d / "auth.json"), "sk-test")
        self.assertNotIn("sk-test", repr(og.Client(key="sk-test", model="m")))


if __name__ == "__main__":
    unittest.main()
