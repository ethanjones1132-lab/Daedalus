"""Calibration pool, category D (files and processes): 12 new tasks in tier2b's format (Laya partner spec §4).
Tests work only inside the seeded folder and start processes with sys.executable. Each carries `reference`, used
only by validate_tasks.py; it is never shown to a model."""

TASKS = [
    dict(name="c_read_config", category="D", entry="config.py",
         files={"config.py": '''def read_config(path):
    """The meaningful lines of a config file."""
    with open(path, encoding="utf-8") as f:
        return f.read().splitlines()
'''},
         spec="Return the config's lines stripped of surrounding whitespace, skipping blank lines and lines whose "
              "first non-space character is '#'. A missing file returns [] instead of raising.",
         reference='''def read_config(path):
    """The meaningful lines of a config file."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return []
    return [s.strip() for s in lines if s.strip() and not s.strip().startswith("#")]
''',
         test='''from config import read_config
with open("app.cfg", "w", encoding="utf-8") as f:
    f.write("# comment\\nhost = a\\n\\n   # indented comment\\n  port = 80  \\n")
assert read_config("app.cfg") == ["host = a", "port = 80"], read_config("app.cfg")
assert read_config("missing.cfg") == []
'''),
    dict(name="c_write_csv", category="D", entry="report.py",
         files={"report.py": '''import csv


def write_rows(path, rows):
    """Write rows (lists of strings) to a CSV file."""
    with open(path, "w", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)
'''},
         spec="Reading the file back with the csv module must give exactly the rows written: on Windows the "
              "report currently gets an empty row after every row.",
         reference='''import csv


def write_rows(path, rows):
    """Write rows (lists of strings) to a CSV file."""
    with open(path, "w", encoding="utf-8", newline="") as f:
        csv.writer(f).writerows(rows)
''',
         test='''import csv
from report import write_rows
rows = [["name", "qty"], ["apple, red", "3"], ["pear", "5"]]
write_rows("out.csv", rows)
with open("out.csv", encoding="utf-8", newline="") as f:
    got = list(csv.reader(f))
assert got == rows, got
'''),
    dict(name="c_count_lines", category="D", entry="stats.py",
         files={"stats.py": '''def count_lines(path):
    """Number of lines in a text file."""
    with open(path, encoding="utf-8") as f:
        return f.read().count("\\n")
'''},
         spec="Count lines the way an editor shows them: a last line without a trailing newline still counts; an "
              "empty file has 0 lines.",
         reference='''def count_lines(path):
    """Number of lines in a text file."""
    with open(path, encoding="utf-8") as f:
        return len(f.read().splitlines())
''',
         test='''from stats import count_lines
for name, text, n in (("a.txt", "x\\ny\\nz", 3), ("b.txt", "x\\ny\\n", 2), ("c.txt", "", 0), ("d.txt", "one", 1)):
    with open(name, "w", encoding="utf-8") as f:
        f.write(text)
    assert count_lines(name) == n, (name, count_lines(name))
'''),
    dict(name="c_backup_copy", category="D", entry="backup.py",
         files={"backup.py": '''import os


def backup(path):
    """Make a backup next to path and return the backup's path."""
    dest = path + ".bak"
    os.rename(path, dest)
    return dest
'''},
         spec="backup(path) must leave the original file in place and create path + '.bak' with the same "
              "content, overwriting an older backup. It returns the backup's path.",
         reference='''import shutil


def backup(path):
    """Make a backup next to path and return the backup's path."""
    dest = path + ".bak"
    shutil.copyfile(path, dest)
    return dest
''',
         test='''import os
from backup import backup
with open("data.txt", "w", encoding="utf-8") as f:
    f.write("v1")
assert backup("data.txt") == "data.txt.bak"
assert os.path.exists("data.txt"), "original was moved"
assert open("data.txt.bak", encoding="utf-8").read() == "v1"
with open("data.txt", "w", encoding="utf-8") as f:
    f.write("v2")
backup("data.txt")
assert open("data.txt.bak", encoding="utf-8").read() == "v2"
'''),
    dict(name="c_tail", category="D", entry="logs.py",
         files={"logs.py": '''def tail(path, n):
    """The last n lines of a text file, without newline characters."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    return lines[:n]
'''},
         spec="tail(path, n) must return the last n lines (all of them if the file is shorter), oldest first, "
              "without newline characters.",
         reference='''def tail(path, n):
    """The last n lines of a text file, without newline characters."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    return lines[-n:] if n > 0 else []
''',
         test='''from logs import tail
with open("app.log", "w", encoding="utf-8") as f:
    f.write("l1\\nl2\\nl3\\nl4\\n")
assert tail("app.log", 2) == ["l3", "l4"], tail("app.log", 2)
assert tail("app.log", 10) == ["l1", "l2", "l3", "l4"]
assert tail("app.log", 0) == []
'''),
    dict(name="c_run_capture", category="D", entry="runner.py",
         files={"runner.py": '''import subprocess


def run(args):
    """Run a command; return (exit code, stdout without surrounding whitespace)."""
    r = subprocess.run(args, capture_output=True, text=True, check=True)
    return r.returncode, r.stdout.strip()
'''},
         spec="run(args) must report failing commands instead of raising: a command that exits with code 3 and "
              "prints 'x' returns (3, 'x').",
         reference='''import subprocess


def run(args):
    """Run a command; return (exit code, stdout without surrounding whitespace)."""
    r = subprocess.run(args, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()
''',
         test='''import sys
from runner import run
assert run([sys.executable, "-c", "print('hi')"]) == (0, "hi")
assert run([sys.executable, "-c", "import sys; print('x'); sys.exit(3)"]) == (3, "x")
'''),
    dict(name="c_json_set", category="D", entry="store.py",
         files={"store.py": '''import json
import os


def set_key(path, key, value):
    """Set key to value in the JSON object stored at path (created if missing)."""
    data = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    data[key] = value
    with open(path, "a", encoding="utf-8") as f:
        json.dump(data, f)
'''},
         spec="After any number of set_key calls the file must hold one valid JSON object with every key set so "
              "far; a second call currently corrupts it.",
         reference='''import json
import os


def set_key(path, key, value):
    """Set key to value in the JSON object stored at path (created if missing)."""
    data = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    data[key] = value
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
''',
         test='''import json
from store import set_key
set_key("s.json", "a", 1)
set_key("s.json", "b", [2])
set_key("s.json", "a", 3)
with open("s.json", encoding="utf-8") as f:
    assert json.load(f) == {"a": 3, "b": [2]}
'''),
    dict(name="c_safe_join", category="D", entry="uploads.py",
         files={"uploads.py": '''import os


def user_file(base, name):
    """Path of the uploaded file `name` inside the folder `base`."""
    return os.path.join(base, name)
'''},
         spec="user_file must refuse names that escape base: '../x', 'sub/../../x' and absolute paths raise "
              "ValueError. Allowed names return the normalized path inside base.",
         reference='''import os


def user_file(base, name):
    """Path of the uploaded file `name` inside the folder `base`."""
    if os.path.isabs(name):
        raise ValueError(f"absolute path: {name}")
    root = os.path.normpath(base)
    full = os.path.normpath(os.path.join(root, name))
    if full != root and not full.startswith(root + os.sep):
        raise ValueError(f"escapes {base}: {name}")
    return full
''',
         test='''import os
from uploads import user_file
assert user_file("data", "a.txt") == os.path.normpath("data/a.txt")
assert user_file("data", "sub/b.txt") == os.path.normpath("data/sub/b.txt")
for bad in ("../x", "sub/../../x", os.path.abspath("x")):
    try:
        user_file("data", bad)
        raise AssertionError(f"accepted {bad}")
    except ValueError:
        pass
'''),
    dict(name="c_find_ext", category="D", entry="finder.py",
         files={"finder.py": '''import os


def find_ext(root, ext):
    """Files under root with the given extension, e.g. find_ext("src", ".py")."""
    return sorted(n for n in os.listdir(root) if n.endswith(ext))
'''},
         spec="Search root recursively and return the matching files' paths relative to root, with '/' as the "
              "separator, sorted: ['a.py', 'pkg/b.py', 'pkg/deep/c.py'].",
         reference='''import os


def find_ext(root, ext):
    """Files under root with the given extension, e.g. find_ext("src", ".py")."""
    found = []
    for dirpath, _, names in os.walk(root):
        for n in names:
            if n.endswith(ext):
                found.append(os.path.relpath(os.path.join(dirpath, n), root).replace(os.sep, "/"))
    return sorted(found)
''',
         test='''import os
from finder import find_ext
for p in ("src/a.py", "src/pkg/b.py", "src/pkg/deep/c.py", "src/pkg/readme.md"):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").close()
assert find_ext("src", ".py") == ["a.py", "pkg/b.py", "pkg/deep/c.py"], find_ext("src", ".py")
assert find_ext("src", ".md") == ["pkg/readme.md"]
'''),
    dict(name="c_write_utf8", category="D", entry="notes.py",
         files={"notes.py": '''def save_note(path, text):
    """Save a note to disk."""
    with open(path, "w") as f:
        f.write(text)
'''},
         spec="Notes must be saved as UTF-8 so any character survives: saving 'Done ✓ café' currently "
              "fails on Windows.",
         reference='''def save_note(path, text):
    """Save a note to disk."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
''',
         test='''from notes import save_note
text = "Done \\u2713 caf\\u00e9"
save_note("n.txt", text)
with open("n.txt", "rb") as f:
    assert f.read().decode("utf-8") == text
'''),
    dict(name="c_file_sha256", category="D", entry="checksum.py",
         files={"checksum.py": '''import hashlib


def file_sha256(path):
    """Hex SHA-256 of a file's contents."""
    with open(path) as f:
        return hashlib.sha256(f.read().encode()).hexdigest()
'''},
         spec="The checksum must be of the file's exact bytes, for any file, binary ones included.",
         reference='''import hashlib


def file_sha256(path):
    """Hex SHA-256 of a file's contents."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()
''',
         test='''import hashlib
from checksum import file_sha256
data = b"a\\r\\nb\\x00\\xff\\x81"
with open("blob.bin", "wb") as f:
    f.write(data)
assert file_sha256("blob.bin") == hashlib.sha256(data).hexdigest()
'''),
    dict(name="c_write_lines", category="D", entry="writer.py",
         files={"writer.py": '''def write_lines(path, lines):
    """Write each string in lines as one line of a text file."""
    with open(path, "w", encoding="utf-8") as f:
        f.write("\\n".join(lines))
'''},
         spec="Every line, including the last, must end with a newline; an empty list writes an empty file.",
         reference='''def write_lines(path, lines):
    """Write each string in lines as one line of a text file."""
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(line + "\\n" for line in lines)
''',
         test='''from writer import write_lines
write_lines("o.txt", ["a", "b"])
assert open("o.txt", encoding="utf-8").read() == "a\\nb\\n"
write_lines("e.txt", [])
assert open("e.txt", encoding="utf-8").read() == ""
'''),
]
