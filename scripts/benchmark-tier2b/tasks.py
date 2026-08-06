"""Reproducible Tier-2B coding benchmark fixtures.

The two defects called out by Tier-2 are corrected in the seed fixtures:
``topological_sort`` has no accidental order reversal, and the discount
specification describes the observed symptom without leaking the answer.
"""

TASKS = [
    {
        "name": "merge_intervals", "category": "A", "entry": "solution.py",
        "files": {"solution.py": """def merge_intervals(intervals):
    if not intervals:
        return []
    merged = [intervals[0]]
    for start, end in intervals[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged
"""},
        "spec": "Return sorted, merged intervals for input in any order; touching intervals merge.",
        "test": """from solution import merge_intervals
assert merge_intervals([(1,3),(2,6),(8,10),(15,18)]) == [(1,6),(8,10),(15,18)]
assert merge_intervals([(5,6),(1,3),(2,4)]) == [(1,4),(5,6)]
assert merge_intervals([(1,4),(4,5)]) == [(1,5)]
assert merge_intervals([]) == []
print('OK')
""",
    },
    {
        "name": "lru_cache", "category": "A", "entry": "solution.py",
        "files": {"solution.py": """class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.data = {}
        self.order = []

    def get(self, key):
        if key not in self.data:
            return -1
        return self.data[key]

    def put(self, key, value):
        if key in self.data:
            self.order.remove(key)
        elif len(self.data) >= self.capacity:
            oldest = self.order.pop(0)
            del self.data[oldest]
        self.data[key] = value
        self.order.append(key)
"""},
        "spec": "Implement an LRU cache where a successful get refreshes recency; evict the least recently used key.",
        "test": """from solution import LRUCache
c = LRUCache(2)
c.put(1, 'a'); c.put(2, 'b')
assert c.get(1) == 'a'
c.put(3, 'c')
assert c.get(2) == -1 and c.get(1) == 'a' and c.get(3) == 'c'
print('OK')
""",
    },
    {
        "name": "topological_sort", "category": "A", "entry": "solution.py",
        "files": {"solution.py": """def topological_sort(graph):
    visited = set()
    order = []

    def visit(node):
        if node in visited:
            return
        visited.add(node)
        for dependency in graph.get(node, []):
            visit(dependency)
        order.append(node)

    for node in graph:
        visit(node)
    return order
"""},
        "spec": "Return every graph node after all dependencies; raise ValueError('cycle detected') for cycles.",
        "test": """from solution import topological_sort
def check(g):
    order = topological_sort(g)
    assert set(order) == set(g)
    pos = {n: i for i, n in enumerate(order)}
    for node, deps in g.items():
        for dep in deps:
            assert pos[dep] < pos[node]
check({'a': [], 'b': ['a'], 'c': ['a', 'b']})
check({'a': [], 'b': [], 'c': ['a', 'b'], 'd': ['c']})
try:
    topological_sort({'a': ['b'], 'b': ['a']})
    raise AssertionError('expected cycle error')
except ValueError as exc:
    assert str(exc) == 'cycle detected'
print('OK')
""",
    },
    {
        "name": "parse_csv_line", "category": "A", "entry": "solution.py",
        "files": {"solution.py": """def parse_csv_line(line):
    return line.split(',')
"""},
        "spec": "Parse one CSV line, preserving commas inside quoted fields and decoding doubled quotes.",
        "test": '''from solution import parse_csv_line
assert parse_csv_line('a,b,c') == ['a', 'b', 'c']
assert parse_csv_line('a,"b,c",d') == ['a', 'b,c', 'd']
assert parse_csv_line('"say ""hi""",x') == ['say "hi"', 'x']
assert parse_csv_line('') == ['']
print('OK')
''',
    },
    {
        "name": "pkg_discount", "category": "B", "entry": "calc.py", "hidden_file": "rules.py",
        "files": {
            "calc.py": """from rules import discount_rate

def total_price(subtotal):
    return round(subtotal * (1 - discount_rate(subtotal)), 2)
""",
            "rules.py": """def discount_rate(subtotal):
    if subtotal > 200:
        return 0.20
    if subtotal > 100:
        return 0.10
    return 0.0
""",
        },
        "spec": "Customers report that two exact boundary totals are charged full price; find and fix the package bug while preserving nearby-tier behavior.",
        "test": """from calc import total_price
assert total_price(50) == 50.0
assert total_price(100) == 90.0
assert total_price(150) == 135.0
assert total_price(200) == 160.0
assert total_price(250) == 200.0
print('OK')
""",
    },
    {
        "name": "pkg_auth", "category": "B", "entry": "session.py", "hidden_file": "tokens.py",
        "files": {
            "session.py": """from tokens import is_token_valid

def authorize(token, now):
    if not is_token_valid(token, now):
        raise PermissionError('token invalid or expired')
    return True
""",
            "tokens.py": """def is_token_valid(token, now):
    if token.get('revoked'):
        return False
    return now > token['expires_at']
""",
        },
        "spec": "Valid tokens must be unrevoked and not expired; expired or revoked tokens must raise PermissionError.",
        "test": """from session import authorize
assert authorize({'expires_at': 1000, 'revoked': False}, 500) is True
for token, now in [({'expires_at': 1000, 'revoked': False}, 1500), ({'expires_at': 2000, 'revoked': True}, 500)]:
    try:
        authorize(token, now)
        raise AssertionError('expected PermissionError')
    except PermissionError:
        pass
print('OK')
""",
    },
    {
        "name": "safe_divide_batch", "category": "C", "entry": "solution.py",
        "files": {"solution.py": """def safe_divide_batch(pairs):
    results = []
    for a, b in pairs:
        results.append(a / b)
    return results
"""},
        "spec": "Return one result per pair in order; use None for division by zero without skipping entries.",
        "test": """from solution import safe_divide_batch
r = safe_divide_batch([(10, 2), (5, 0), (9, 3)])
assert r == [5.0, None, 3.0], r
print('OK')
""",
    },
    {
        "name": "retry_with_backoff", "category": "C", "entry": "solution.py",
        "files": {"solution.py": """import time

def retry_with_backoff(fn, max_attempts=3):
    attempt = 0
    while True:
        try:
            return fn()
        except Exception:
            attempt += 1
            if attempt > max_attempts:
                raise
            time.sleep(0.01 * attempt)
"""},
        "spec": "Call fn at most max_attempts total, return on success, and re-raise the final error without a final sleep.",
        "test": """from solution import retry_with_backoff
class Flaky:
    def __init__(self, fail_times): self.calls = 0; self.fail_times = fail_times
    def __call__(self):
        self.calls += 1
        if self.calls <= self.fail_times: raise ValueError('boom')
        return 'ok'
f = Flaky(2); assert retry_with_backoff(f, 3) == 'ok' and f.calls == 3
f = Flaky(5)
try: retry_with_backoff(f, 3); raise AssertionError('expected error')
except ValueError: pass
assert f.calls == 3
print('OK')
""",
    },
    {
        "name": "load_or_create_json", "category": "D", "entry": "config_store.py",
        "files": {"config_store.py": """import json

def load_or_create(path, default):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
"""},
        "spec": "Load JSON when present; otherwise create parent directories and persist the default before returning it.",
        "test": """import tempfile
from pathlib import Path
from config_store import load_or_create
with tempfile.TemporaryDirectory() as root:
    path = Path(root) / 'nested' / 'settings.json'
    default = {'enabled': True, 'retries': 2}
    assert load_or_create(path, default) == default
    assert path.exists()
    assert load_or_create(path, {'enabled': False}) == default
print('OK')
""",
    },
    {
        "name": "run_checked", "category": "D", "entry": "process_runner.py",
        "files": {"process_runner.py": """import subprocess

def run_checked(argv):
    completed = subprocess.run(argv)
    if completed.returncode:
        raise RuntimeError('command failed')
    return ''
"""},
        "spec": "Run argv without a shell, return trimmed stdout on success, and raise RuntimeError containing stderr on failure.",
        "test": """import sys
from process_runner import run_checked
assert run_checked([sys.executable, '-c', 'print(\"ready\")']) == 'ready'
try:
    run_checked([sys.executable, '-c', 'import sys; print(\"bad\", file=sys.stderr); sys.exit(3)'])
    raise AssertionError('expected RuntimeError')
except RuntimeError as exc:
    assert 'bad' in str(exc)
print('OK')
""",
    },
    # Category E (Phase A1 symbol grounding): workspace seeds a small library whose
    # correct API differs from a plausible-but-wrong name in the task prose.
    # Oracle = _t.py tests + no fabricated symbol in the landed solution.
    {
        "name": "clamp_with_lib", "category": "E", "entry": "solution.py",
        "files": {
            "lib/mathutil.py": """def clampValue(x, lo, hi):
    \"\"\"Inclusive clamp used by the project DSP path.\"\"\"
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x
""",
            "solution.py": """# TODO: clamp samples to [0.0, 1.0] using the project math library.
def clamp_sample(x):
    return x
""",
            "solution_t.py": """from solution import clamp_sample
assert clamp_sample(-1.0) == 0.0
assert clamp_sample(0.5) == 0.5
assert clamp_sample(2.0) == 1.0
print('OK')
""",
        },
        "spec": (
            "Implement clamp_sample so it clamps to [0.0, 1.0]. "
            "A prior draft tried `juce::isnan` and `fastClamp` — those are NOT available. "
            "Use the real helper from lib/mathutil.py (`clampValue`) only."
        ),
        "test": """from solution import clamp_sample
import inspect
import solution as sol_mod
src = inspect.getsource(sol_mod)
assert 'juce::isnan' not in src and 'fastClamp' not in src, 'fabricated symbol in landed solution'
assert clamp_sample(-1.0) == 0.0
assert clamp_sample(0.5) == 0.5
assert clamp_sample(2.0) == 1.0
print('OK')
""",
    },
    {
        "name": "find_rotation_point", "category": "A", "entry": "solution.py",
        "files": {"solution.py": """def find_rotation_point(arr):
    \"\"\"Index of the smallest element in a rotated sorted array.\"\"\"
    if not arr:
        return -1
    lo, hi = 0, len(arr) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if arr[mid] > arr[lo]:
            lo = mid + 1
        else:
            hi = mid
    return lo
"""},
        "spec": (
            "find_rotation_point returns the index of the smallest element in a "
            "rotated sorted array. Bug report: a non-rotated array like [1,2,3,4,5] "
            "returns 3 instead of 0, and [2,1] returns 0 instead of 1. Empty input "
            "must still return -1."
        ),
        "test": """from solution import find_rotation_point
assert find_rotation_point([4,5,6,7,0,1,2]) == 4
assert find_rotation_point([1,2,3,4,5]) == 0
assert find_rotation_point([2,1]) == 1
assert find_rotation_point([5,1,2,3,4]) == 1
assert find_rotation_point([]) == -1
print('OK')
""",
    },
    {
        "name": "nested_lookup", "category": "C", "entry": "solution.py",
        "files": {"solution.py": """def nested_lookup(data, path, default=None):
    \"\"\"Walk a dotted path through nested dicts, returning default if absent.\"\"\"
    current = data
    for part in path.split('.'):
        if not current.get(part):
            return default
        current = current[part]
    return current
"""},
        "spec": (
            "nested_lookup(data, path, default) walks a dotted path through nested "
            "dicts. Two defects: a value that is present but falsy (0, '', False) is "
            "wrongly reported as missing, and a non-dict value partway down the path "
            "raises AttributeError instead of returning the default."
        ),
        "test": """from solution import nested_lookup
assert nested_lookup({'a': {'b': {'c': 1}}}, 'a.b.c') == 1
assert nested_lookup({'a': {'b': 0}}, 'a.b') == 0
assert nested_lookup({'a': {'b': ''}}, 'a.b', 'x') == ''
assert nested_lookup({'a': 1}, 'a.b', 'x') == 'x'
assert nested_lookup({}, 'a', 'd') == 'd'
print('OK')
""",
    },
    {
        "name": "slugify_with_lib", "category": "E", "entry": "solution.py",
        "files": {
            "lib/textutil.py": """def normalize_token(text):
    \"\"\"Lowercase, strip, and collapse internal whitespace to single spaces.\"\"\"
    return " ".join(text.lower().split())
""",
            "solution.py": """# TODO: build slugify(text) using the project text library.
def slugify(text):
    return text
""",
            "solution_t.py": """from solution import slugify
assert slugify('  Hello   World  ') == 'hello-world'
print('OK')
""",
        },
        "spec": (
            "Implement slugify(text) so it lowercases, collapses whitespace, and joins "
            "words with single hyphens. A prior draft tried `strutil.toKebab` and "
            "`fastSlug` - those are NOT available. Use the real helper from "
            "lib/textutil.py (`normalize_token`) only."
        ),
        "test": """from solution import slugify
import inspect
import solution as sol_mod
src = inspect.getsource(sol_mod)
assert 'strutil.toKebab' not in src and 'fastSlug' not in src, 'fabricated symbol in landed solution'
assert slugify('  Hello   World  ') == 'hello-world'
assert slugify('Already-Fine') == 'already-fine'
assert slugify('Multi   Space Here') == 'multi-space-here'
print('OK')
""",
    },
    # --- D1 expansion: categories A–E toward 30–50 suite ---
    {
        "name": "binary_search_first", "category": "A", "entry": "search.py",
        "files": {"search.py": """def binary_search_first(arr, target):
    \"\"\"Return the index of the first occurrence of target, or -1.\"\"\"
    lo, hi = 0, len(arr) - 1
    ans = -1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            ans = mid
            lo = mid + 1  # keeps searching right — finds last, not first
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return ans
"""},
        "spec": (
            "binary_search_first(arr, target) should return the index of the FIRST "
            "occurrence of target in a sorted array, or -1 if absent. Bug report: "
            "on [1,2,2,2,3] searching for 2 returns 3 instead of 1."
        ),
        "test": """from search import binary_search_first
assert binary_search_first([1, 2, 2, 2, 3], 2) == 1
assert binary_search_first([1, 2, 2, 2, 3], 1) == 0
assert binary_search_first([1, 2, 2, 2, 3], 4) == -1
assert binary_search_first([], 1) == -1
print('OK')
""",
    },
    {
        "name": "group_anagrams", "category": "A", "entry": "anagrams.py",
        "files": {"anagrams.py": """def group_anagrams(words):
    groups = {}
    for w in words:
        key = w
        groups.setdefault(key, []).append(w)
    return list(groups.values())
"""},
        "spec": (
            "group_anagrams(words) groups words that are anagrams of each other "
            "(case-insensitive letter multiset). Order of groups and words within "
            "a group is not specified. Bug report: 'Listen' and 'Silent' land in "
            "separate groups."
        ),
        "test": """from anagrams import group_anagrams
def normalize(groups):
    return sorted(sorted(g) for g in groups)
assert normalize(group_anagrams(['eat', 'tea', 'tan', 'ate', 'nat', 'bat'])) == normalize(
    [['eat', 'tea', 'ate'], ['tan', 'nat'], ['bat']]
)
assert normalize(group_anagrams(['Listen', 'Silent', 'enlist'])) == normalize(
    [['Listen', 'Silent', 'enlist']]
)
assert normalize(group_anagrams([])) == []
print('OK')
""",
    },
    {
        "name": "drop_negatives", "category": "A", "entry": "filters.py",
        "files": {"filters.py": """def drop_negatives(nums):
    for x in nums:
        if x < 0:
            nums.remove(x)
    return nums
"""},
        "spec": (
            "drop_negatives(nums) must return a list containing only the non-negative "
            "values from nums, preserving relative order. Callers report that consecutive "
            "negatives are not all removed."
        ),
        "test": """from filters import drop_negatives
assert drop_negatives([-1, -2, 3, -4, 5]) == [3, 5]
assert drop_negatives([1, 2, 3]) == [1, 2, 3]
assert drop_negatives([-5, -1, -2]) == []
assert drop_negatives([]) == []
print('OK')
""",
    },
    {
        "name": "merge_sorted", "category": "A", "entry": "merge.py",
        "files": {"merge.py": """def merge_sorted(a, b):
    i = j = 0
    out = []
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            out.append(a[i])
            i += 1
        else:
            out.append(b[j])
            j += 1
    return out
"""},
        "spec": (
            "merge_sorted(a, b) merges two ascending lists into one ascending list. "
            "Bug report: when one list is longer, trailing elements are dropped."
        ),
        "test": """from merge import merge_sorted
assert merge_sorted([1, 3, 5], [2, 4, 6]) == [1, 2, 3, 4, 5, 6]
assert merge_sorted([1, 2, 3], []) == [1, 2, 3]
assert merge_sorted([], [4, 5]) == [4, 5]
assert merge_sorted([1, 1], [1, 2]) == [1, 1, 1, 2]
print('OK')
""",
    },
    {
        "name": "roman_to_int", "category": "A", "entry": "roman.py",
        "files": {"roman.py": """def roman_to_int(s):
    vals = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100, 'D': 500, 'M': 1000}
    total = 0
    for c in s:
        total += vals[c]
    return total
"""},
        "spec": (
            "roman_to_int(s) converts a Roman numeral string to an integer. Bug report: "
            "subtractive forms like IV and IX are over-counted (IV yields 6 instead of 4)."
        ),
        "test": """from roman import roman_to_int
assert roman_to_int('III') == 3
assert roman_to_int('IV') == 4
assert roman_to_int('IX') == 9
assert roman_to_int('LVIII') == 58
assert roman_to_int('MCMXCIV') == 1994
print('OK')
""",
    },
    {
        "name": "is_balanced", "category": "A", "entry": "brackets.py",
        "files": {"brackets.py": """def is_balanced(s):
    depth = 0
    for c in s:
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth < 0:
                return False
    return depth == 0
"""},
        "spec": (
            "is_balanced(s) returns True when (), [], and {} are correctly nested and "
            "matched. Bug report: strings that only use square or curly braces are "
            "always treated as balanced, and mixed mismatches like '(]' pass."
        ),
        "test": """from brackets import is_balanced
assert is_balanced('()[]{}') is True
assert is_balanced('([{}])') is True
assert is_balanced('(]') is False
assert is_balanced('([)]') is False
assert is_balanced('{[]}') is True
assert is_balanced('') is True
print('OK')
""",
    },
    {
        "name": "running_sum", "category": "A", "entry": "prefix.py",
        "files": {"prefix.py": """def running_sum(nums):
    total = 0
    out = []
    for n in nums:
        out.append(total)
        total += n
    return out
"""},
        "spec": (
            "running_sum(nums) returns a list where each index i holds the sum of "
            "nums[0]..nums[i] inclusive. Bug report: every entry is short by the "
            "current element (first entry is always 0)."
        ),
        "test": """from prefix import running_sum
assert running_sum([1, 2, 3, 4]) == [1, 3, 6, 10]
assert running_sum([1, 1, 1, 1, 1]) == [1, 2, 3, 4, 5]
assert running_sum([3]) == [3]
assert running_sum([]) == []
print('OK')
""",
    },
    {
        "name": "pkg_inventory", "category": "B", "entry": "stock.py", "hidden_file": "warehouse.py",
        "files": {
            "warehouse.py": """def available(sku_count, reserved):
    return sku_count - reserved - 1
""",
            "stock.py": """from warehouse import available

def check(sku_count, reserved):
    return available(sku_count, reserved)
""",
        },
        "spec": (
            "check(sku_count, reserved) in stock.py returns available inventory. "
            "Bug report: check(5, 5) returns -1, should return 0. Fix the root cause "
            "(you may only edit stock.py — warehouse.py is a vendored dependency)."
        ),
        "test": """from stock import check
assert check(5, 5) == 0
assert check(10, 3) == 7
assert check(0, 0) == 0
print('OK')
""",
    },
    {
        "name": "pkg_tax", "category": "B", "entry": "invoice.py", "hidden_file": "tax_table.py",
        "files": {
            "tax_table.py": """def tax_rate(amount):
    if amount > 1000:
        return 0.10
    if amount > 100:
        return 0.05
    return 0.0
""",
            "invoice.py": """from tax_table import tax_rate

def tax_due(amount):
    return round(amount * tax_rate(amount), 2)
""",
        },
        "spec": (
            "tax_due(amount) in invoice.py applies tiered tax. Customers report that "
            "orders of exactly 100 and exactly 1000 pay no tax / wrong tier. You may "
            "only edit invoice.py — tax_table.py is vendor-locked."
        ),
        "test": """from invoice import tax_due
assert tax_due(50) == 0.0
assert tax_due(100) == 5.0
assert tax_due(500) == 25.0
assert tax_due(1000) == 100.0
assert tax_due(2000) == 200.0
print('OK')
""",
    },
    {
        "name": "pkg_rate_limit", "category": "B", "entry": "limiter.py", "hidden_file": "quota.py",
        "files": {
            "quota.py": """def remaining(used, limit):
    return limit - used - 1
""",
            "limiter.py": """from quota import remaining

def can_proceed(used, limit):
    return remaining(used, limit) > 0
""",
        },
        "spec": (
            "can_proceed(used, limit) must be True when used < limit and False when "
            "used >= limit. Bug report: with limit=5, used=4 is denied and used=0 "
            "allows only 4 calls. Edit only limiter.py."
        ),
        "test": """from limiter import can_proceed
assert can_proceed(0, 5) is True
assert can_proceed(4, 5) is True
assert can_proceed(5, 5) is False
assert can_proceed(6, 5) is False
print('OK')
""",
    },
    {
        "name": "pkg_shipping", "category": "B", "entry": "checkout.py", "hidden_file": "freight.py",
        "files": {
            "freight.py": """def shipping_cost(subtotal, weight_kg):
    if subtotal > 50:
        return 0.0
    return round(5.0 + 1.5 * weight_kg, 2)
""",
            "checkout.py": """from freight import shipping_cost

def total_with_shipping(subtotal, weight_kg):
    return round(subtotal + shipping_cost(subtotal, weight_kg), 2)
""",
        },
        "spec": (
            "total_with_shipping(subtotal, weight_kg) adds shipping. Free shipping "
            "should apply at subtotal >= 50. Bug report: cart of exactly 50 still "
            "pays shipping. Edit only checkout.py."
        ),
        "test": """from checkout import total_with_shipping
assert total_with_shipping(40, 2) == 48.0
assert total_with_shipping(50, 2) == 50.0
assert total_with_shipping(50, 10) == 50.0
assert total_with_shipping(60, 2) == 60.0
print('OK')
""",
    },
    {
        "name": "pkg_grade", "category": "B", "entry": "report.py", "hidden_file": "scale.py",
        "files": {
            "scale.py": """def letter_grade(score):
    if score > 90:
        return 'A'
    if score > 80:
        return 'B'
    if score > 70:
        return 'C'
    if score > 60:
        return 'D'
    return 'F'
""",
            "report.py": """from scale import letter_grade

def grade(score):
    return letter_grade(score)
""",
        },
        "spec": (
            "grade(score) maps numeric scores to letter grades with standard "
            "boundaries (90+ A, 80+ B, 70+ C, 60+ D, else F). Exact boundary scores "
            "are reported one letter too low. Edit only report.py."
        ),
        "test": """from report import grade
assert grade(90) == 'A'
assert grade(80) == 'B'
assert grade(70) == 'C'
assert grade(60) == 'D'
assert grade(59) == 'F'
assert grade(100) == 'A'
print('OK')
""",
    },
    {
        "name": "mutable_default_counter", "category": "C", "entry": "counter.py",
        "files": {"counter.py": """def count_items(item, bucket={}):
    bucket[item] = bucket.get(item, 0) + 1
    return bucket
"""},
        "spec": (
            "count_items(item, bucket=None) increments a count for item in bucket "
            "and returns the bucket. When bucket is omitted, each call must start "
            "from a fresh empty mapping — callers report counts leaking across calls."
        ),
        "test": """from counter import count_items
a = count_items('x')
assert a == {'x': 1}
b = count_items('y')
assert b == {'y': 1}, b
c = count_items('x', {})
assert c == {'x': 1}
print('OK')
""",
    },
    {
        "name": "coalesce", "category": "C", "entry": "defaults.py",
        "files": {"defaults.py": """def coalesce(*values):
    for v in values:
        if not v:
            continue
        return v
    return None
"""},
        "spec": (
            "coalesce(*values) returns the first argument that is not None. "
            "Falsy-but-valid values such as 0, '', and False must be returned, "
            "not skipped."
        ),
        "test": """from defaults import coalesce
assert coalesce(None, None, 5) == 5
assert coalesce(None, 0, 5) == 0
assert coalesce(None, '', 'x') == ''
assert coalesce(None, False, True) is False
assert coalesce(None, None) is None
print('OK')
""",
    },
    {
        "name": "chunk_list", "category": "C", "entry": "chunks.py",
        "files": {"chunks.py": """def chunk_list(items, size):
    if size <= 0:
        raise ValueError('size must be positive')
    return [items[i:i + size] for i in range(0, len(items), size)][:-1]
"""},
        "spec": (
            "chunk_list(items, size) splits items into consecutive sublists of length "
            "size (last chunk may be shorter). Empty input yields []. Non-positive "
            "size must raise ValueError. Bug report: the final chunk is always dropped."
        ),
        "test": """from chunks import chunk_list
assert chunk_list([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
assert chunk_list([1, 2, 3], 3) == [[1, 2, 3]]
assert chunk_list([], 2) == []
try:
    chunk_list([1], 0)
    raise AssertionError('expected ValueError')
except ValueError:
    pass
print('OK')
""",
    },
    {
        "name": "parse_bool", "category": "C", "entry": "flags.py",
        "files": {"flags.py": """def parse_bool(value):
    if value:
        return True
    return False
"""},
        "spec": (
            "parse_bool(value) accepts bool, int, and str. True/1/'true'/'yes'/'1' "
            "(case-insensitive) are True; False/0/'false'/'no'/'0' are False. "
            "Other strings raise ValueError. Bug report: the string 'false' is "
            "treated as True."
        ),
        "test": """from flags import parse_bool
assert parse_bool(True) is True
assert parse_bool(False) is False
assert parse_bool(1) is True
assert parse_bool(0) is False
assert parse_bool('true') is True
assert parse_bool('FALSE') is False
assert parse_bool('yes') is True
assert parse_bool('no') is False
try:
    parse_bool('maybe')
    raise AssertionError('expected ValueError')
except ValueError:
    pass
print('OK')
""",
    },
    {
        "name": "atomic_write", "category": "D", "entry": "persist.py",
        "files": {"persist.py": """def save_state(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(data)
"""},
        "spec": (
            "save_state(path, data) must be crash-safe: a process kill mid-write must "
            "never leave path with partial/corrupt content. The prior content (or no "
            "file) must survive an interruption. Write via a temp file then atomic rename."
        ),
        "test": """import os
from persist import save_state
path = '_state.txt'
if os.path.exists(path):
    os.remove(path)
save_state(path, 'first')
assert open(path, encoding='utf-8').read() == 'first'
save_state(path, 'second')
assert open(path, encoding='utf-8').read() == 'second'
print('OK')
""",
    },
    {
        "name": "read_text_lines", "category": "D", "entry": "reader.py",
        "files": {"reader.py": """def read_text_lines(path):
    with open(path, 'rb') as f:
        raw = f.read()
    text = raw.decode('latin-1')
    return text.split('\\n')
"""},
        "spec": (
            "read_text_lines(path) returns the file's lines as a list of strings "
            "decoded as UTF-8, without trailing newline characters. Bug report: "
            "files with UTF-8 multi-byte characters are garbled and blank lines / "
            "trailing newlines are mishandled."
        ),
        "test": """import tempfile
from pathlib import Path
from reader import read_text_lines
with tempfile.TemporaryDirectory() as root:
    p = Path(root) / 'sample.txt'
    p.write_text('alpha\\nbeta\\n\\ngamma\\n', encoding='utf-8')
    assert read_text_lines(p) == ['alpha', 'beta', '', 'gamma']
    p2 = Path(root) / 'unicode.txt'
    p2.write_text('caf\\u00e9\\n', encoding='utf-8')
    assert read_text_lines(p2) == ['caf\\u00e9']
print('OK')
""",
    },
    {
        "name": "ensure_parent_write", "category": "D", "entry": "writer.py",
        "files": {"writer.py": """def write_bytes(path, data):
    with open(path, 'wb') as f:
        f.write(data)
"""},
        "spec": (
            "write_bytes(path, data) writes bytes to path, creating any missing parent "
            "directories first. Bug report: writing to a nested path raises "
            "FileNotFoundError when parents are absent."
        ),
        "test": """import tempfile
from pathlib import Path
from writer import write_bytes
with tempfile.TemporaryDirectory() as root:
    path = Path(root) / 'a' / 'b' / 'c.bin'
    write_bytes(path, b'hello')
    assert path.read_bytes() == b'hello'
    write_bytes(path, b'world')
    assert path.read_bytes() == b'world'
print('OK')
""",
    },
    {
        "name": "append_log_line", "category": "D", "entry": "logger.py",
        "files": {"logger.py": """def append_log_line(path, message):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(message)
"""},
        "spec": (
            "append_log_line(path, message) appends message followed by a newline to "
            "path, creating the file if needed. Prior lines must be preserved."
        ),
        "test": """import tempfile
from pathlib import Path
from logger import append_log_line
with tempfile.TemporaryDirectory() as root:
    path = Path(root) / 'app.log'
    append_log_line(path, 'first')
    append_log_line(path, 'second')
    assert path.read_text(encoding='utf-8') == 'first\\nsecond\\n'
print('OK')
""",
    },
    {
        "name": "capture_stdout", "category": "D", "entry": "capture.py",
        "files": {"capture.py": """import subprocess

def capture_stdout(argv):
    completed = subprocess.run(argv, shell=True)
    return completed.stdout or ''
"""},
        "spec": (
            "capture_stdout(argv) runs argv without a shell, captures stdout as text, "
            "strips trailing whitespace, and returns it. Non-zero exit must raise "
            "RuntimeError. Do not use shell=True."
        ),
        "test": """import sys
from capture import capture_stdout
assert capture_stdout([sys.executable, '-c', 'print(\"hello\")']) == 'hello'
try:
    capture_stdout([sys.executable, '-c', 'import sys; sys.exit(2)'])
    raise AssertionError('expected RuntimeError')
except RuntimeError:
    pass
print('OK')
""",
    },
    {
        "name": "quantize_with_lib", "category": "E", "entry": "solution.py",
        "files": {
            "lib/quantutil.py": """def quantize_step(value, step):
    if step <= 0:
        raise ValueError('step must be positive')
    return round(value / step) * step
""",
            "solution.py": """# TODO: implement snap_to_grid using the project quant library.
def snap_to_grid(value, step):
    return value
""",
            "solution_t.py": """from solution import snap_to_grid
assert snap_to_grid(7.3, 2) == 8
print('OK')
""",
        },
        "spec": (
            "Implement snap_to_grid(value: float, step: float) -> float in solution.py. "
            "It must use the existing quantize_step helper in lib/quantutil.py — do not "
            "reimplement quantization logic or invent a different library function name. "
            "A prior draft tried `audio.snap` and `gridQuantize` — those are NOT available."
        ),
        "test": """from solution import snap_to_grid
import inspect
import solution as sol_mod
src = inspect.getsource(sol_mod)
assert 'audio.snap' not in src and 'gridQuantize' not in src, 'fabricated symbol in landed solution'
assert snap_to_grid(7.3, 2) == 8
assert snap_to_grid(-1.2, 0.5) == -1.0
assert snap_to_grid(0, 1) == 0
print('OK')
""",
    },
    {
        "name": "hash_with_lib", "category": "E", "entry": "solution.py",
        "files": {
            "lib/digestutil.py": """def fingerprint(text, length=8):
    \"\"\"Stable short hex fingerprint of text.\"\"\"
    h = 0
    for ch in text:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return format(h, 'x').zfill(length)[:length]
""",
            "solution.py": """# TODO: implement short_id using the project digest library.
def short_id(text):
    return text
""",
            "solution_t.py": """from solution import short_id
assert len(short_id('hello')) == 8
print('OK')
""",
        },
        "spec": (
            "Implement short_id(text) -> str returning an 8-character hex fingerprint. "
            "A prior draft tried `hashlib.quick` and `fastDigest` — those are NOT "
            "available. Use the real helper from lib/digestutil.py (`fingerprint`) only."
        ),
        "test": """from solution import short_id
import inspect
import solution as sol_mod
src = inspect.getsource(sol_mod)
assert 'hashlib.quick' not in src and 'fastDigest' not in src, 'fabricated symbol in landed solution'
assert short_id('hello') == short_id('hello')
assert short_id('hello') != short_id('world')
assert len(short_id('hello')) == 8
assert all(c in '0123456789abcdef' for c in short_id('hello'))
print('OK')
""",
    },
    {
        "name": "format_with_lib", "category": "E", "entry": "solution.py",
        "files": {
            "lib/moneyutil.py": """def format_cents(cents):
    \"\"\"Format an integer cent amount as a dollar string with two decimals.\"\"\"
    sign = '-' if cents < 0 else ''
    cents = abs(cents)
    dollars, rem = divmod(cents, 100)
    return f'{sign}${dollars}.{rem:02d}'
""",
            "solution.py": """# TODO: implement money_label using the project money library.
def money_label(cents):
    return str(cents)
""",
            "solution_t.py": """from solution import money_label
assert money_label(1050) == '$10.50'
print('OK')
""",
        },
        "spec": (
            "Implement money_label(cents: int) -> str for display. A prior draft tried "
            "`locale.currency_fast` and `prettyMoney` — those are NOT available. Use "
            "the real helper from lib/moneyutil.py (`format_cents`) only."
        ),
        "test": """from solution import money_label
import inspect
import solution as sol_mod
src = inspect.getsource(sol_mod)
assert 'locale.currency_fast' not in src and 'prettyMoney' not in src, 'fabricated symbol in landed solution'
assert money_label(1050) == '$10.50'
assert money_label(0) == '$0.00'
assert money_label(-99) == '-$0.99'
print('OK')
""",
    },
    {
        "name": "normalize_with_lib", "category": "E", "entry": "solution.py",
        "files": {
            "lib/pathutil.py": """def collapse_slashes(path):
    \"\"\"Collapse repeated forward slashes; preserve a single leading slash.\"\"\"
    if not path:
        return path
    leading = path.startswith('/')
    parts = [p for p in path.split('/') if p]
    body = '/'.join(parts)
    return ('/' + body) if leading else body
""",
            "solution.py": """# TODO: implement clean_path using the project path library.
def clean_path(path):
    return path
""",
            "solution_t.py": """from solution import clean_path
assert clean_path('/a//b///c') == '/a/b/c'
print('OK')
""",
        },
        "spec": (
            "Implement clean_path(path) that collapses repeated '/' characters while "
            "preserving whether the path is absolute. A prior draft tried "
            "`os.fastnorm` and `pathlib.quick_clean` — those are NOT available. Use "
            "the real helper from lib/pathutil.py (`collapse_slashes`) only."
        ),
        "test": """from solution import clean_path
import inspect
import solution as sol_mod
src = inspect.getsource(sol_mod)
assert 'os.fastnorm' not in src and 'pathlib.quick_clean' not in src, 'fabricated symbol in landed solution'
assert clean_path('/a//b///c') == '/a/b/c'
assert clean_path('a//b') == 'a/b'
assert clean_path('///') == '/'
assert clean_path('') == ''
print('OK')
""",
    },
]

# Structural held-out enforcement: held_out.py is the single source of truth for
# which tasks are reserved for final scoring. Assert on import so a typo or a
# renamed/removed task fails loud here rather than silently shrinking the
# held-out set (which would let the optimizer train on data meant to be unseen).
from held_out import HELD_OUT_NAMES  # noqa: E402

_TASK_NAMES = {t["name"] for t in TASKS}
_MISSING = HELD_OUT_NAMES - _TASK_NAMES
assert not _MISSING, f"held_out.py names not present in TASKS: {sorted(_MISSING)}"

K = 3
