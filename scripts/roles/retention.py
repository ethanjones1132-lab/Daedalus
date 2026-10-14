"""Retention gate (spec section 4): tier2b single-shot and a 200-question general-knowledge subset, adapter loaded versus
the plain base; non-inferiority within 3 points. The subset is drawn once with a fixed seed and listed before any adapter runs.
usage:
  retention.py mmlu-subset --out docs/benchmarks/roles/mmlu-200.json         (run with Unsloth's Python: needs `datasets`)
  retention.py run --size 4B --name base|NAME [--lora X.gguf] --work DIR       (benchmark Python)"""
import argparse
import concurrent.futures
import json
import pathlib
import random
import re
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench", REPO / "scripts" / "benchmark-tier2b"):
    sys.path.insert(0, str(p))
SUBSET = REPO / "docs" / "benchmarks" / "roles" / "mmlu-200.json"
MARGIN = 0.03


def letter(text):
    m = re.search(r"\b([ABCD])\b", text.strip())
    return m.group(1) if m else None


def mmlu_prompt(q):
    body = "\n".join(f"{c}. {t}" for c, t in zip("ABCD", q["choices"]))
    return f"{q['question']}\n\n{body}\n\nAnswer with the letter of the correct option only."


def noninferior(adapter, base):
    return {"adapter": round(adapter, 4), "base": round(base, 4), "diff": round(adapter - base, 4),
            "passed": adapter >= base - MARGIN}


def make_subset(out):
    from datasets import load_dataset
    ds = load_dataset("cais/mmlu", "all", split="test")
    idx = sorted(random.Random(20261009).sample(range(len(ds)), 200))
    rows = [{"i": i, "subject": ds[i]["subject"], "question": ds[i]["question"], "choices": ds[i]["choices"],
             "answer": "ABCD"[ds[i]["answer"]]} for i in idx]
    pathlib.Path(out).write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print("wrote", out, len(rows))


def run_mmlu(server):
    rows = json.loads(SUBSET.read_text(encoding="utf-8"))

    def one(q):
        r = server.chat([{"role": "user", "content": mmlu_prompt(q)}], max_tokens=16, temperature=0)
        return letter(r["text"]) == q["answer"]
    with concurrent.futures.ThreadPoolExecutor(server.parallel) as ex:
        res = list(ex.map(one, rows))
    return sum(res) / len(res)


def run_tier2b(server, trials=3):
    import runbench2b
    import tasks

    def one(job):
        task, trial = job
        reply = server.chat([{"role": "user", "content": runbench2b.baseline_prompt(task)}], max_tokens=3000,
                            temperature=0.2, seed=trial)["text"]
        d = pathlib.Path(tempfile.mkdtemp(prefix="rt-"))
        runbench2b.seed(d, task)
        (d / task["entry"]).write_text(runbench2b.extract_code(reply), encoding="utf-8")
        return runbench2b.run_test(d, task["test"])[0]
    jobs = [(t, k) for t in tasks.TASKS for k in range(trials)]
    with concurrent.futures.ThreadPoolExecutor(server.parallel) as ex:
        res = list(ex.map(one, jobs))
    return sum(res) / len(res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["mmlu-subset", "run"])
    ap.add_argument("--out", default=str(SUBSET))
    ap.add_argument("--size", default="4B")
    ap.add_argument("--name", default="base")
    ap.add_argument("--lora", default="")
    ap.add_argument("--work", default="E:/AI/role-adapters/eval")
    a = ap.parse_args()
    if a.cmd == "mmlu-subset":
        return make_subset(a.out)
    import eval_roles
    import llama_server
    with llama_server.Server(eval_roles.BASES[a.size], lora=a.lora or None, log_path=f"{a.work}/{a.size}-ret-server.log") as s:
        res = {"size": a.size, "name": a.name, "mmlu200": run_mmlu(s), "tier2b": run_tier2b(s)}
    out = pathlib.Path(a.work) / a.size / f"retention-{a.name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
