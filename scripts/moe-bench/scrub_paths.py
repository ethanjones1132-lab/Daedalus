"""Replace local Windows temp paths (which carry the account name) with <tmp> in result files bound
for the public repo. JSON rows hold the paths with escaped backslashes, so both spellings are handled.
usage: scrub_paths.py FILE [FILE ...]   (rewrites each file in place, reports the count)"""
import re
import sys

PATTERNS = [re.compile(r"[A-Za-z]:\\\\Users\\\\[^\\\"]+\\\\AppData\\\\Local\\\\Temp\\\\"),  # JSON-escaped
            re.compile(r"[A-Za-z]:\\Users\\[^\\\"]+\\AppData\\Local\\Temp\\")]
REPL = ["<tmp>\\\\", "<tmp>\\"]

for path in sys.argv[1:]:
    text = open(path, encoding="utf-8").read()
    n = 0
    for pat, rep in zip(PATTERNS, REPL):
        text, k = pat.subn(rep.replace("\\", "\\\\"), text)
        n += k
    if n:
        open(path, "w", encoding="utf-8", newline="").write(text)
    print(f"{n:5d} replaced  {path}")
