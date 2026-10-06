"""Calibration pool, category C (bad, missing or unusual input): 12 new tasks in tier2b's format (Laya partner
spec §4). Each carries `reference`, used only by validate_tasks.py; it is never shown to a model."""

TASKS = [
    dict(name="c_parse_int_or", category="C", entry="solution.py",
         files={"solution.py": '''def parse_int_or(s, default):
    """Parse s as an integer, or return default."""
    return int(s)
'''},
         spec="Return int(s) for numeric text, allowing surrounding spaces (' 12 ' -> 12, '-3' -> -3); return "
              "default for None, empty or non-numeric text instead of raising.",
         reference='''def parse_int_or(s, default):
    """Parse s as an integer, or return default."""
    if s is None:
        return default
    try:
        return int(str(s).strip())
    except ValueError:
        return default
''',
         test='''from solution import parse_int_or
assert parse_int_or(" 12 ", 0) == 12
assert parse_int_or("-3", 0) == -3
assert parse_int_or(None, 7) == 7
assert parse_int_or("", 7) == 7
assert parse_int_or("abc", -1) == -1
'''),
    dict(name="c_deep_get", category="C", entry="solution.py",
         files={"solution.py": '''def deep_get(data, path, default=None):
    """Follow a dotted path through dicts and lists: deep_get(d, "a.items.0.name")."""
    cur = data
    for part in path.split("."):
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur
'''},
         spec="deep_get must return default whenever the path cannot be followed: a missing key, a list index "
              "out of range or not a number, or a value that is neither a dict nor a list. It must never raise.",
         reference='''def deep_get(data, path, default=None):
    """Follow a dotted path through dicts and lists: deep_get(d, "a.items.0.name")."""
    cur = data
    for part in path.split("."):
        if isinstance(cur, dict):
            if part not in cur:
                return default
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return default
        else:
            return default
    return cur
''',
         test='''from solution import deep_get
d = {"a": {"items": [{"name": "x"}, {"name": "y"}]}, "n": 5}
assert deep_get(d, "a.items.1.name") == "y"
assert deep_get(d, "a.missing", "dflt") == "dflt"
assert deep_get(d, "a.items.9.name") is None
assert deep_get(d, "a.items.first") is None
assert deep_get(d, "n.value", 0) == 0
'''),
    dict(name="c_mean_or_none", category="C", entry="solution.py",
         files={"solution.py": '''def mean(xs):
    """Arithmetic mean of a list of numbers."""
    return sum(xs) / len(xs)
'''},
         spec="Return the arithmetic mean; for an empty list (or None) return None instead of raising.",
         reference='''def mean(xs):
    """Arithmetic mean of a list of numbers."""
    if not xs:
        return None
    return sum(xs) / len(xs)
''',
         test='''from solution import mean
assert mean([1, 2, 3, 4]) == 2.5
assert mean([]) is None
assert mean(None) is None
assert mean([5]) == 5
'''),
    dict(name="c_clean_email", category="C", entry="solution.py",
         files={"solution.py": '''def clean_email(raw):
    """Normalize an email address for comparison."""
    return raw.strip().lower()
'''},
         spec="Strip surrounding whitespace and lower-case the address; None must give '' instead of raising.",
         reference='''def clean_email(raw):
    """Normalize an email address for comparison."""
    if raw is None:
        return ""
    return raw.strip().lower()
''',
         test='''from solution import clean_email
assert clean_email("  Bob@Example.COM ") == "bob@example.com"
assert clean_email(None) == ""
assert clean_email("") == ""
assert clean_email("a@b.c") == "a@b.c"
'''),
    dict(name="c_split_tags", category="C", entry="solution.py",
         files={"solution.py": '''def split_tags(text):
    """Split a comma-separated tag string into a list of tags."""
    return [t.strip() for t in text.split(",")]
'''},
         spec="Return the non-empty, stripped tags: 'a, ,b,,' -> ['a', 'b']; None or '' -> [].",
         reference='''def split_tags(text):
    """Split a comma-separated tag string into a list of tags."""
    if not text:
        return []
    return [t.strip() for t in text.split(",") if t.strip()]
''',
         test='''from solution import split_tags
assert split_tags("a, ,b,,") == ["a", "b"], split_tags("a, ,b,,")
assert split_tags(None) == []
assert split_tags("") == []
assert split_tags(" red ,blue") == ["red", "blue"]
'''),
    dict(name="c_pct_change", category="C", entry="solution.py",
         files={"solution.py": '''def pct_change(old, new):
    """Percentage change from old to new."""
    return (new - old) / old * 100
'''},
         spec="Return the percentage change from old to new (100 -> 150 is 50.0); when old is 0 the change is "
              "undefined, so return None instead of raising.",
         reference='''def pct_change(old, new):
    """Percentage change from old to new."""
    if old == 0:
        return None
    return (new - old) / old * 100
''',
         test='''from solution import pct_change
assert pct_change(100, 150) == 50.0
assert pct_change(0, 5) is None
assert pct_change(200, 100) == -50.0
assert pct_change(0, 0) is None
'''),
    dict(name="c_first_or", category="C", entry="solution.py",
         files={"solution.py": '''def first_or(items, default=None):
    """The first item of an iterable, or default if it is empty."""
    if items:
        return items[0]
    return default
'''},
         spec="first_or must work for any iterable, including generators and sets, and return default when the "
              "iterable is empty.",
         reference='''def first_or(items, default=None):
    """The first item of an iterable, or default if it is empty."""
    for x in items:
        return x
    return default
''',
         test='''from solution import first_or
assert first_or([3, 4]) == 3
assert first_or([], "none") == "none"
assert first_or(x * 2 for x in [5, 6]) == 10
assert first_or(iter([]), 0) == 0
assert first_or({"only"}) == "only"
'''),
    dict(name="c_clamp_checked", category="C", entry="solution.py",
         files={"solution.py": '''def clamp(x, lo, hi):
    """Limit x to the range [lo, hi]."""
    return max(lo, min(x, hi))
'''},
         spec="Clamp x into [lo, hi]. If lo > hi the bounds are invalid: raise ValueError instead of returning a "
              "number.",
         reference='''def clamp(x, lo, hi):
    """Limit x to the range [lo, hi]."""
    if lo > hi:
        raise ValueError(f"lo {lo} > hi {hi}")
    return max(lo, min(x, hi))
''',
         test='''from solution import clamp
assert clamp(5, 0, 3) == 3
assert clamp(-2, 0, 3) == 0
assert clamp(2, 2, 2) == 2
try:
    clamp(1, 5, 0)
    raise AssertionError("expected ValueError")
except ValueError:
    pass
'''),
    dict(name="c_parse_pairs", category="C", entry="solution.py",
         files={"solution.py": '''def parse_pairs(text):
    """Parse 'a=1;b=2' into {'a': '1', 'b': '2'}."""
    out = {}
    for item in text.split(";"):
        key, value = item.split("=")
        out[key.strip()] = value.strip()
    return out
'''},
         spec="Skip malformed items instead of raising: items without '=', or with an empty key, are ignored; an "
              "empty value is kept. 'a=1;b=;=3;c;d=4' -> {'a': '1', 'b': '', 'd': '4'}.",
         reference='''def parse_pairs(text):
    """Parse 'a=1;b=2' into {'a': '1', 'b': '2'}."""
    out = {}
    for item in text.split(";"):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        if not key.strip():
            continue
        out[key.strip()] = value.strip()
    return out
''',
         test='''from solution import parse_pairs
assert parse_pairs("a=1;b=;=3;c;d=4") == {"a": "1", "b": "", "d": "4"}, parse_pairs("a=1;b=;=3;c;d=4")
assert parse_pairs("") == {}
assert parse_pairs("x = 5") == {"x": "5"}
'''),
    dict(name="c_to_bool", category="C", entry="solution.py",
         files={"solution.py": '''def to_bool(value):
    """Interpret a config value as a boolean."""
    return bool(value)
'''},
         spec="Accept True/False as they are and the strings yes/no, true/false, on/off, 1/0 in any case with "
              "surrounding spaces. Anything else raises ValueError.",
         reference='''TRUE = {"yes", "true", "on", "1"}
FALSE = {"no", "false", "off", "0"}


def to_bool(value):
    """Interpret a config value as a boolean."""
    if isinstance(value, bool):
        return value
    s = str(value).strip().lower()
    if s in TRUE:
        return True
    if s in FALSE:
        return False
    raise ValueError(f"not a boolean: {value!r}")
''',
         test='''from solution import to_bool
assert to_bool(" YES ") is True
assert to_bool("no") is False
assert to_bool("0") is False
assert to_bool(False) is False
assert to_bool("On") is True
try:
    to_bool("maybe")
    raise AssertionError("expected ValueError")
except ValueError:
    pass
'''),
    dict(name="c_max_by", category="C", entry="solution.py",
         files={"solution.py": '''def max_by(items, key):
    """The dict in items with the largest value under key."""
    return max(items, key=lambda d: d[key])
'''},
         spec="Skip dicts that lack the key; if no dict has it (or items is empty), return None instead of "
              "raising.",
         reference='''def max_by(items, key):
    """The dict in items with the largest value under key."""
    having = [d for d in items if key in d]
    if not having:
        return None
    return max(having, key=lambda d: d[key])
''',
         test='''from solution import max_by
rows = [{"n": 3}, {"x": 9}, {"n": 7}]
assert max_by(rows, "n") == {"n": 7}
assert max_by([{"x": 1}], "n") is None
assert max_by([], "n") is None
'''),
    dict(name="c_truncate", category="C", entry="solution.py",
         files={"solution.py": '''def truncate(text, n):
    """At most the first n characters of text."""
    return text[:n]
'''},
         spec="Return at most the first n characters; None gives ''; a negative n is a caller error and raises "
              "ValueError (it must not cut characters off the end).",
         reference='''def truncate(text, n):
    """At most the first n characters of text."""
    if n < 0:
        raise ValueError("n must be >= 0")
    if text is None:
        return ""
    return text[:n]
''',
         test='''from solution import truncate
assert truncate("hello", 3) == "hel"
assert truncate("hi", 10) == "hi"
assert truncate(None, 4) == ""
assert truncate("abc", 0) == ""
try:
    truncate("hello", -2)
    raise AssertionError("expected ValueError")
except ValueError:
    pass
'''),
]
