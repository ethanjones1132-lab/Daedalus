import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import train_lora  # noqa: E402

MSGS = [{"role": "system", "content": "S"}, {"role": "user", "content": "Write add."},
        {"role": "assistant", "content": "def add(a, b):\n    return a + b\n"}]


class EncodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from transformers import AutoTokenizer
        try:
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3-0.6B")
        except Exception as e:  # not cached: skip rather than fail
            raise unittest.SkipTest(f"tokenizer unavailable: {e}")

    def test_loss_only_on_the_reply(self):
        e = train_lora.encode(self.tok, MSGS, 4096)
        ids, labels = e["input_ids"], e["labels"]
        self.assertEqual(len(ids), len(labels))
        self.assertGreater(sum(1 for x in labels if x == -100), 5)
        reply_ids = [x for x in labels if x != -100]
        text = self.tok.decode(reply_ids)
        self.assertIn("return a + b", text)
        self.assertTrue(text.endswith(self.tok.eos_token))

    def test_prompt_matches_the_thinking_off_template(self):
        e = train_lora.encode(self.tok, MSGS, 4096)
        prompt = self.tok.apply_chat_template(MSGS[:-1], tokenize=False, add_generation_prompt=True,
                                              enable_thinking=False)
        n_prompt = sum(1 for x in e["labels"] if x == -100)
        self.assertEqual(self.tok.decode(e["input_ids"][:n_prompt]), prompt)

    def test_too_long_is_dropped(self):
        self.assertIsNone(train_lora.encode(self.tok, MSGS, 10))


class ScheduleTest(unittest.TestCase):
    def test_cosine_schedule_endpoints(self):
        self.assertAlmostEqual(train_lora.lr_at(0, 100, 1e-4, 5), 1e-4 / 5, places=9)
        self.assertAlmostEqual(train_lora.lr_at(99, 100, 1e-4, 5), 1e-5, delta=2e-6)


if __name__ == "__main__":
    unittest.main()
