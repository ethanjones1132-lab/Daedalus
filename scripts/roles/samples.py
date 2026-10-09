"""Turns teacher runs and faults into role training samples (spec section 2). Prompts are the staged harness's:
ct.PLAN_PROMPT, tg.BUILD_FROM_PLAN_PROMPT, ct.FIX_PROMPT."""
import argparse
import collections
import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import compare_tasks as ct  # noqa: E402
import splits  # noqa: E402
import teacher_gen as tg  # noqa: E402

FENCE = "`" * 3
MARK = {"python": "# file: {}", "node": "// file: {}", "web": "<!-- file: {} -->"}
FENCE_LANG = {"python": "python", "node": "javascript", "web": "html"}
FAILED = "The acceptance tests failed:\n"


def sid_of(rec):
    return "|".join([rec["lang"], rec["kind"], rec["field"], str(rec["i"])])


def split_of_rec(rec):
    return splits.split_of(rec["field"])


def show_files(files):
    """Files as the fix prompt shows them (the format teacher_gen.gen uses)."""
    return "\n\n".join(f"{FENCE}\n# file: {p}\n{c}{FENCE}" for p, c in files.items())


def render_files(files, lang):
    """Files as a reply: one fenced block per file, first line a comment naming the file."""
    blocks = []
    for path, content in files.items():
        body = content if content.endswith("\n") else content + "\n"
        blocks.append(f"{FENCE}{FENCE_LANG[lang]}\n{MARK[lang].format(path)}\n{body}{FENCE}")
    return "\n\n".join(blocks)


def chat_messages(user):
    return [{"role": "system", "content": tg.SYSTEM}, {"role": "user", "content": user}]


def make(role, user, assistant, sid, split, lang, source):
    return {"role": role, "source": source, "sid": sid, "split": split, "lang": lang,
            "messages": chat_messages(user) + [{"role": "assistant", "content": assistant}]}


def from_runs(runs):
    """plan: a build from it passed; build: the first build passed; fix: the first build failed and DeepSeek's fix passed."""
    out = []
    for r in runs:
        if not r.get("plan") or not r.get("build"):
            continue
        sid, split, lang = sid_of(r), split_of_rec(r), r["lang"]
        ok_build = bool(r.get("build_ok"))
        if ok_build or r.get("fix_ok"):
            out.append(make("plan", ct.PLAN_PROMPT.format(request=r["request"]), r["plan"], sid, split, lang, "teacher"))
        if ok_build:
            out.append(make("build", tg.BUILD_FROM_PLAN_PROMPT.format(request=r["request"], plan=r["plan"]),
                            r["build"], sid, split, lang, "teacher"))
        elif r.get("fix_ok") and r.get("fix"):
            files = tg.extract_files(r["build"], r["entry"])
            if files:
                user = ct.FIX_PROMPT.format(request=r["request"], files=show_files(files),
                                            failures=FAILED + r.get("build_out", ""))
                out.append(make("fix", user, r["fix"], sid, split, lang, "teacher-fix"))
    return out


def fault_sample(f):
    user = ct.FIX_PROMPT.format(request=f["request"], files=show_files(f["files_bad"]), failures=FAILED + f["fail_out"])
    return make("fix", user, render_files(f["files_ok"], f["lang"]), f["sid"], f["split"], f["lang"], "fault")


def read_jsonl(path):
    return [json.loads(line) for line in open(path, encoding="utf-8")] if path and pathlib.Path(path).exists() else []


def build_datasets(runs_path, faults_path, out_dir):
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = from_runs(read_jsonl(runs_path)) + [fault_sample(f) for f in read_jsonl(faults_path) if f.get("ok")]
    by = collections.defaultdict(list)
    for s in rows:
        by[(s["role"], s["split"])].append(s)
    manifest = {"counts": collections.defaultdict(dict), "sources": collections.defaultdict(dict), "files": {}}
    for (role, split), group in sorted(by.items()):
        path = out_dir / f"{role}-{split}.jsonl"
        text = "".join(json.dumps(s) + "\n" for s in group)
        path.write_text(text, encoding="utf-8")
        manifest["counts"][role][split] = len(group)
        manifest["sources"][role][split] = dict(collections.Counter(s["source"] for s in group))
        manifest["files"][path.name] = hashlib.sha256(text.encode()).hexdigest()
    manifest = json.loads(json.dumps(manifest))
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="teacher data dir holding runs.jsonl and faults.jsonl")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    print(json.dumps(build_datasets(d / "runs.jsonl", d / "faults.jsonl", a.out), indent=1))


if __name__ == "__main__":
    main()
