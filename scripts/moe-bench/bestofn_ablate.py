"""Ablations on a bestofn_tier2b.py run, from the stored rows (no generation):
how the self-test selection gain depends on which self-tests exist, and on N.
usage: bestofn_ablate.py OUT.jsonl
"""
import collections
import json
import sys

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0])
from bestofn_tier2b import pick  # noqa: E402

rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
latest = {}
for r in rows:
    if r["type"] == "cand":
        latest[(r["task"], r["trial"], r["cand"])] = r
by = collections.defaultdict(list)
for r in latest.values():
    by[(r["task"], r["category"], r["trial"])].append(r)
for v in by.values():
    v.sort(key=lambda r: r["cand"])


def only(c, suites):
    return {**c, "self": {k: v for k, v in c["self"].items() if k in suites}}


def score(n, suites, policy="selftest"):
    tot = collections.Counter()
    for (task, cat, trial), cands in by.items():
        cs = [only(c, suites) for c in cands[:n]]
        tot[cat] += pick(cs, policy)["graded_ok"]
    return sum(tot.values()), dict(sorted(tot.items()))


print(f"{len(by)} task-trials")
print("self-test selection by which suites the verifier gets (N = 8):")
for label, suites in [("suite 0 only (temp 0.2)", {"s0"}), ("suite 1 only (temp 0.7)", {"s1"}),
                      ("both suites", {"s0", "s1"})]:
    s, cats = score(8, suites)
    print(f"  {label:26s} {s}/117  {cats}")
print("scaling with N (both suites; 'oracle' = any of the first N passes grading):")
for n in (1, 2, 3, 4, 6, 8):
    s, _ = score(n, {"s0", "s1"})
    orc = sum(any(c["graded_ok"] for c in cands[:n]) for cands in by.values())
    print(f"  N={n}: selftest {s}/117, oracle {orc}/117")
gen = [c["gen_n"] or 0 for v in by.values() for c in v]
print(f"candidate answer tokens: mean {sum(gen) / len(gen):.0f}")
