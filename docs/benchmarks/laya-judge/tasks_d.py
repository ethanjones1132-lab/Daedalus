"""Judge set, category D (files and processes): 12 new tasks in tier2b's format (Laya partner spec §4). Scoring
only. Tests work only inside the seeded folder and start processes with sys.executable. Each carries `reference`,
used only by validate_tasks.py; it is never shown to a model."""

TASKS = [
    dict(name="j_copy_no_clobber", category="D", entry="copier.py",
         files={"copier.py": '''import shutil


def copy_new(src, dst):
    """Copy src to dst."""
    shutil.copyfile(src, dst)
'''},
         spec="copy_new must never overwrite: if dst already exists, raise FileExistsError and leave dst exactly "
              "as it was.",
         reference='''import os
import shutil


def copy_new(src, dst):
    """Copy src to dst."""
    if os.path.exists(dst):
        raise FileExistsError(dst)
    shutil.copyfile(src, dst)
''',
         test='''from copier import copy_new
open("a.txt", "w").write("new")
open("b.txt", "w").write("keep")
copy_new("a.txt", "c.txt")
assert open("c.txt").read() == "new"
try:
    copy_new("a.txt", "b.txt")
    raise AssertionError("overwrote b.txt")
except FileExistsError:
    pass
assert open("b.txt").read() == "keep"
'''),
    dict(name="j_count_words_files", category="D", entry="wc.py",
         files={"wc.py": '''def total_words(paths):
    """Total number of whitespace-separated words in the given text files."""
    total = 0
    for p in paths:
        with open(p, encoding="utf-8") as f:
            total += len(f.read().split())
    return total
'''},
         spec="Files that do not exist are skipped (they count as zero words) instead of stopping the count.",
         reference='''def total_words(paths):
    """Total number of whitespace-separated words in the given text files."""
    total = 0
    for p in paths:
        try:
            with open(p, encoding="utf-8") as f:
                total += len(f.read().split())
        except FileNotFoundError:
            continue
    return total
''',
         test='''from wc import total_words
open("a.txt", "w", encoding="utf-8").write("one two three")
open("b.txt", "w", encoding="utf-8").write("four\\nfive")
assert total_words(["a.txt", "missing.txt", "b.txt"]) == 5
assert total_words([]) == 0
'''),
    dict(name="j_head_bytes", category="D", entry="peek.py",
         files={"peek.py": '''def head(path, n):
    """The first n bytes of a file."""
    with open(path) as f:
        return f.read(n).encode()
'''},
         spec="head(path, n) must return exactly the file's first n bytes (as bytes), for any file, binary ones "
              "included.",
         reference='''def head(path, n):
    """The first n bytes of a file."""
    with open(path, "rb") as f:
        return f.read(n)
''',
         test='''from peek import head
data = b"\\r\\n\\x00\\xffABC"
with open("blob.bin", "wb") as f:
    f.write(data)
assert head("blob.bin", 4) == b"\\r\\n\\x00\\xff", head("blob.bin", 4)
assert head("blob.bin", 100) == data
'''),
    dict(name="j_list_files_sorted", category="D", entry="listing.py",
         files={"listing.py": '''import os


def list_files(folder):
    """Names of the files in folder, sorted."""
    return sorted(os.listdir(folder))
'''},
         spec="list_files must return only regular files (no sub-folders), sorted by name.",
         reference='''import os


def list_files(folder):
    """Names of the files in folder, sorted."""
    return sorted(n for n in os.listdir(folder) if os.path.isfile(os.path.join(folder, n)))
''',
         test='''import os
from listing import list_files
os.makedirs("d/sub", exist_ok=True)
for n in ("b.txt", "a.txt"):
    open(os.path.join("d", n), "w").close()
assert list_files("d") == ["a.txt", "b.txt"], list_files("d")
'''),
    dict(name="j_replace_in_file", category="D", entry="edit.py",
         files={"edit.py": '''def replace_in_file(path, old, new):
    """Replace old with new in the file, in place. Returns how many replacements were made."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.replace(old, new, 1))
    return 1
'''},
         spec="Replace every occurrence and return the real number of replacements (0 when old does not occur, "
              "leaving the file unchanged).",
         reference='''def replace_in_file(path, old, new):
    """Replace old with new in the file, in place. Returns how many replacements were made."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    count = text.count(old)
    if count:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace(old, new))
    return count
''',
         test='''from edit import replace_in_file
open("t.txt", "w", encoding="utf-8").write("cat cat dog")
assert replace_in_file("t.txt", "cat", "fox") == 2
assert open("t.txt", encoding="utf-8").read() == "fox fox dog"
assert replace_in_file("t.txt", "emu", "x") == 0
assert open("t.txt", encoding="utf-8").read() == "fox fox dog"
'''),
    dict(name="j_csv_column_sum", category="D", entry="totals.py",
         files={"totals.py": '''def column_sum(path, column):
    """Sum of a numeric column (by header name) in a CSV file."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    header = lines[0].split(",")
    i = header.index(column)
    return sum(float(line.split(",")[i]) for line in lines[1:])
'''},
         spec="CSV fields may be quoted and contain commas ('\"Widget, large\",3'): parse the file as real CSV.",
         reference='''import csv


def column_sum(path, column):
    """Sum of a numeric column (by header name) in a CSV file."""
    with open(path, encoding="utf-8", newline="") as f:
        return sum(float(row[column]) for row in csv.DictReader(f))
''',
         test='''from totals import column_sum
with open("stock.csv", "w", encoding="utf-8", newline="") as f:
    f.write('name,qty\\n"Widget, large",3\\nBolt,4\\n')
assert column_sum("stock.csv", "qty") == 7.0
'''),
    dict(name="j_rotate_log", category="D", entry="rotate.py",
         files={"rotate.py": '''import os


def rotate(path, keep):
    """Rotate a log: path -> path.1 -> path.2 ... keeping at most `keep` old copies; path starts empty."""
    for i in range(1, keep + 1):
        src = f"{path}.{i - 1}" if i > 1 else path
        if os.path.exists(src):
            os.replace(src, f"{path}.{i}")
    open(path, "w").close()
'''},
         spec="After rotating, path.1 must hold the newest old log, path.2 the one before it, and so on up to "
              "path.<keep>; the oldest copies beyond that are dropped. Right now history is lost after the first "
              "rotation.",
         reference='''import os


def rotate(path, keep):
    """Rotate a log: path -> path.1 -> path.2 ... keeping at most `keep` old copies; path starts empty."""
    for i in range(keep, 0, -1):
        src = f"{path}.{i - 1}" if i > 1 else path
        if os.path.exists(src):
            os.replace(src, f"{path}.{i}")
    open(path, "w").close()
''',
         test='''import os
from rotate import rotate
for text in ("a", "b", "c"):
    with open("app.log", "w") as f:
        f.write(text)
    rotate("app.log", 2)
assert open("app.log").read() == ""
assert open("app.log.1").read() == "c", open("app.log.1").read()
assert open("app.log.2").read() == "b"
assert not os.path.exists("app.log.3")
'''),
    dict(name="j_split_file", category="D", entry="splitter.py",
         files={"splitter.py": '''def split_file(path, lines_per_part):
    """Split a text file into path.part1, path.part2, ...; returns the part file names in order."""
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    names = []
    for k in range(len(lines) // lines_per_part):
        name = f"{path}.part{k + 1}"
        with open(name, "w", encoding="utf-8") as w:
            w.writelines(lines[k * lines_per_part:(k + 1) * lines_per_part])
        names.append(name)
    return names
'''},
         spec="The last part may be shorter than lines_per_part, but it must still be written: a 5-line file "
              "split by 2 gives 3 parts. Right now the tail of the file is lost.",
         reference='''def split_file(path, lines_per_part):
    """Split a text file into path.part1, path.part2, ...; returns the part file names in order."""
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    names = []
    for k in range(0, len(lines), lines_per_part):
        name = f"{path}.part{k // lines_per_part + 1}"
        with open(name, "w", encoding="utf-8") as w:
            w.writelines(lines[k:k + lines_per_part])
        names.append(name)
    return names
''',
         test='''from splitter import split_file
open("big.txt", "w", encoding="utf-8").write("1\\n2\\n3\\n4\\n5\\n")
assert split_file("big.txt", 2) == ["big.txt.part1", "big.txt.part2", "big.txt.part3"]
assert open("big.txt.part3", encoding="utf-8").read() == "5\\n"
assert open("big.txt.part1", encoding="utf-8").read() == "1\\n2\\n"
'''),
    dict(name="j_dir_size", category="D", entry="du.py",
         files={"du.py": '''import os


def dir_size(folder):
    """Total size in bytes of all files under folder."""
    return sum(os.path.getsize(os.path.join(folder, n)) for n in os.listdir(folder))
'''},
         spec="dir_size must count every file in every sub-folder (folders themselves add nothing).",
         reference='''import os


def dir_size(folder):
    """Total size in bytes of all files under folder."""
    total = 0
    for dirpath, _, names in os.walk(folder):
        for n in names:
            total += os.path.getsize(os.path.join(dirpath, n))
    return total
''',
         test='''import os
from du import dir_size
os.makedirs("root/a/b", exist_ok=True)
for p, size in (("root/x.bin", 10), ("root/a/y.bin", 20), ("root/a/b/z.bin", 30)):
    with open(p, "wb") as f:
        f.write(b"0" * size)
assert dir_size("root") == 60, dir_size("root")
'''),
    dict(name="j_copy_tree_ext", category="D", entry="publish.py",
         files={"publish.py": '''import os
import shutil


def copy_ext(src, dst, ext):
    """Copy every file under src whose name ends with ext into dst, keeping the folder layout."""
    for dirpath, _, names in os.walk(src):
        for n in names:
            if n.endswith(ext):
                os.makedirs(dst, exist_ok=True)
                shutil.copyfile(os.path.join(dirpath, n), os.path.join(dst, n))
'''},
         spec="Files must keep their relative folders under dst: src/css/site.css goes to dst/css/site.css, not "
              "dst/site.css (two files with the same name in different folders currently overwrite each other).",
         reference='''import os
import shutil


def copy_ext(src, dst, ext):
    """Copy every file under src whose name ends with ext into dst, keeping the folder layout."""
    for dirpath, _, names in os.walk(src):
        for n in names:
            if n.endswith(ext):
                rel = os.path.relpath(dirpath, src)
                target = os.path.join(dst, rel)
                os.makedirs(target, exist_ok=True)
                shutil.copyfile(os.path.join(dirpath, n), os.path.join(target, n))
''',
         test='''import os
from publish import copy_ext
for p, text in (("site/css/main.css", "a"), ("site/admin/css/main.css", "b"), ("site/index.html", "c")):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(text)
copy_ext("site", "out", ".css")
assert open("out/css/main.css").read() == "a"
assert open("out/admin/css/main.css").read() == "b"
assert not os.path.exists("out/index.html")
'''),
    dict(name="j_line_endings", category="D", entry="eol.py",
         files={"eol.py": '''def to_unix(path):
    """Rewrite a text file in place with Unix line endings (LF only)."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
'''},
         spec="After to_unix the file's bytes must contain only '\\n' line endings (CRLF and lone CR both become "
              "LF); on Windows the file still comes out with CRLF.",
         reference='''def to_unix(path):
    """Rewrite a text file in place with Unix line endings (LF only)."""
    with open(path, "rb") as f:
        data = f.read()
    with open(path, "wb") as f:
        f.write(data.replace(b"\\r\\n", b"\\n").replace(b"\\r", b"\\n"))
''',
         test='''from eol import to_unix
with open("mixed.txt", "wb") as f:
    f.write(b"a\\r\\nb\\rc\\n")
to_unix("mixed.txt")
with open("mixed.txt", "rb") as f:
    assert f.read() == b"a\\nb\\nc\\n"
'''),
    dict(name="j_unique_name", category="D", entry="naming.py",
         files={"naming.py": '''import os


def unique_name(folder, name):
    """A file name in folder that is not taken yet: 'report.txt', then 'report (1).txt', ..."""
    if not os.path.exists(os.path.join(folder, name)):
        return name
    return name + " (1)"
'''},
         spec="The counter goes before the extension and keeps counting until the name is free: with report.txt "
              "and 'report (1).txt' taken, the answer is 'report (2).txt'. Names without an extension get "
              "'notes (1)'.",
         reference='''import os


def unique_name(folder, name):
    """A file name in folder that is not taken yet: 'report.txt', then 'report (1).txt', ..."""
    if not os.path.exists(os.path.join(folder, name)):
        return name
    stem, ext = os.path.splitext(name)
    k = 1
    while os.path.exists(os.path.join(folder, f"{stem} ({k}){ext}")):
        k += 1
    return f"{stem} ({k}){ext}"
''',
         test='''import os
from naming import unique_name
os.makedirs("docs", exist_ok=True)
assert unique_name("docs", "report.txt") == "report.txt"
open("docs/report.txt", "w").close()
open("docs/report (1).txt", "w").close()
assert unique_name("docs", "report.txt") == "report (2).txt", unique_name("docs", "report.txt")
open("docs/notes", "w").close()
assert unique_name("docs", "notes") == "notes (1)"
'''),
]
