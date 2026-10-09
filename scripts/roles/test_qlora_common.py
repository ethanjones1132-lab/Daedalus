import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import qlora_common  # noqa: E402


class ReplyLossTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        try:
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3-0.6B")
            cls.model = AutoModelForCausalLM.from_pretrained("Qwen/Qwen3-0.6B", dtype=torch.float32)
        except Exception as e:  # not cached: skip rather than fail
            raise unittest.SkipTest(f"Qwen3-0.6B unavailable: {e}")
        cls.model.eval()

    def test_matches_the_full_loss_on_the_reply_tokens(self):
        import torch
        ids = self.tok("Write add.\nA: def add(a, b): return a + b", return_tensors="pt")["input_ids"]
        labels = ids.clone()
        labels[0, :6] = -100
        full = self.model(input_ids=ids, labels=labels).loss.item()
        head = qlora_common.swap_head(self.model)
        with torch.no_grad():
            loss, n = qlora_common.reply_loss(self.model, head, ids, labels, chunk=4)
        self.assertEqual(n, int((labels[0, 1:] != -100).sum()))
        self.assertAlmostEqual(loss.item(), full, places=3)


if __name__ == "__main__":
    unittest.main()
