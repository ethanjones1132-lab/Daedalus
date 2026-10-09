"""Writes files out of a plan document: a fenced block whose header is `<lang> file=<path>` is that file.
usage: plan_extract.py PLAN.md PATH [PATH ...]   (paths as written in the plan, relative to the repo root)"""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
BLOCK = re.compile(r"^```(\w+) file=(\S+)\n(.*?)\n```$", re.S | re.M)


def blocks(text):
    return {m.group(2): m.group(3) + "\n" for m in BLOCK.finditer(text)}


def main():
    found = blocks(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    for want in sys.argv[2:]:
        if want not in found:
            sys.exit(f"{want}: no such block in the plan")
        path = REPO / want
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(found[want], encoding="utf-8", newline="\n")
        print("wrote", want)


if __name__ == "__main__":
    main()
