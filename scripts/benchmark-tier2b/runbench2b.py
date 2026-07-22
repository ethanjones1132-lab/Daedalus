"""Run and score Tier-2B baseline or live Jarvis architecture samples.

Live inference is opt-in with ``--live`` (or JARVIS_BENCHMARK_LIVE=1).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

from tasks import K, TASKS

ROOT = Path(__file__).resolve().parent


def extract_code(text):
    blocks = re.findall(r"```(?:python)?\s*(.*?)```", text, re.DOTALL)
    if blocks:
        return max(blocks, key=len).strip()
    for marker in ("def ", "class "):
        index = text.find(marker)
        if index >= 0:
            return text[index:].strip()
    return text.strip()


def run_test(directory, source):
    test_path = directory / "_t.py"
    test_path.write_text(source, encoding="utf-8")
    try:
        result = subprocess.run(
            [sys.executable, str(test_path)], cwd=directory,
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        return False, "test timeout"
    if result.returncode == 0:
        return True, "ok"
    detail = (result.stderr.strip().splitlines() or result.stdout.strip().splitlines() or ["?"])[-1]
    return False, detail[:240]


def seed(directory, task):
    for name, content in task["files"].items():
        (directory / name).write_text(content, encoding="utf-8")


def baseline_prompt(task):
    entry = task["entry"]
    if task["category"] == "B":
        visible = task["files"][entry]
        return (f"Fix {entry} in a small Python package. The package also has "
                f"{task['hidden_file']}, but its source is unavailable and only "
                f"{entry} may be changed. Bug report: {task['spec']}\n\n"
                f"```python\n{visible}```\nReturn only the complete corrected file.")
    return (f"Fix {entry}.\n\n```python\n{task['files'][entry]}```\n\n"
            f"Requirement: {task['spec']}\nReturn only the complete corrected file.")


def architecture_prompt(task, directory):
    package = "small Python package" if task["category"] == "B" else f"file {task['entry']}"
    return (f"In {directory} there is a {package} with a bug. Requirement: "
            f"{task['spec']} Read the files, fix the bug in place with an "
            "edit/write tool, and run the adjacent _t.py test before finishing.")


def run_baseline(task, sample, live):
    if not live:
        return None, "not run", 0.0
    prompt_path = ROOT / f".prompt-{task['name']}-{sample}.txt"
    out_path = ROOT / f".out-{task['name']}-{sample}.json"
    prompt_path.write_text(baseline_prompt(task), encoding="utf-8")
    try:
        result = subprocess.run(
            ["bun", str(ROOT / "baseline_call.mjs"), str(prompt_path), str(out_path)],
            cwd=ROOT, capture_output=True, text=True, timeout=200,
        )
        if result.returncode:
            return False, result.stderr[-240:], 0.0
        response = json.loads(out_path.read_text(encoding="utf-8"))
        if response.get("error"):
            return False, response["error"][:240], response.get("secs", 0.0)
        with tempfile.TemporaryDirectory(prefix=f"tier2b-base-{task['name']}-") as raw:
            directory = Path(raw)
            seed(directory, task)
            (directory / task["entry"]).write_text(extract_code(response["content"]), encoding="utf-8")
            ok, detail = run_test(directory, task["test"])
        return ok, detail, response.get("secs", 0.0)
    finally:
        prompt_path.unlink(missing_ok=True)
        out_path.unlink(missing_ok=True)


def run_architecture(task, sample, stream_url, live):
    if not live:
        return None, "not run", 0.0
    with tempfile.TemporaryDirectory(prefix=f"tier2b-arch-{task['name']}-") as raw:
        directory = Path(raw)
        seed(directory, task)
        body = json.dumps({
            "message": architecture_prompt(task, directory),
            "session_id": f"tier2b-{task['name']}-{sample}-{uuid.uuid4().hex[:8]}",
            "surface": "chat",
        }).encode()
        started = time.monotonic()
        try:
            request = urllib.request.Request(stream_url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=480) as response:
                for _ in response:
                    pass
        except Exception as exc:
            return False, f"stream error: {exc}"[:240], round(time.monotonic() - started, 1)
        ok, detail = run_test(directory, task["test"])
        return ok, detail, round(time.monotonic() - started, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", choices=("baseline", "architecture", "both"), default="both")
    parser.add_argument("--k", type=int, default=K)
    parser.add_argument("--stream-url", default="http://127.0.0.1:19877/chat/stream")
    parser.add_argument("--live", action="store_true", help="permit inference calls")
    args = parser.parse_args()
    live = args.live or os.environ.get("JARVIS_BENCHMARK_LIVE") == "1"
    if not live:
        print("dry-run: pass --live or set JARVIS_BENCHMARK_LIVE=1 to make inference calls")
    arms = ("baseline", "architecture") if args.arm == "both" else (args.arm,)
    report = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "k": args.k, "live": live, "arms": {}}
    for arm in arms:
        rows = []
        for task in TASKS:
            passes = 0
            for sample in range(args.k):
                if arm == "baseline":
                    ok, detail, seconds = run_baseline(task, sample, live)
                else:
                    ok, detail, seconds = run_architecture(task, sample, args.stream_url, live)
                if ok:
                    passes += 1
                state = "PASS" if ok else ("SKIP" if ok is None else "FAIL")
                print(f"[{arm}] {task['name']:22s} s{sample} {state} ({seconds:.1f}s) {detail}", flush=True)
            rows.append({"name": task["name"], "category": task["category"], "passes": passes, "k": args.k})
        report["arms"][arm] = rows
    print(json.dumps(report, indent=2))
    if live:
        output = ROOT / "results-tier2b.json"
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
