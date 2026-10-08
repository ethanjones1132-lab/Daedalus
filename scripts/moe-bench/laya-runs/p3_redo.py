"""Laya v3 judge session repair (2026-10-08): rows whose Laya call failed for infrastructure reasons are redone.

nested: Laya missed its 5 s deadline under memory pressure (a game was opened mid-run), so the client stopped asking,
and later rows have no evidence answer (p3.evidence None) and no noted fix. `split` writes the other rows to NEW (so
`nested --v3 --base BASE --out NEW` skips them) and the affected rows to BASE, whose r8/pr parts are kept and whose p3
block is regenerated with the same seeds. `merge` checks NEW and moves it over MAIN, keeping MAIN as .orig.

live: `drop-dead` removes live rows run after Laya died (laya_dead), so the step reruns them. Rows are chosen by the
infrastructure flag only, never by outcome.

usage: p3_redo.py split MAIN NEW BASE | merge MAIN NEW WANT | drop-dead LIVE
"""
import json
import pathlib
import shutil
import sys


def rows(path):
    return [json.loads(line) for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def write(path, rs):
    pathlib.Path(path).write_text("".join(json.dumps(r) + "\n" for r in rs), encoding="utf-8")


def affected(r):
    return r.get("type") == "trial" and r.get("p3") is not None and r["p3"].get("evidence") is None


def main():
    cmd = sys.argv[1]
    if cmd == "split":
        main_, new, base = sys.argv[2:5]
        rs = rows(main_)
        write(new, [r for r in rs if not affected(r)])
        write(base, [r for r in rs if affected(r)])
        print(f"split: {sum(map(affected, rs))} rows without an evidence answer of {len(rs)}")
    elif cmd == "merge":
        main_, new, want = sys.argv[2], sys.argv[3], int(sys.argv[4])
        rs = rows(new)
        keys = {(r["task"], r["trial"]) for r in rs}
        if len(keys) < want:
            sys.exit(f"merge: only {len(keys)} of {want} rows; MAIN left as it is")
        if not pathlib.Path(main_ + ".orig").exists():  # keep the first original across passes
            shutil.copy(main_, main_ + ".orig")
        shutil.move(new, main_)
        print(f"merge: {len(keys)} rows; {sum(map(affected, rs))} still without an evidence answer")
    elif cmd == "drop-dead":
        live = sys.argv[2]
        rs = rows(live)
        dead = [r for r in rs if r.get("type") == "live" and r.get("laya_dead")]
        if dead:
            shutil.copy(live, live + f".dead{len(dead)}")
            write(live, [r for r in rs if not (r.get("type") == "live" and r.get("laya_dead"))])
        print(f"drop-dead: {len(dead)} live rows run after Laya died, removed for a rerun")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
