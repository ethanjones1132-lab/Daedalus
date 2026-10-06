"""Failure-targeted calibration text for the expert patch (adapters spec §3.1, 2026-10-05).

The full 256-expert Qwen3.6 answers every task in TIER2B_DIR (the calibration pool) once in single shot and once
by probe-then-fix (v1). Every turn is written in the model's own chat format. Hidden-package (B) tasks and the
probe transcripts are written twice. Standard-library source slices then make up about 20% of the text. The
held-out closeness modules (kl_eval.HELDOUT_MODULES) are never used.

usage: patch_calib.py --out-text calib.txt --out-rows rows.jsonl    (TIER2B_DIR = the pool)
"""
import argparse
import importlib
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import bestofn_tier2b as bon  # noqa: E402
import probe_tier2b as pt  # noqa: E402
from bestofn_tier2b import TASKS, baseline_prompt, extract_code, run_test  # noqa: E402
from kl_eval import HELDOUT_MODULES  # noqa: E402

SOURCE_MODULES = ["json.encoder", "json.decoder", "posixpath", "textwrap", "string", "shlex", "csv", "hashlib",
                  "base64", "statistics", "fractions", "tempfile", "shutil", "argparse", "dataclasses", "functools"]
END = "<|im_end|>\n"


def turn(prompt, answer):
    head = bon.post("/apply-template", {"messages": [{"role": "user", "content": prompt}],
                                        "chat_template_kwargs": {"enable_thinking": False}})["prompt"]
    return head + answer + END


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-text", required=True)
    ap.add_argument("--out-rows", required=True)
    a = ap.parse_args()
    assert not set(SOURCE_MODULES) & set(HELDOUT_MODULES)
    bon.CFG.update(bon.CONFIGS["qwen36full"], budget=0)
    rows_path = pathlib.Path(a.out_rows)
    done = {json.loads(l)["task"]: json.loads(l) for l in rows_path.read_text(encoding="utf-8").splitlines()} \
        if rows_path.exists() else {}
    log = open(rows_path.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    try:
        with rows_path.open("a", encoding="utf-8") as f:
            for task in TASKS:
                if task["name"] in done:
                    continue
                single, _ = bon.chat(baseline_prompt(task), 0)
                probe_text, _ = bon.chat(pt.probe_prompt(task), 30000)
                script = extract_code(probe_text)
                output = pt.run_probe(task, script)
                answer, _ = bon.chat(pt.fix_prompt(task, script, output), 0)
                ok, _ = pt.grade(task, extract_code(answer))
                row = {"task": task["name"], "category": task["category"], "trial": 0, "single": single,
                       "probe": script, "probe_output": output, "answer": answer, "ok": ok,
                       "text_single": turn(baseline_prompt(task), single),
                       "text_probe": turn(pt.probe_prompt(task), probe_text)
                                     + turn(pt.fix_prompt(task, script, output), answer)}
                f.write(json.dumps(row) + "\n")
                f.flush()
                done[task["name"]] = row
                print(f"{task['name']}: fix {'PASS' if ok else 'fail'}", flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
    parts = []
    for row in done.values():
        reps = 2 if row["category"] == "B" else 1
        parts += [row["text_single"]] * reps + [row["text_probe"]] * 2 * reps
    body = "".join(parts)
    src, budget = [], len(body) // 4  # source slices: about 20% of the final text
    for mod in SOURCE_MODULES:
        text = pathlib.Path(importlib.import_module(mod).__file__).read_text(encoding="utf-8")[:20000]
        src.append(text)
        if sum(map(len, src)) >= budget:
            break
    pathlib.Path(a.out_text).write_text(body + "\n".join(src), encoding="utf-8")
    print(f"calibration text: {len(body) + sum(map(len, src))} chars from {len(done)} tasks", flush=True)


if __name__ == "__main__":
    main()
