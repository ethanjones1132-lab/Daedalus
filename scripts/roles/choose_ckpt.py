"""Task 15 step 2: one checkpoint per (size, role), chosen on the DEV split only. Candidates are the lowest-dev-loss step
("best", from summary.json) and "final"; the higher dev pass count wins and a tie goes to the lower dev loss (best).
usage: choose_ckpt.py --work E:/AI/role-adapters/eval --runs E:/AI/role-adapters/runs --arm S --sizes 4B,2B,0.8B
writes <work>/chosen-<arm>.json = {"4B": {"plan": "step20", ...}, ...} and prints the dev counts it compared."""
import argparse
import json
import pathlib

ROLES = ("plan", "build", "fix")
# the phase file whose `ok` flags are the role's dev pass count (eval_roles.py)
PHASE = {"plan": "builds-base-from-{name}", "build": "builds-{name}-from-teacher", "fix": "fixes-{name}"}


def candidates(summary):
    """best first (it wins ties); final is the same weights when the best step is the last one, so it is not evaluated twice."""
    out = [summary["best"]]
    if summary["best"] != f"step{summary['steps']}":
        out.append(summary["final"])
    return out


def passes(path):
    p = pathlib.Path(path)
    if not p.exists():
        return None
    return sum(1 for line in p.read_text(encoding="utf-8").splitlines() if line.strip() and json.loads(line).get("ok"))


def choose(work, runs, arm, sizes):
    chosen, table = {}, []
    for size in sizes:
        chosen[size] = {}
        for role in ROLES:
            summ_path = pathlib.Path(runs) / f"{size}-{arm}-{role}" / "summary.json"
            if not summ_path.exists():
                continue
            summary = json.loads(summ_path.read_text(encoding="utf-8"))
            best_ck, best_n = None, -1
            for ck in candidates(summary):
                name = f"{size}-{arm}-{role}-{ck}"
                n = passes(pathlib.Path(work) / size / "dev" / (PHASE[role].format(name=name) + ".jsonl"))
                table.append({"size": size, "role": role, "ckpt": ck, "dev_pass": n})
                if n is not None and n > best_n:  # strict: a tie keeps the earlier candidate, the lower dev loss
                    best_ck, best_n = ck, n
            if best_ck is not None:
                chosen[size][role] = best_ck
    return chosen, table


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--runs", required=True)
    ap.add_argument("--arm", default="S")
    ap.add_argument("--sizes", default="4B,2B,0.8B")
    a = ap.parse_args()
    chosen, table = choose(a.work, a.runs, a.arm, a.sizes.split(","))
    out = pathlib.Path(a.work) / f"chosen-{a.arm}.json"
    out.write_text(json.dumps(chosen, indent=1), encoding="utf-8")
    for row in table:
        print(json.dumps(row))
    print(json.dumps(chosen, indent=1))


if __name__ == "__main__":
    main()
