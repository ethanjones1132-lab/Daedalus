"""Planted-bug variants of the Ecosystem Lab reference (spec §2, validation step 3).

Each variant changes the reference by exact text replacement. A replacement whose target isn't found exactly once
stops the script, so the variants can't drift silently from the reference. The checks must catch every variant in
its expected area.

usage: make_bugs.py [--ref REFERENCE.html] [--out BUGS_DIR]
"""
import argparse
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
LAB = HERE.parents[1] / "docs" / "benchmarks" / "oneshot" / "ecosystem-lab"

GRASS = "  for (let k = 0; k < sim.grass.length; k++) sim.grass[k] = Math.min(p.grassMax, sim.grass[k] + 1);\n"
BUGS = {
    # grass grows at the end of the tick instead of the start
    "tick-order": ("algo", [(GRASS, ""), ("  sim.tick += 1;\n", GRASS + "  sim.tick += 1;\n")]),
    "breed-off-by-one": ("algo", [("if (r.energy >= p.rabbitBreed)", "if (r.energy > p.rabbitBreed)")]),
    "euler": ("domain", [("x += dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);", "x += dt * k1[0];"),
                         ("y += dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);", "y += dt * k1[1];")]),
    "no-label": ("a11y", [('<label for="p-${key}">', '<label for="p-${key}-unlinked">')]),
    "csv-no-header": ("data", [('return "tick,rabbits,foxes,grass\\n" + sim.history', "return sim.history")]),
}


def make(ref_text, edits):
    text = ref_text
    for old, new in edits:
        n = text.count(old)
        if n != 1:
            raise SystemExit(f"target found {n} times, expected once: {old[:60]!r}")
        text = text.replace(old, new)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default=str(LAB / "reference.html"))
    ap.add_argument("--out", default=str(LAB / "bugs"))
    a = ap.parse_args()
    ref = pathlib.Path(a.ref).read_text(encoding="utf-8")
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, (area, edits) in BUGS.items():
        (out / f"{name}.html").write_text(make(ref, edits), encoding="utf-8")
        print(f"{name}.html (expected to fail in {area})")


if __name__ == "__main__":
    main()
