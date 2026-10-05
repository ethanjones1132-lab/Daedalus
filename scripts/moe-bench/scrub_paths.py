"""Replace local Windows temp paths (which carry the account name) with <tmp> in result files bound
for the public repo. JSON rows hold the paths with escaped backslashes, so both spellings are handled.
usage: scrub_paths.py FILE [FILE ...]   (rewrites each file in place, reports the count)"""
import re
import sys

PATTERNS = [re.compile(r"[A-Za-z]:\\\\Users\\\\[^\\\"]+\\\\AppData\\\\Local\\\\Temp\\\\"),  # JSON-escaped
            re.compile(r"[A-Za-z]:\\Users\\[^\\\"]+\\AppData\\Local\\Temp\\"),
            re.compile(r"[A-Za-z]:\\\\Users\\\\[^\\\"]+\\\\"),  # any other user-profile path, e.g. the uv Python
            re.compile(r"[A-Za-z]:\\Users\\[^\\\"]+\\")]
REPL = ["<tmp>\\\\", "<tmp>\\", "<home>\\\\", "<home>\\"]

for path in sys.argv[1:]:
    text = open(path, encoding="utf-8").read()
    n = 0
    for pat, rep in zip(PATTERNS, REPL):
        text, k = pat.subn(rep.replace("\\", "\\\\"), text)
        n += k
    if n:
        open(path, "w", encoding="utf-8", newline="").write(text)
    print(f"{n:5d} replaced  {path}")
