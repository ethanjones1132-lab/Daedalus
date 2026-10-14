"""The teacher comparison set (2026-10-08): six small builds written for this comparison only, from no benchmark
family (checked against the 228 tier2b / pool / judge task names), each with a precise interface so its acceptance
checks are objective. Used once to pick the teacher (DeepSeek v4.1 Flash vs Grok 4.7); never used for training."""
import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent

TASKS = [
    dict(id="py_dupfind", lang="python", entry="dupfind.py", request="""\
Write a Python 3 command-line tool `dupfind.py` (standard library only) that finds duplicate files by content.

Usage: `python dupfind.py ROOT [--min-size N] [--json]`
- Walk ROOT recursively. Files smaller than N bytes are ignored (default N is 1, so empty files are ignored).
- Two files are duplicates when their contents are byte-for-byte identical. Group files by size first, then hash
  only files that share a size (SHA-256, read in chunks).
- A group is reported only if it has at least 2 files.
- Paths are relative to ROOT with forward slashes. Each group's paths are sorted; groups are sorted by their first
  path.
- With `--json`, print exactly one JSON array of groups (each group an array of path strings) to stdout.
- Without `--json`, print each group as its paths on one line separated by two spaces, one group per line.
- Exit code 0 on success, 2 if ROOT is not a directory."""),
    dict(id="py_logreport", lang="python", entry="logreport.py", request="""\
Write a Python 3 script `logreport.py` (standard library only) that summarizes a web server access log in Common
Log Format, e.g. `127.0.0.1 - frank [10/Oct/2026:13:55:36 -0700] "GET /a.html HTTP/1.1" 200 2326`.

Usage: `python logreport.py LOGFILE` prints one JSON object to stdout with exactly these keys:
- "total": number of well-formed lines.
- "per_hour": object mapping the UTC hour "YYYY-MM-DDTHH" (convert the timestamp's offset to UTC) to its request
  count, for well-formed lines.
- "top_paths": the 3 most requested paths as [path, count] pairs, by count descending, ties by path ascending. The
  path excludes the query string (`/a?x=1` counts as `/a`).
- "error_rate": the fraction of well-formed lines with a 5xx status, rounded to 4 decimals (0 if total is 0).
- "malformed": number of non-empty lines that do not parse. Blank lines are ignored entirely.
The size field may be `-`."""),
    dict(id="py_tmpl", lang="python", entry="tmpl.py", request="""\
Write a small Python 3 template engine as a module `tmpl.py` (standard library only) with one public function
`render(template: str, context: dict) -> str`.
- `{{ expr }}` outputs a value. `expr` is a name with optional dotted lookups (`user.city`): each step looks up a
  dict key first, then an attribute. A missing name or step renders as an empty string.
- Output is HTML-escaped like Python's `html.escape(value, quote=True)` applied to `str(value)`, unless the
  expression ends with the filter `|safe` (`{{ body|safe }}`).
- `{% for x in expr %}...{% endfor %}` repeats its body for each item, with `x` bound inside the body.
- `{% if expr %}...{% else %}...{% endif %}` (the else branch is optional) uses Python truthiness; a missing value
  is false.
- Blocks nest arbitrarily. Whitespace inside the delimiters is optional. Text outside tags is copied unchanged.
- A malformed template (e.g. an unclosed `{% for %}`) raises `ValueError`."""),
    dict(id="js_cron", lang="node", entry="cron.js", request="""\
Write a Node.js CommonJS module `cron.js` (no dependencies) that exports `nextRuns(expr, startISO, n)`.
- `expr` is a standard 5-field cron expression: minute, hour, day-of-month, month, day-of-week (0-6, 0 = Sunday;
  7 is also accepted as Sunday). Each field supports `*`, numbers, lists `a,b`, ranges `a-b` and steps `*/s` and
  `a-b/s`.
- Times are UTC. Return the next `n` matching times strictly after `startISO`, as strings from
  `Date.prototype.toISOString()`, in order.
- Day matching follows standard Vixie cron: if both day-of-month and day-of-week are restricted (neither is `*`),
  a day matches when EITHER matches; otherwise both must match.
- Throw an Error for an invalid expression."""),
    dict(id="web_pomodoro", lang="web", entry="index.html", request="""\
Write a single-file web app `index.html` (inline CSS and JavaScript, no external resources): a Pomodoro timer with a
task list.
- Inputs `#work-minutes` and `#break-minutes` (numbers, default 25 and 5). The display `#time` shows the remaining
  time as MM:SS; changing `#work-minutes` while stopped updates it immediately (1 shows 01:00).
- Buttons `#start` (start/pause) and `#reset` (stop and show the full work length). When work time runs out it
  switches to break, then back to work.
- A task input `#task-input` and button `#add-task` add a task to the list `#task-list` (one `li` per task, its
  text included). Clicking a task's `li` selects it as the current task; each completed work period adds 1 to the
  selected task's pomodoro count, shown in that `li`.
- Tasks, counts and the minute settings persist in localStorage and are restored on reload."""),
    dict(id="web_draw", lang="web", entry="index.html", request="""\
Write a single-file web app `index.html` (inline CSS and JavaScript, no external resources): a drawing app.
- A `<canvas id="canvas">` of 600x400 with a white background. Dragging the mouse with the button down draws a
  freehand stroke.
- `#color` (an `<input type="color">`) and `#size` (an `<input type="range">`, 1-50) set the brush.
- `#undo` and `#redo` buttons undo and redo whole strokes (redo history is cleared by a new stroke).
- `#clear` clears the canvas to white (and can be undone).
- `#export` downloads the drawing as a PNG file named `drawing.png`."""),
]

PLAN_PROMPT = """Here is a feature request.

{request}

Write an implementation plan for the engineer who will build it: restate the goal and any assumptions; list the
files with their responsibilities; the key functions or components with signatures; data structures; a
step-by-step build order; edge cases; and how to verify it (tests and manual checks). Be specific and concise. Do
not write the full implementation."""

BUILD_PROMPT = """Implement this request completely.

{request}

Reply with every file in full, each in its own fenced code block whose first line is a comment naming the file,
e.g. `# file: tool.py`, `// file: lib.js` or `<!-- file: index.html -->`. No placeholders, TODOs or omitted parts."""

FIX_PROMPT = """You implemented this request:

{request}

Your files:

{files}

Running acceptance checks against them gave these failures:

{failures}

Fix the implementation. Reply with every file in full, each in its own fenced code block whose first line is a
comment naming the file. No placeholders, TODOs or omitted parts."""


def _run(cmd, cwd, timeout=60, stdin=None):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, input=stdin)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"


def check_dupfind(d):
    root = pathlib.Path(tempfile.mkdtemp(prefix="dup-"))
    files = {"a/x.txt": b"hello", "b/y.txt": b"hello", "c/z.txt": b"world", "d/e1": b"", "d/e2": b"",
             "e/big1": b"A" * 2000, "e/big2": b"A" * 2000, "e/big3": b"A" * 1999 + b"B", "f/sub/x2.txt": b"hello"}
    for p, b in files.items():
        (root / p).parent.mkdir(parents=True, exist_ok=True)
        (root / p).write_bytes(b)
    out = {}
    rc, so, se = _run([sys.executable, "dupfind.py", str(root), "--json"], d)
    try:
        out["default"] = json.loads(so) == [["a/x.txt", "b/y.txt", "f/sub/x2.txt"], ["e/big1", "e/big2"]]
    except ValueError:
        out["default"] = False
    rc2, so2, _ = _run([sys.executable, "dupfind.py", str(root), "--json", "--min-size", "100"], d)
    try:
        out["min_size"] = json.loads(so2) == [["e/big1", "e/big2"]]
    except ValueError:
        out["min_size"] = False
    rc3, so3, _ = _run([sys.executable, "dupfind.py", str(root)], d)
    out["text_mode"] = so3.strip().splitlines() == ["a/x.txt  b/y.txt  f/sub/x2.txt", "e/big1  e/big2"]
    rc4, _, _ = _run([sys.executable, "dupfind.py", str(root / "nope")], d)
    out["exit_2"] = rc4 == 2
    return out, se[-600:]


def check_logreport(d):
    lines = [
        '1.1.1.1 - - [10/Oct/2026:13:55:36 +0000] "GET /a.html HTTP/1.1" 200 2326',
        '1.1.1.2 - bob [10/Oct/2026:15:10:00 +0200] "GET /a.html?x=1 HTTP/1.1" 200 100',
        '1.1.1.3 - - [10/Oct/2026:13:59:59 +0000] "POST /api/save HTTP/1.1" 500 -',
        '',
        'garbage line here',
        '1.1.1.4 - - [10/Oct/2026:09:01:00 -0500] "GET /b HTTP/1.1" 503 12',
        '1.1.1.5 - - [11/Oct/2026:00:00:00 +0000] "GET /b HTTP/1.1" 404 0',
        '1.1.1.6 - - [11/Oct/2026:00:30:00 +0000] "GET /c HTTP/1.1" 200 5',
        '1.1.1.7 - - [11/Oct/2026:00:31:00 +0000] "GET /api/save HTTP/1.1" 200 5',
        '1.1.1.8 - - [bad date] "GET /c HTTP/1.1" 200 5',
    ]
    log = pathlib.Path(tempfile.mkdtemp(prefix="log-")) / "access.log"
    log.write_text("\n".join(lines) + "\n", encoding="utf-8")
    rc, so, se = _run([sys.executable, "logreport.py", str(log)], d)
    try:
        r = json.loads(so)
    except ValueError:
        return {k: False for k in ("total", "per_hour", "top_paths", "error_rate", "malformed")}, se[-600:]
    return {"total": r.get("total") == 7,
            "per_hour": r.get("per_hour") == {"2026-10-10T13": 3, "2026-10-10T14": 1, "2026-10-11T00": 3},
            "top_paths": r.get("top_paths") == [["/a.html", 2], ["/api/save", 2], ["/b", 2]],
            "error_rate": r.get("error_rate") == round(2 / 7, 4),
            "malformed": r.get("malformed") == 2}, se[-600:]


TMPL_CASES = [
    ("escape", "Hello {{ name }}!", {"name": "<b>A&B</b>"}, "Hello &lt;b&gt;A&amp;B&lt;/b&gt;!"),
    ("quotes", "{{q}}", {"q": "\"it's\""}, "&quot;it&#x27;s&quot;"),
    ("safe", "{{ name|safe }}", {"name": "<b>A</b>"}, "<b>A</b>"),
    ("dotted", "{{ user.city }}/{{ user.zip }}", {"user": {"city": "Oslo"}}, "Oslo/"),
    ("for", "{% for x in items %}[{{ x }}]{% endfor %}", {"items": [1, 2, 3]}, "[1][2][3]"),
    ("nested", "{% for u in users %}{% if u.admin %}*{% else %}-{% endif %}{{u.name}} {% endfor %}",
     {"users": [{"name": "a", "admin": True}, {"name": "b", "admin": False}]}, "*a -b "),
    ("missing_if", "{% if nope %}yes{% endif %}done", {}, "done"),
]


def check_tmpl(d):
    script = ("import json, sys, tmpl\ncases = json.loads(sys.stdin.read())\nout = {}\n"
              "for name, t, ctx, want in cases:\n"
              "    try:\n        out[name] = tmpl.render(t, ctx) == want\n"
              "    except Exception:\n        out[name] = False\n"
              "class O: pass\no = O(); o.city = 'Rome'\n"
              "try:\n    out['attr'] = tmpl.render('{{ p.city }}', {'p': o}) == 'Rome'\n"
              "except Exception:\n    out['attr'] = False\n"
              "try:\n    tmpl.render('{% for x in xs %}x', {'xs': [1]}); out['malformed'] = False\n"
              "except ValueError:\n    out['malformed'] = True\nexcept Exception:\n    out['malformed'] = False\n"
              "print(json.dumps(out))\n")
    (pathlib.Path(d) / "_check_tmpl.py").write_text(script, encoding="utf-8")
    rc, so, se = _run([sys.executable, "_check_tmpl.py"], d, stdin=json.dumps(TMPL_CASES))
    try:
        return json.loads(so.strip().splitlines()[-1]), se[-600:]
    except (ValueError, IndexError):
        return {c[0]: False for c in TMPL_CASES} | {"attr": False, "malformed": False}, se[-600:]


CRON_CASES = [
    ("step", "*/15 * * * *", "2026-01-01T00:07:00Z", 3,
     ["2026-01-01T00:15:00.000Z", "2026-01-01T00:30:00.000Z", "2026-01-01T00:45:00.000Z"]),
    ("weekdays", "0 9 * * 1-5", "2026-10-09T10:00:00Z", 2, ["2026-10-12T09:00:00.000Z", "2026-10-13T09:00:00.000Z"]),
    ("list_dom", "30 2 1,15 * *", "2026-02-10T00:00:00Z", 2, ["2026-02-15T02:30:00.000Z", "2026-03-01T02:30:00.000Z"]),
    ("dom_or_dow", "0 0 13 * 5", "2026-11-01T00:00:00Z", 3,
     ["2026-11-06T00:00:00.000Z", "2026-11-13T00:00:00.000Z", "2026-11-20T00:00:00.000Z"]),
    ("sunday7", "5 4 * * 7", "2026-10-08T00:00:00Z", 1, ["2026-10-11T04:05:00.000Z"]),
    ("range_step", "0 8-17/4 * * *", "2026-10-08T09:00:00Z", 3,
     ["2026-10-08T12:00:00.000Z", "2026-10-08T16:00:00.000Z", "2026-10-09T08:00:00.000Z"]),
]


def check_cron(d):
    script = ("const {nextRuns} = require('./cron.js');\nconst cases = JSON.parse(require('fs').readFileSync(0,'utf8'));\n"
              "const out = {};\nfor (const [name, e, s, n, want] of cases) {\n"
              "  try { out[name] = JSON.stringify(nextRuns(e, s, n)) === JSON.stringify(want); } catch (x) { out[name] = false; }\n}\n"
              "try { nextRuns('61 * * * *', '2026-01-01T00:00:00Z', 1); out.invalid = false; } catch (x) { out.invalid = true; }\n"
              "console.log(JSON.stringify(out));\n")
    (pathlib.Path(d) / "_check_cron.js").write_text(script, encoding="utf-8")
    rc, so, se = _run(["node", "_check_cron.js"], d, stdin=json.dumps(CRON_CASES))
    try:
        return json.loads(so.strip().splitlines()[-1]), se[-600:]
    except (ValueError, IndexError):
        return {c[0]: False for c in CRON_CASES} | {"invalid": False}, se[-600:]


def check_web(d, task_id):
    rc, so, se = _run(["node", str(HERE / "check_web.mjs"), str(pathlib.Path(d) / "index.html"), task_id], d, timeout=120)
    try:
        return json.loads(so.strip().splitlines()[-1]), se[-600:]
    except (ValueError, IndexError):
        return {"loads": False}, (se or so)[-600:]


def check(task, d):
    """({check name: passed}, stderr tail) for the files in directory d."""
    tid = task["id"]
    if not (pathlib.Path(d) / task["entry"]).exists():
        return {"entry_exists": False}, ""
    if tid == "py_dupfind":
        return check_dupfind(d)
    if tid == "py_logreport":
        return check_logreport(d)
    if tid == "py_tmpl":
        return check_tmpl(d)
    if tid == "js_cron":
        return check_cron(d)
    return check_web(d, tid)
