"""QLoRA SFT for one role adapter (spec section 3). Loss on the assistant reply only; the prompt is rendered the way
llama-server renders it with thinking off. Runs in Unsloth Studio's Python.
usage: train_lora.py --model E:/AI/role-adapters/models/Qwen3.5-4B --train build-train.jsonl --dev build-dev.jsonl
                     --out E:/AI/role-adapters/runs/4B-S-build [--epochs 2] [--lr 1e-4] [--rank 16] [--max-len 4096]"""
import argparse
import json
import math
import pathlib
import random
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


def encode(tok, messages, max_len):
    """{input_ids, labels} with -100 on the prompt, or None if longer than max_len (dropped, not truncated)."""
    prompt = tok.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    reply = messages[-1]["content"] + tok.eos_token
    p = tok(prompt, add_special_tokens=False)["input_ids"]
    r = tok(reply, add_special_tokens=False)["input_ids"]
    if len(p) + len(r) > max_len:
        return None
    return {"input_ids": p + r, "labels": [-100] * len(p) + r}


def lr_at(step, total, peak, warmup):
    """Linear warmup then cosine decay to 10% of the peak."""
    if step < warmup:
        return peak * (step + 1) / warmup
    frac = (step - warmup) / max(1, total - warmup - 1)
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, frac))))


def load_rows(path, tok, max_len, cap=None):
    rows = [json.loads(line) for line in open(path, encoding="utf-8")]
    enc = [encode(tok, r["messages"], max_len) for r in rows]
    kept = [e for e in enc if e]
    return (kept[:cap] if cap else kept), len(enc) - len(kept)


def train(a):
    import torch
    from transformers import AutoTokenizer
    import qlora_common

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(a.model)
    train_rows, dropped = load_rows(a.train, tok, a.max_len)
    dev_rows, _ = load_rows(a.dev, tok, a.max_len, a.dev_cap)
    model = qlora_common.load_qlora(a.model, a.targets, a.rank)
    model.print_trainable_parameters()
    head = qlora_common.swap_head(model)
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0, betas=(0.9, 0.99))
    per_epoch = math.ceil(len(train_rows) / a.accum)
    total = min(per_epoch * a.epochs, a.max_steps) if a.max_steps else per_epoch * a.epochs
    warmup = max(1, int(0.05 * total))

    def tensors(row):
        return (torch.tensor([row["input_ids"]], device="cuda"), torch.tensor([row["labels"]], device="cuda"))

    @torch.no_grad()
    def dev_loss():
        model.eval()
        tot, n = 0.0, 0
        for row in dev_rows:
            ids, lab = tensors(row)
            loss, k = qlora_common.reply_loss(model, head, ids, lab)
            tot += loss.item() * k
            n += k
        model.train()
        return tot / max(1, n)

    log = open(out / "log.jsonl", "a", encoding="utf-8")
    rng, step, best, stale, t0, toks = random.Random(a.seed), 0, (float("inf"), None), 0, time.time(), 0
    model.train()
    done = False
    for epoch in range(a.epochs):
        order = list(range(len(train_rows)))
        rng.shuffle(order)
        for k in range(0, len(order), a.accum):
            group = order[k:k + a.accum]
            ntok = sum(sum(1 for x in train_rows[i]["labels"] if x != -100) for i in group)
            loss_sum = 0.0
            for i in group:
                ids, lab = tensors(train_rows[i])
                loss, n = qlora_common.reply_loss(model, head, ids, lab)
                (loss * n / ntok).backward()
                loss_sum += loss.item() * n
                toks += ids.numel()
            for g in opt.param_groups:
                g["lr"] = lr_at(step, total, a.lr, warmup)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            rec = {"step": step, "epoch": epoch, "loss": round(loss_sum / ntok, 4), "lr": opt.param_groups[0]["lr"],
                   "tok_s": round(toks / (time.time() - t0)),
                   "vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}
            if step % a.eval_every == 0 or step >= total:
                rec["dev_loss"] = round(dev_loss(), 4)
                model.save_pretrained(out / f"step{step}")
                if rec["dev_loss"] < best[0]:
                    best, stale = (rec["dev_loss"], f"step{step}"), 0
                else:
                    stale += 1
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(json.dumps(rec), flush=True)
            if step >= total or stale >= a.patience:
                done = True
                break
        if done:
            break
    model.save_pretrained(out / "final")
    (out / "summary.json").write_text(json.dumps({
        "train_examples": len(train_rows), "dropped_too_long": dropped, "dev_examples": len(dev_rows), "steps": step,
        "best_dev_loss": best[0], "best": best[1], "final": "final", "args": vars(a),
        "secs": round(time.time() - t0), "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}, indent=1),
        encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--accum", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=4096)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--eval-every", type=int, default=20)
    ap.add_argument("--dev-cap", type=int, default=100)
    ap.add_argument("--patience", type=int, default=3)
    ap.add_argument("--targets", choices=["all-linear", "attn-mlp"], default="all-linear")
    ap.add_argument("--seed", type=int, default=0)
    train(ap.parse_args())


if __name__ == "__main__":
    main()
