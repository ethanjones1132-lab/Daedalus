"""Judge set, category C (bad, missing or unusual input): 12 new tasks in tier2b's format (Laya partner spec §4).
Scoring only. Each carries `reference`, used only by validate_tasks.py; it is never shown to a model."""

TASKS = [
    dict(name="j_safe_json_loads", category="C", entry="solution.py",
         files={"solution.py": '''import json


def safe_loads(text, default=None):
    """Parse JSON text, or return default when it cannot be parsed."""
    return json.loads(text)
'''},
         spec="Return the parsed value for valid JSON; return default for invalid JSON, None or empty text instead "
              "of raising.",
         reference='''import json


def safe_loads(text, default=None):
    """Parse JSON text, or return default when it cannot be parsed."""
    if not text:
        return default
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return default
''',
         test='''from solution import safe_loads
assert safe_loads('{"a": 1}') == {"a": 1}
assert safe_loads("{bad", {}) == {}
assert safe_loads(None, 0) == 0
assert safe_loads("", "d") == "d"
assert safe_loads("[1, 2]") == [1, 2]
'''),
    dict(name="j_parse_duration", category="C", entry="solution.py",
         files={"solution.py": '''import re


def parse_duration(text):
    """'1h30m' -> 5400 seconds; also '45s', '2h', '10m5s'."""
    h, m, s = re.fullmatch(r"(\\d+)h(\\d+)m(\\d+)s", text).groups()
    return int(h) * 3600 + int(m) * 60 + int(s)
'''},
         spec="Each of the h, m and s parts is optional but at least one must be present, in that order: "
              "'1h30m' -> 5400, '45s' -> 45, '10m5s' -> 605. Anything else (including '', None, '5x') returns None.",
         reference='''import re


def parse_duration(text):
    """'1h30m' -> 5400 seconds; also '45s', '2h', '10m5s'."""
    if not text:
        return None
    m = re.fullmatch(r"(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?", text.strip())
    if not m or not any(m.groups()):
        return None
    h, mi, s = (int(g) if g else 0 for g in m.groups())
    return h * 3600 + mi * 60 + s
''',
         test='''from solution import parse_duration
assert parse_duration("1h30m") == 5400, parse_duration("1h30m")
assert parse_duration("45s") == 45
assert parse_duration("10m5s") == 605
assert parse_duration("1h2m3s") == 3723
assert parse_duration("") is None
assert parse_duration(None) is None
assert parse_duration("5x") is None
'''),
    dict(name="j_mean_skip_none", category="C", entry="solution.py",
         files={"solution.py": '''def mean_reading(readings):
    """Average of sensor readings."""
    return sum(readings) / len(readings)
'''},
         spec="Sensor readings can be None (a missed sample): average only the real readings; if there are none "
              "at all, return None.",
         reference='''def mean_reading(readings):
    """Average of sensor readings."""
    real = [r for r in readings if r is not None]
    if not real:
        return None
    return sum(real) / len(real)
''',
         test='''from solution import mean_reading
assert mean_reading([1, None, 3]) == 2
assert mean_reading([None, None]) is None
assert mean_reading([]) is None
assert mean_reading([4.5]) == 4.5
'''),
    dict(name="j_env_int", category="C", entry="solution.py",
         files={"solution.py": '''def env_int(env, name, default):
    """Integer setting from an environment mapping, e.g. env_int(os.environ, "WORKERS", 4)."""
    return int(env[name])
'''},
         spec="Return default when the variable is missing, empty or not an integer; surrounding spaces are "
              "allowed: {'WORKERS': ' 8 '} -> 8.",
         reference='''def env_int(env, name, default):
    """Integer setting from an environment mapping, e.g. env_int(os.environ, "WORKERS", 4)."""
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default
''',
         test='''from solution import env_int
assert env_int({"WORKERS": " 8 "}, "WORKERS", 4) == 8
assert env_int({}, "WORKERS", 4) == 4
assert env_int({"WORKERS": ""}, "WORKERS", 4) == 4
assert env_int({"WORKERS": "many"}, "WORKERS", 4) == 4
'''),
    dict(name="j_split_full_name", category="C", entry="solution.py",
         files={"solution.py": '''def split_name(full):
    """(first, last) from a full name."""
    first, last = full.split(" ")
    return first, last
'''},
         spec="Split on any run of whitespace, ignoring leading and trailing spaces. The first word is the first "
              "name and the rest joined by single spaces is the last name; one word gives (word, ''); empty or "
              "None gives ('', '').",
         reference='''def split_name(full):
    """(first, last) from a full name."""
    parts = (full or "").split()
    if not parts:
        return "", ""
    return parts[0], " ".join(parts[1:])
''',
         test='''from solution import split_name
assert split_name("Ada Lovelace") == ("Ada", "Lovelace")
assert split_name("  Ada   King  Lovelace ") == ("Ada", "King Lovelace")
assert split_name("Cher") == ("Cher", "")
assert split_name(None) == ("", "")
assert split_name("") == ("", "")
'''),
    dict(name="j_parse_price", category="C", entry="solution.py",
         files={"solution.py": '''def parse_price(text):
    """'$1,234.50' -> 1234.5"""
    return float(text.replace("$", ""))
'''},
         spec="Accept an optional '$', thousands commas and surrounding spaces: '$1,234.50' -> 1234.5, ' 7 ' -> "
              "7.0. Return None for None, '' or anything that is not a price.",
         reference='''def parse_price(text):
    """'$1,234.50' -> 1234.5"""
    if not text:
        return None
    try:
        return float(text.strip().lstrip("$").replace(",", ""))
    except ValueError:
        return None
''',
         test='''from solution import parse_price
assert parse_price("$1,234.50") == 1234.5, parse_price("$1,234.50")
assert parse_price(" 7 ") == 7.0
assert parse_price(None) is None
assert parse_price("") is None
assert parse_price("free") is None
'''),
    dict(name="j_last_n", category="C", entry="solution.py",
         files={"solution.py": '''def last_n(items, n):
    """The last n items of a list."""
    return items[-n:]
'''},
         spec="Return the last n items: all of them when n is larger than the list, and [] when n is 0 or "
              "negative.",
         reference='''def last_n(items, n):
    """The last n items of a list."""
    if n <= 0:
        return []
    return items[-n:]
''',
         test='''from solution import last_n
assert last_n([1, 2, 3], 2) == [2, 3]
assert last_n([1, 2], 5) == [1, 2]
assert last_n([1, 2, 3], 0) == [], last_n([1, 2, 3], 0)
assert last_n([1, 2, 3], -1) == []
'''),
    dict(name="j_normalize_phone", category="C", entry="solution.py",
         files={"solution.py": '''def normalize_phone(raw):
    """Digits of a US phone number, e.g. '(555) 123-4567' -> '5551234567'."""
    return "".join(ch for ch in raw if ch.isdigit())
'''},
         spec="Keep only the digits; drop a leading country code 1 from 11-digit numbers. Return None if the "
              "result is not exactly 10 digits, or if raw is None.",
         reference='''def normalize_phone(raw):
    """Digits of a US phone number, e.g. '(555) 123-4567' -> '5551234567'."""
    if raw is None:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits if len(digits) == 10 else None
''',
         test='''from solution import normalize_phone
assert normalize_phone("(555) 123-4567") == "5551234567"
assert normalize_phone("+1 555 123 4567") == "5551234567"
assert normalize_phone("123") is None
assert normalize_phone(None) is None
'''),
    dict(name="j_pairs_to_dict", category="C", entry="solution.py",
         files={"solution.py": '''def pairs_to_dict(flat):
    """['a', 1, 'b', 2] -> {'a': 1, 'b': 2}"""
    return {flat[i]: flat[i + 1] for i in range(0, len(flat) - 1, 2)}
'''},
         spec="Turn a flat [key, value, key, value, ...] list into a dict. An odd-length list is malformed and "
              "must raise ValueError instead of silently dropping the last key.",
         reference='''def pairs_to_dict(flat):
    """['a', 1, 'b', 2] -> {'a': 1, 'b': 2}"""
    if len(flat) % 2:
        raise ValueError("odd number of items")
    return {flat[i]: flat[i + 1] for i in range(0, len(flat), 2)}
''',
         test='''from solution import pairs_to_dict
assert pairs_to_dict(["a", 1, "b", 2]) == {"a": 1, "b": 2}
assert pairs_to_dict([]) == {}
try:
    pairs_to_dict(["a", 1, "b"])
    raise AssertionError("expected ValueError")
except ValueError:
    pass
'''),
    dict(name="j_index_or", category="C", entry="solution.py",
         files={"solution.py": '''def index_or(items, value):
    """Position of value in items, or -1."""
    return items.index(value)
'''},
         spec="Return the first position of value, or -1 when it is absent or items is None; never raise.",
         reference='''def index_or(items, value):
    """Position of value in items, or -1."""
    if items is None:
        return -1
    try:
        return items.index(value)
    except ValueError:
        return -1
''',
         test='''from solution import index_or
assert index_or(["a", "b", "a"], "a") == 0
assert index_or(["a"], "z") == -1
assert index_or(None, "a") == -1
'''),
    dict(name="j_sum_numeric", category="C", entry="solution.py",
         files={"solution.py": '''def sum_numeric(values):
    """Sum of the numbers in a mixed list."""
    return sum(values)
'''},
         spec="Add up only real numbers (int and float); skip strings, None and booleans (True is not 1 here). "
              "An empty or all-skipped list sums to 0.",
         reference='''def sum_numeric(values):
    """Sum of the numbers in a mixed list."""
    return sum(v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool))
''',
         test='''from solution import sum_numeric
assert sum_numeric([1, "2", None, 3.5, True]) == 4.5
assert sum_numeric([]) == 0
assert sum_numeric(["x", False]) == 0
'''),
    dict(name="j_wrap_index", category="C", entry="solution.py",
         files={"solution.py": '''def cyclic_get(items, i):
    """Item i of a playlist that repeats forever: index 5 of a 3-item list is item 2."""
    return items[i]
'''},
         spec="Indexes wrap around in both directions (cyclic_get(['a', 'b', 'c'], 5) == 'c', index -1 is the last "
              "item); an empty or None playlist returns None instead of raising.",
         reference='''def cyclic_get(items, i):
    """Item i of a playlist that repeats forever: index 5 of a 3-item list is item 2."""
    if not items:
        return None
    return items[i % len(items)]
''',
         test='''from solution import cyclic_get
assert cyclic_get(["a", "b", "c"], 5) == "c", cyclic_get(["a", "b", "c"], 5)
assert cyclic_get(["a", "b", "c"], -1) == "c"
assert cyclic_get(["a", "b", "c"], -4) == "c"
assert cyclic_get([], 2) is None
assert cyclic_get(None, 0) is None
'''),
]
