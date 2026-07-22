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
]

K = 3
