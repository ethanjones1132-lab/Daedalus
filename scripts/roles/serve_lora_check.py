"""Gate 2b (spec section 3): a LoRA trained on the HF weights, converted to GGUF, must load in llama-server, change the
output and reproduce its training targets (mean difflib similarity >= 0.9 on greedy replies).
usage: serve_lora_check.py --base-gguf X.gguf --lora Y.gguf --samples tiny.jsonl [--n 8] [--out report.json]"""
import argparse
import difflib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import llama_server  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-gguf", required=True)
    ap.add_argument("--lora", required=True)
    ap.add_argument("--samples", required=True)
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    rows = [json.loads(line) for line in open(a.samples, encoding="utf-8")][:a.n]
    report = {"n": len(rows)}
    for tag, lora in (("base", None), ("lora", a.lora)):
        with llama_server.Server(a.base_gguf, lora=lora, parallel=1, slot_ctx=8192) as s:
            sims = []
            for r in rows:
                reply = s.chat(r["messages"][:-1], max_tokens=3000, temperature=0)["text"]
                sims.append(difflib.SequenceMatcher(None, reply, r["messages"][-1]["content"]).ratio())
        report[tag] = round(sum(sims) / len(sims), 3)
    report["pass"] = report["lora"] >= 0.9 and report["lora"] > report["base"] + 0.1
    print(json.dumps(report, indent=1))
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
