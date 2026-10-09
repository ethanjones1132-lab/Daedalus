"""Keeps the Ecosystem Lab (and anything near it) out of the teacher data (spec section 2)."""
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE.parent / "moe-bench" / "train_tasks"))
import make  # noqa: E402

LAB_PROMPT = REPO / "docs" / "benchmarks" / "oneshot" / "ecosystem-lab" / "prompt.md"
TERMS = {"ecosystem", "predator", "prey", "lotka", "volterra", "rabbit", "rabbits", "fox", "foxes", "rk4"}
PHRASES = ("population dynamics", "food chain", "predator-prey")
JACCARD_LIMIT = 0.3
_lab = None


def lab_words():
    global _lab
    if _lab is None:
        _lab = make.words(LAB_PROMPT.read_text(encoding="utf-8"))
    return _lab


def lab_hit(text):
    """A reason string if the text names a Lab topic or is within JACCARD_LIMIT of the Lab prompt, else None."""
    low = text.lower()
    hit = sorted(set(re.findall(r"[a-z0-9]+", low)) & TERMS)
    if hit:
        return "term: " + ",".join(hit)
    for phrase in PHRASES:
        if phrase in low:
            return "phrase: " + phrase
    j = make.jaccard(make.words(text), lab_words())
    return f"jaccard {j:.2f}" if j >= JACCARD_LIMIT else None
