"""Gates 2.5 and 2.6, the served half (plan 2026-10-06-adapters-phase2.md, Task 2): the GGUF LoRA from
modal_distill.py's overfit gate must load in the local llama.cpp (836d571) with --lora, change the output, and
reproduce the overfit set: mean greedy similarity to the targets >= 0.95 (difflib ratio on the text).

usage: served_lora_check.py --lora overfit-lora.gguf --rows calib-answers.jsonl [--n 20] [--out report.json]
       (TIER2B_DIR = any task set; keep96 is served with bestofn_tier2b's settings)
"""
import argparse
import difflib
import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import bestofn_tier2b as bon  # noqa: E402


def examples(rows, n):
    ex = []
    for line in open(rows, encoding="utf-8"):
        r = json.loads(line)
        head, sep, rest = r["text_single"].rpartition("</think>\n\n")
        ex.append((head + sep, rest.removesuffix("\n").removesuffix("<|im_end|>")))
        if len(ex) == n:
            break
    return ex


def run(ex, lora, log):
    os.environ["BON_EXTRA"] = json.dumps(["--lora", lora] if lora else [])
    proc = bon.start_server(log)
    try:
        out = []
        for prompt, target in ex:
            r = bon.post("/completion", {"prompt": prompt, "n_predict": 1536, "temperature": 0, "top_k": 1,
                                         "cache_prompt": False, "seed": 0})
            out.append(round(difflib.SequenceMatcher(None, r["content"], target).ratio(), 4))
        return out
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lora", required=True)
    ap.add_argument("--rows", required=True)
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    bon.CFG.update(bon.CONFIGS["qwen36keep96"], budget=0)
    ex = examples(a.rows, a.n)
    log = open(pathlib.Path(a.lora).with_suffix(".server.log"), "w", encoding="utf-8", errors="replace")
    base = run(ex, "", log)
    with_lora = run(ex, a.lora, log)
    log.close()
    mean = lambda v: round(sum(v) / len(v), 4)  # noqa: E731
    res = {"examples": len(ex), "similarity_base": mean(base), "similarity_lora": mean(with_lora),
           "changed": with_lora != base, "pass": mean(with_lora) >= 0.95 and with_lora != base,
           "per_example": {"base": base, "lora": with_lora}}
    print(json.dumps(res, indent=1))
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(res, indent=1))
    sys.exit(0 if res["pass"] else 1)


if __name__ == "__main__":
    main()
