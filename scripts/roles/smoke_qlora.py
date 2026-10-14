"""Smoke test (spec section 3): can a QLoRA step run at the given sequence lengths within about 7.5 GB and 400 tokens/s?
Runs in Unsloth Studio's Python. usage: smoke_qlora.py --model DIR [--seqs 4096,8192,12288] [--steps 3] [--targets all-linear|attn-mlp]"""
import argparse
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


def has(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--seqs", default="4096")
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--targets", default="all-linear")
    a = ap.parse_args()
    import torch
    import transformers
    import qlora_common

    t0 = time.time()
    model = qlora_common.load_qlora(a.model, a.targets, 16)
    load_s = time.time() - t0
    head = qlora_common.swap_head(model)
    model.train()  # gradient checkpointing is only active in train mode
    names = sorted({n.split(".")[-1] for n, m in model.named_modules() if hasattr(m, "lora_A") and "lora_A" not in n})
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-4)
    report = {"model": a.model, "transformers": transformers.__version__, "torch": torch.__version__,
              "fla": has("fla"), "causal_conv1d": has("causal_conv1d"), "load_s": round(load_s, 1),
              "lora_target_modules": names, "runs": []}
    for seq in (int(x) for x in a.seqs.split(",")):
        ids = torch.randint(1000, 20000, (1, seq), device="cuda")
        labels = ids.clone()
        labels[0, : int(seq * 0.4)] = -100  # a realistic split: the reply is the last 60%
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        secs = []
        try:
            for _ in range(a.steps):
                torch.cuda.synchronize()
                t = time.time()
                loss, _ = qlora_common.reply_loss(model, head, ids, labels)
                loss.backward()
                opt.step()
                opt.zero_grad(set_to_none=True)
                torch.cuda.synchronize()
                secs.append(time.time() - t)
            steady = secs[1:] or secs
            tok_s = seq / (sum(steady) / len(steady))
            peak = torch.cuda.max_memory_allocated() / 2**30
            report["runs"].append({"seq": seq, "step_secs": [round(s, 2) for s in secs], "tok_s": round(tok_s),
                                   "peak_vram_gb": round(peak, 2), "pass": peak <= 7.5 and tok_s >= 400})
        except torch.OutOfMemoryError as e:
            report["runs"].append({"seq": seq, "error": "out of memory", "pass": False})
            opt.zero_grad(set_to_none=True)
        print(json.dumps(report["runs"][-1]), flush=True)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
