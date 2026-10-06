"""Judge set, category A (algorithms): 12 new tasks in tier2b's format (Laya partner spec §4). Scoring only.
Each carries `reference`, used only by validate_tasks.py; it is never shown to a model."""

TASKS = [
    dict(name="j_pascal_row", category="A", entry="solution.py",
         files={"solution.py": '''def pascal_row(n):
    """Row n of Pascal's triangle (row 0 is [1])."""
    row = [1]
    for _ in range(n):
        row = [a + b for a, b in zip(row, row[1:])]
    return row
'''},
         spec="pascal_row(n) returns row n of Pascal's triangle, row 0 being [1]: pascal_row(4) == [1, 4, 6, 4, 1].",
         reference='''def pascal_row(n):
    """Row n of Pascal's triangle (row 0 is [1])."""
    row = [1]
    for _ in range(n):
        row = [1] + [a + b for a, b in zip(row, row[1:])] + [1]
    return row
''',
         test='''from solution import pascal_row
assert pascal_row(0) == [1]
assert pascal_row(1) == [1, 1]
assert pascal_row(4) == [1, 4, 6, 4, 1], pascal_row(4)
'''),
    dict(name="j_spiral_order", category="A", entry="solution.py",
         files={"solution.py": '''def spiral(matrix):
    """Elements of a rectangular matrix in clockwise spiral order from the top-left."""
    out = []
    while matrix:
        out += matrix.pop(0)
        matrix = [list(r) for r in zip(*matrix)]
    return out
'''},
         spec="Return the elements in clockwise spiral order: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] -> "
              "[1, 2, 3, 6, 9, 8, 7, 4, 5]. Works for non-square matrices and [].",
         reference='''def spiral(matrix):
    """Elements of a rectangular matrix in clockwise spiral order from the top-left."""
    out = []
    matrix = [list(r) for r in matrix]
    while matrix:
        out += matrix.pop(0)
        matrix = [list(r) for r in zip(*matrix)][::-1]
    return out
''',
         test='''from solution import spiral
assert spiral([[1, 2, 3], [4, 5, 6], [7, 8, 9]]) == [1, 2, 3, 6, 9, 8, 7, 4, 5], spiral([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
assert spiral([[1, 2, 3, 4], [5, 6, 7, 8]]) == [1, 2, 3, 4, 8, 7, 6, 5]
assert spiral([]) == []
assert spiral([[1], [2], [3]]) == [1, 2, 3]
'''),
    dict(name="j_common_prefix", category="A", entry="solution.py",
         files={"solution.py": '''def common_prefix(words):
    """Longest prefix shared by every word."""
    if not words:
        return ""
    prefix = words[0]
    for w in words[1:]:
        while not prefix.startswith(w[:len(prefix)]):
            prefix = prefix[:-1]
    return prefix
'''},
         spec="Return the longest prefix shared by every word: ['flower', 'flow', 'flight'] -> 'fl'; "
              "['dog', 'car'] -> ''; [] -> ''.",
         reference='''def common_prefix(words):
    """Longest prefix shared by every word."""
    if not words:
        return ""
    prefix = words[0]
    for w in words[1:]:
        while not w.startswith(prefix):
            prefix = prefix[:-1]
    return prefix
''',
         test='''from solution import common_prefix
assert common_prefix(["flower", "flow", "flight"]) == "fl", common_prefix(["flower", "flow", "flight"])
assert common_prefix(["dog", "car"]) == ""
assert common_prefix([]) == ""
assert common_prefix(["same", "same"]) == "same"
assert common_prefix(["abc", "ab"]) == "ab"
'''),
    dict(name="j_rle_decode", category="A", entry="solution.py",
         files={"solution.py": '''def rle_decode(s):
    """Expand run-length text: 'a3b1c12' -> 'aaab' followed by twelve c's."""
    out = []
    i = 0
    while i < len(s):
        ch = s[i]
        out.append(ch * int(s[i + 1]))
        i += 2
    return "".join(out)
'''},
         spec="Each letter is followed by a count of one or more digits: 'a3b1' -> 'aaab', 'x12' -> twelve x's. "
              "'' -> ''.",
         reference='''def rle_decode(s):
    """Expand run-length text: 'a3b1c12' -> 'aaab' followed by twelve c's."""
    out = []
    i = 0
    while i < len(s):
        ch = s[i]
        j = i + 1
        while j < len(s) and s[j].isdigit():
            j += 1
        out.append(ch * int(s[i + 1:j]))
        i = j
    return "".join(out)
''',
         test='''from solution import rle_decode
assert rle_decode("a3b1") == "aaab"
assert rle_decode("x12") == "x" * 12, rle_decode("x12")
assert rle_decode("a10b2") == "a" * 10 + "bb"
assert rle_decode("") == ""
'''),
    dict(name="j_second_largest", category="A", entry="solution.py",
         files={"solution.py": '''def second_largest(nums):
    """The second largest distinct value, or None if there is none."""
    s = sorted(nums)
    return s[-2] if len(s) >= 2 else None
'''},
         spec="Return the second largest distinct value: [5, 5, 3] -> 3, [1, 2] -> 1; [7, 7] or [] -> None.",
         reference='''def second_largest(nums):
    """The second largest distinct value, or None if there is none."""
    s = sorted(set(nums))
    return s[-2] if len(s) >= 2 else None
''',
         test='''from solution import second_largest
assert second_largest([5, 5, 3]) == 3, second_largest([5, 5, 3])
assert second_largest([1, 2]) == 1
assert second_largest([7, 7]) is None
assert second_largest([]) is None
'''),
    dict(name="j_count_islands", category="A", entry="solution.py",
         files={"solution.py": '''def count_islands(grid):
    """Number of islands of '1's, joined horizontally or vertically."""
    rows, cols = len(grid), len(grid[0]) if grid else 0
    seen = set()
    count = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == "1" and (r, c) not in seen:
                count += 1
                seen.add((r, c))
    return count
'''},
         spec="Count islands: groups of '1' cells connected up, down, left or right (not diagonally). "
              "[['1','1','0'],['0','1','0'],['0','0','1']] has 2 islands.",
         reference='''def count_islands(grid):
    """Number of islands of '1's, joined horizontally or vertically."""
    rows, cols = len(grid), len(grid[0]) if grid else 0
    seen = set()
    count = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == "1" and (r, c) not in seen:
                count += 1
                stack = [(r, c)]
                seen.add((r, c))
                while stack:
                    y, x = stack.pop()
                    for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                        if 0 <= ny < rows and 0 <= nx < cols and grid[ny][nx] == "1" and (ny, nx) not in seen:
                            seen.add((ny, nx))
                            stack.append((ny, nx))
    return count
''',
         test='''from solution import count_islands
assert count_islands([["1", "1", "0"], ["0", "1", "0"], ["0", "0", "1"]]) == 2, count_islands([["1", "1", "0"], ["0", "1", "0"], ["0", "0", "1"]])
assert count_islands([["1", "0", "1"], ["0", "1", "0"]]) == 3
assert count_islands([]) == 0
assert count_islands([["1", "1"], ["1", "1"]]) == 1
'''),
    dict(name="j_to_base", category="A", entry="solution.py",
         files={"solution.py": '''DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def to_base(n, base):
    """Integer n written in the given base (2-36)."""
    out = ""
    while n > 0:
        out = DIGITS[n % base] + out
        n //= base
    return out
'''},
         spec="to_base(n, base) writes n in base 2-36 with lower-case digits: to_base(255, 16) == 'ff'. Zero is "
              "'0' and negatives get a leading '-': to_base(-10, 2) == '-1010'.",
         reference='''DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def to_base(n, base):
    """Integer n written in the given base (2-36)."""
    if n == 0:
        return "0"
    sign = "-" if n < 0 else ""
    n = abs(n)
    out = ""
    while n > 0:
        out = DIGITS[n % base] + out
        n //= base
    return sign + out
''',
         test='''from solution import to_base
assert to_base(255, 16) == "ff"
assert to_base(0, 2) == "0", to_base(0, 2)
assert to_base(-10, 2) == "-1010"
assert to_base(35, 36) == "z"
'''),
    dict(name="j_merge_counts", category="A", entry="solution.py",
         files={"solution.py": '''def merge_counts(a, b):
    """Combine two word-count dicts, adding counts for shared words."""
    out = dict(a)
    out.update(b)
    return out
'''},
         spec="merge_counts({'x': 2, 'y': 1}, {'x': 3, 'z': 4}) == {'x': 5, 'y': 1, 'z': 4}. The inputs must "
              "not be modified.",
         reference='''def merge_counts(a, b):
    """Combine two word-count dicts, adding counts for shared words."""
    out = dict(a)
    for k, v in b.items():
        out[k] = out.get(k, 0) + v
    return out
''',
         test='''from solution import merge_counts
a, b = {"x": 2, "y": 1}, {"x": 3, "z": 4}
assert merge_counts(a, b) == {"x": 5, "y": 1, "z": 4}, merge_counts(a, b)
assert a == {"x": 2, "y": 1} and b == {"x": 3, "z": 4}
assert merge_counts({}, {}) == {}
'''),
    dict(name="j_unique_paths", category="A", entry="solution.py",
         files={"solution.py": '''def unique_paths(rows, cols):
    """Paths from the top-left to the bottom-right cell of a grid, moving only right or down."""
    dp = [[1] * cols for _ in range(rows)]
    for r in range(1, rows):
        for c in range(1, cols):
            dp[r][c] = dp[r - 1][c] * dp[r][c - 1]
    return dp[-1][-1]
'''},
         spec="Count the monotone paths (right or down moves only) across a rows x cols grid: unique_paths(3, 3) "
              "== 6, unique_paths(3, 7) == 28, unique_paths(1, 5) == 1.",
         reference='''def unique_paths(rows, cols):
    """Paths from the top-left to the bottom-right cell of a grid, moving only right or down."""
    dp = [[1] * cols for _ in range(rows)]
    for r in range(1, rows):
        for c in range(1, cols):
            dp[r][c] = dp[r - 1][c] + dp[r][c - 1]
    return dp[-1][-1]
''',
         test='''from solution import unique_paths
assert unique_paths(3, 3) == 6, unique_paths(3, 3)
assert unique_paths(3, 7) == 28
assert unique_paths(1, 5) == 1
'''),
    dict(name="j_caesar", category="A", entry="solution.py",
         files={"solution.py": '''def caesar(text, shift):
    """Shift letters by `shift` places, wrapping around the alphabet."""
    return "".join(chr(ord(ch) + shift) for ch in text)
'''},
         spec="Shift letters within the alphabet, wrapping (z + 1 -> a), keeping case; leave every other "
              "character unchanged. Negative shifts work: caesar('Abz!', 1) == 'Bca!', caesar('a', -1) == 'z'.",
         reference='''def caesar(text, shift):
    """Shift letters by `shift` places, wrapping around the alphabet."""
    out = []
    for ch in text:
        if ch.isascii() and ch.isalpha():
            base = ord("A") if ch.isupper() else ord("a")
            out.append(chr(base + (ord(ch) - base + shift) % 26))
        else:
            out.append(ch)
    return "".join(out)
''',
         test='''from solution import caesar
assert caesar("Abz!", 1) == "Bca!", caesar("Abz!", 1)
assert caesar("a", -1) == "z"
assert caesar("Hello, World", 13) == "Uryyb, Jbeyq"
'''),
    dict(name="j_max_subarray", category="A", entry="solution.py",
         files={"solution.py": '''def max_subarray(nums):
    """Largest sum of a non-empty contiguous run of nums."""
    best = cur = 0
    for x in nums:
        cur = max(0, cur + x)
        best = max(best, cur)
    return best
'''},
         spec="Return the largest sum of a non-empty contiguous run; for all-negative input that is the largest "
              "single value: [-3, -1, -2] -> -1. [2, -1, 3] -> 4.",
         reference='''def max_subarray(nums):
    """Largest sum of a non-empty contiguous run of nums."""
    best = cur = nums[0]
    for x in nums[1:]:
        cur = max(x, cur + x)
        best = max(best, cur)
    return best
''',
         test='''from solution import max_subarray
assert max_subarray([-3, -1, -2]) == -1, max_subarray([-3, -1, -2])
assert max_subarray([2, -1, 3]) == 4
assert max_subarray([-2, 1, -3, 4, -1, 2, 1, -5, 4]) == 6
'''),
    dict(name="j_interleave", category="A", entry="solution.py",
         files={"solution.py": '''def interleave(a, b):
    """Alternate items from a and b, starting with a."""
    out = []
    for x, y in zip(a, b):
        out += [x, y]
    return out
'''},
         spec="Alternate items from a and b starting with a; when one list runs out, append the rest of the "
              "other: interleave([1, 2, 3], ['x']) == [1, 'x', 2, 3].",
         reference='''def interleave(a, b):
    """Alternate items from a and b, starting with a."""
    out = []
    for x, y in zip(a, b):
        out += [x, y]
    n = min(len(a), len(b))
    return out + list(a[n:]) + list(b[n:])
''',
         test='''from solution import interleave
assert interleave([1, 2, 3], ["x"]) == [1, "x", 2, 3], interleave([1, 2, 3], ["x"])
assert interleave([], [4, 5]) == [4, 5]
assert interleave([1], [2]) == [1, 2]
'''),
]
