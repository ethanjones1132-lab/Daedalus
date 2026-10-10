"""SEARCH/REPLACE edit blocks for the fix role (design change 2026-10-09: the teacher's full-file fixes are 8.8k tokens
at the median and do not fit a QLoRA step on 8 GB). make_edits turns (failing files, fixed files) into blocks, verified by
applying them; apply_edits applies a reply's blocks and refuses any SEARCH that does not match exactly once.

Block format (payload lines keep their newlines; a new file has an empty SEARCH):
FILE: <path>
<<<<<<< SEARCH
<lines copied from the file>
=======
<replacement lines>
>>>>>>> REPLACE"""
import difflib
import re

OPEN, MID, CLOSE = "<<<<<<< SEARCH", "=======", ">>>>>>> REPLACE"
BLOCK = re.compile(r"^FILE: (\S+)\n<<<<<<< SEARCH\n(.*?)^=======\n(.*?)^>>>>>>> REPLACE$", re.S | re.M)
MARKERS = ("<<<<<<<", "=======", ">>>>>>>")


def _nl(text):
    return text if not text or text.endswith("\n") else text + "\n"


def _block(path, search, replace):
    return f"FILE: {path}\n{OPEN}\n{search}{MID}\n{replace}{CLOSE}\n"


def _hunks(old, new, ctx):
    a, b = old.splitlines(keepends=True), new.splitlines(keepends=True)
    ops = [op for op in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op[0] != "equal"]
    groups = []
    for op in ops:
        if groups and op[1] - groups[-1][-1][2] <= 2 * ctx:
            groups[-1].append(op)
        else:
            groups.append([op])
    out = []
    for g in groups:
        i1, i2, j1, j2 = g[0][1], g[-1][2], g[0][3], g[-1][4]
        lo, hi = max(0, i1 - ctx), min(len(a), i2 + ctx)
        out.append(("".join(a[lo:hi]), "".join(b[j1 - (i1 - lo):j2 + (hi - i2)])))
    return out


def apply_edits(files, reply):
    """(new files, None) or (the unchanged files, a reason). Every SEARCH must match exactly once in its file."""
    blocks = BLOCK.findall(reply)
    if not blocks:
        return files, "no edit blocks"
    out = dict(files)
    for path, search, replace in blocks:
        text = out.get(path)
        if text is None:
            if search:
                return files, f"{path}: unknown file"
            out[path] = replace
            continue
        if not search:
            return files, f"{path}: empty SEARCH for an existing file"
        n = text.count(search)
        if n != 1:
            return files, f"{path}: SEARCH matches {n} times"
        out[path] = text.replace(search, replace, 1)
    return out, None


def make_edits(old, new, max_ctx=16):
    """Edit blocks that turn `old` into `new` (dicts path -> text), or None if the files are unchanged, a file was removed,
    an old file is empty, a payload line looks like a marker, or no amount of context makes the blocks unambiguous."""
    if any(p not in new for p in old) or any(not t for t in old.values()):
        return None
    want = {p: _nl(t) for p, t in new.items()}
    base = {p: _nl(t) for p, t in old.items()}
    ctx = 2
    while ctx <= max_ctx:
        pairs = []
        for path, text in want.items():
            if path not in base:
                pairs.append((path, "", text))
            elif base[path] != text:
                pairs += [(path, s, r) for s, r in _hunks(base[path], text, ctx)]
        if not pairs:
            return None
        if any(ln.startswith(MARKERS) for _, s, r in pairs for ln in (s + r).splitlines()):
            return None
        out = "".join(_block(*x) for x in pairs)
        done, err = apply_edits(base, out)
        if err is None and done == want:
            return out
        ctx *= 2
    return None
