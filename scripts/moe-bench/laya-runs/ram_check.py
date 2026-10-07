"""RAM check for the Laya live runs (2026-10-06): the spec refuses to run unless 2 GB stays available with Qwen and
the Laya worker loaded together. On this PC llama-server's working set is mostly the memory-mapped model file,
which Windows does not count as available. This loads keep96 twice, with the default mmap and with
--load-mode none, and for each records the available RAM with Qwen alone and with Qwen + Laya, plus the answers to
a few fixed-seed prompts, so the two load modes can be checked for identical output.

usage: TIER2B_DIR=docs/benchmarks/laya-calib python ram_check.py --out OUT.json [--calib CALIB.json]
"""
import argparse
import json
import os
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import bestofn_tier2b as bon  # noqa: E402
import playbook_tier2b as pt  # noqa: E402
from bestofn_tier2b import TASKS, baseline_prompt  # noqa: E402


def session(name, extra, calib, logdir):
    os.environ["BON_EXTRA"] = json.dumps(extra)
    pt.start("qwen36keep96")
    log = open(logdir / f"ram-check-{name}.server.log", "w", encoding="utf-8", errors="replace")
    t0 = time.time()
    proc = bon.start_server(log)
    row = {"mode": name, "extra": extra, "load_s": round(time.time() - t0, 1)}
    try:
        answers = []
        for task in TASKS[:4]:
            for seed, temp in ((0, None), (1001, 0.7)):
                answers.append(bon.chat(baseline_prompt(task), seed, temp)[0])
        row["answers"] = answers
        row["avail_mb_qwen"] = pt.available_mb()
        lc = pt.LayaClient(calib)
        row["laya_up"] = not lc.dead
        time.sleep(5)
        row["avail_mb_qwen_laya"] = pt.available_mb()
        lc.close()
    finally:
        pt.stop(proc, log)
    print(f"{name}: load {row['load_s']} s; available {row.get('avail_mb_qwen')} MB with Qwen, "
          f"{row.get('avail_mb_qwen_laya')} MB with Qwen + Laya (worker up: {row.get('laya_up')})", flush=True)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--calib", default=str(HERE.parents[1] / "docs" / "benchmarks" / "laya-partner" / "identity-calib.json"))
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    rows = [session("mmap", [], a.calib, out.parent)]
    time.sleep(30)  # breathing room between multi-GB loads (C:'s NV2)
    rows.append(session("load-none", ["--load-mode", "none"], a.calib, out.parent))
    same = rows[0]["answers"] == rows[1]["answers"]
    res = {"rows": [{k: v for k, v in r.items() if k != "answers"} for r in rows],
           "identical_answers": same, "n_answers": len(rows[0]["answers"]),
           "differing": [i for i, (x, y) in enumerate(zip(rows[0]["answers"], rows[1]["answers"])) if x != y]}
    out.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(f"identical answers across load modes: {same} ({res['n_answers']} prompts; differing {res['differing']})")


if __name__ == "__main__":
    main()
