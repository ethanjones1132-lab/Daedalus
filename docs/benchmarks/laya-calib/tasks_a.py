"""Calibration pool, category A (algorithms): 12 new tasks in tier2b's format (Laya partner spec §4).
Each carries `reference`, a correct entry file used only by validate_tasks.py; it is never shown to a model."""

TASKS = [
    dict(name="c_rle_encode", category="A", entry="solution.py",
         files={"solution.py": '''def rle_encode(s):
    """Run-length encode a string: "aaabcc" -> [("a", 3), ("b", 1), ("c", 2)]."""
    out = []
    i = 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        if j < len(s):
            out.append((s[i], j - i))
        i = j
    return out
'''},
         spec="Return (character, count) pairs for each run of equal characters, in order, including the last "
              "run; an empty string gives [].",
         reference='''def rle_encode(s):
    """Run-length encode a string: "aaabcc" -> [("a", 3), ("b", 1), ("c", 2)]."""
    out = []
    i = 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        out.append((s[i], j - i))
        i = j
    return out
''',
         test='''from solution import rle_encode
assert rle_encode("aaabcc") == [("a", 3), ("b", 1), ("c", 2)], rle_encode("aaabcc")
assert rle_encode("") == []
assert rle_encode("x") == [("x", 1)]
assert rle_encode("abba") == [("a", 1), ("b", 2), ("a", 1)]
'''),
    dict(name="c_moving_average", category="A", entry="solution.py",
         files={"solution.py": '''def moving_average(xs, k):
    """Averages of each window of k consecutive values."""
    out = []
    for i in range(len(xs) - k):
        out.append(sum(xs[i:i + k]) / k)
    return out
'''},
         spec="Return the average of every window of k consecutive values, including the last window: "
              "moving_average([1, 2, 3, 4], 2) == [1.5, 2.5, 3.5]. If k is larger than the list, return [].",
         reference='''def moving_average(xs, k):
    """Averages of each window of k consecutive values."""
    out = []
    for i in range(len(xs) - k + 1):
        out.append(sum(xs[i:i + k]) / k)
    return out
''',
         test='''from solution import moving_average
assert moving_average([1, 2, 3, 4], 2) == [1.5, 2.5, 3.5], moving_average([1, 2, 3, 4], 2)
assert moving_average([5, 5, 5], 3) == [5.0]
assert moving_average([1, 2], 3) == []
assert moving_average([2, 4, 6, 8], 1) == [2.0, 4.0, 6.0, 8.0]
'''),
    dict(name="c_flatten", category="A", entry="solution.py",
         files={"solution.py": '''def flatten(items):
    """Flatten nested lists into one flat list, keeping order."""
    out = []
    for x in items:
        if isinstance(x, list):
            out.extend(x)
        else:
            out.append(x)
    return out
'''},
         spec="flatten must handle lists nested to any depth: flatten([1, [2, [3, [4]]], 5]) == [1, 2, 3, 4, 5]. "
              "Empty lists contribute nothing.",
         reference='''def flatten(items):
    """Flatten nested lists into one flat list, keeping order."""
    out = []
    for x in items:
        if isinstance(x, list):
            out.extend(flatten(x))
        else:
            out.append(x)
    return out
''',
         test='''from solution import flatten
assert flatten([1, [2, [3, [4]]], 5]) == [1, 2, 3, 4, 5], flatten([1, [2, [3, [4]]], 5])
assert flatten([]) == []
assert flatten([[], [[]], 7]) == [7]
assert flatten(["a", ["b"]]) == ["a", "b"]
'''),
    dict(name="c_kth_largest", category="A", entry="solution.py",
         files={"solution.py": '''def kth_largest(nums, k):
    """The k-th largest value (k = 1 is the maximum)."""
    return sorted(nums)[k - 1]
'''},
         spec="Return the k-th largest value, counting duplicates: kth_largest([3, 1, 5, 5, 2], 1) == 5, "
              "k = 2 is also 5, k = 3 is 3.",
         reference='''def kth_largest(nums, k):
    """The k-th largest value (k = 1 is the maximum)."""
    return sorted(nums, reverse=True)[k - 1]
''',
         test='''from solution import kth_largest
assert kth_largest([3, 1, 5, 5, 2], 1) == 5
assert kth_largest([3, 1, 5, 5, 2], 2) == 5
assert kth_largest([3, 1, 5, 5, 2], 3) == 3, kth_largest([3, 1, 5, 5, 2], 3)
assert kth_largest([7], 1) == 7
assert kth_largest([-1, -4, -2], 3) == -4
'''),
    dict(name="c_dedupe_keep_order", category="A", entry="solution.py",
         files={"solution.py": '''def dedupe(items):
    """Remove repeated items."""
    return list(set(items))
'''},
         spec="Remove repeats but keep the first occurrence of each item in its original position: "
              "dedupe(['b', 'a', 'b', 'c', 'a']) == ['b', 'a', 'c'].",
         reference='''def dedupe(items):
    """Remove repeated items."""
    seen = set()
    out = []
    for x in items:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out
''',
         test='''from solution import dedupe
assert dedupe(["b", "a", "b", "c", "a"]) == ["b", "a", "c"], dedupe(["b", "a", "b", "c", "a"])
assert dedupe([]) == []
assert dedupe([3, 2, 1, 3, 2, 1]) == [3, 2, 1]
assert dedupe(["z", "y", "x", "w", "z"]) == ["z", "y", "x", "w"]
'''),
    dict(name="c_top_k_words", category="A", entry="solution.py",
         files={"solution.py": '''from collections import Counter


def top_k_words(text, k):
    """The k most frequent words, most frequent first."""
    counts = Counter(text.lower().split())
    return [w for w, _ in sorted(counts.items(), key=lambda kv: -kv[1])[:k]]
'''},
         spec="Return the k most frequent words (lower-cased), most frequent first; words with the same count "
              "are ordered alphabetically.",
         reference='''from collections import Counter


def top_k_words(text, k):
    """The k most frequent words, most frequent first."""
    counts = Counter(text.lower().split())
    return [w for w, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:k]]
''',
         test='''from solution import top_k_words
assert top_k_words("pear apple pear fig apple kiwi", 2) == ["apple", "pear"], top_k_words("pear apple pear fig apple kiwi", 2)
assert top_k_words("b a c", 3) == ["a", "b", "c"]
assert top_k_words("x X y", 1) == ["x"]
assert top_k_words("", 2) == []
'''),
    dict(name="c_rotate_right", category="A", entry="solution.py",
         files={"solution.py": '''def rotate_right(xs, k):
    """Rotate the list right by k places."""
    k = k % len(xs)
    return xs[k:] + xs[:k]
'''},
         spec="Rotate right by k: rotate_right([1, 2, 3, 4, 5], 2) == [4, 5, 1, 2, 3]. k may exceed the length; "
              "an empty list returns []. Do not modify the input list.",
         reference='''def rotate_right(xs, k):
    """Rotate the list right by k places."""
    if not xs:
        return []
    k = k % len(xs)
    return xs[len(xs) - k:] + xs[:len(xs) - k]
''',
         test='''from solution import rotate_right
assert rotate_right([1, 2, 3, 4, 5], 2) == [4, 5, 1, 2, 3], rotate_right([1, 2, 3, 4, 5], 2)
assert rotate_right([1, 2, 3], 4) == [3, 1, 2]
assert rotate_right([], 3) == []
assert rotate_right([1, 2], 0) == [1, 2]
xs = [1, 2, 3]
rotate_right(xs, 1)
assert xs == [1, 2, 3]
'''),
    dict(name="c_is_anagram", category="A", entry="solution.py",
         files={"solution.py": '''def is_anagram(a, b):
    """True if a and b use the same letters."""
    return set(a.lower()) == set(b.lower())
'''},
         spec="Two phrases are anagrams if they use exactly the same letters the same number of times, ignoring "
              "case and spaces: 'Dormitory' and 'dirty room' are; 'aab' and 'abb' are not.",
         reference='''from collections import Counter


def is_anagram(a, b):
    """True if a and b use the same letters."""
    def letters(s):
        return Counter(ch for ch in s.lower() if not ch.isspace())
    return letters(a) == letters(b)
''',
         test='''from solution import is_anagram
assert is_anagram("Dormitory", "dirty room") is True
assert is_anagram("aab", "abb") is False
assert is_anagram("listen", "silent") is True
assert is_anagram("abc", "abcd") is False
'''),
    dict(name="c_matrix_transpose", category="A", entry="solution.py",
         files={"solution.py": '''def transpose(m):
    """Transpose a rectangular matrix given as a list of rows."""
    n = len(m)
    return [[m[r][c] for r in range(n)] for c in range(n)]
'''},
         spec="transpose must work for any rectangular matrix, not only square ones: [[1, 2, 3], [4, 5, 6]] -> "
              "[[1, 4], [2, 5], [3, 6]]; [] -> [].",
         reference='''def transpose(m):
    """Transpose a rectangular matrix given as a list of rows."""
    if not m:
        return []
    return [[m[r][c] for r in range(len(m))] for c in range(len(m[0]))]
''',
         test='''from solution import transpose
assert transpose([[1, 2, 3], [4, 5, 6]]) == [[1, 4], [2, 5], [3, 6]], transpose([[1, 2, 3], [4, 5, 6]])
assert transpose([[1, 2], [3, 4]]) == [[1, 3], [2, 4]]
assert transpose([]) == []
assert transpose([[7]]) == [[7]]
'''),
    dict(name="c_lcm_list", category="A", entry="solution.py",
         files={"solution.py": '''def lcm_all(nums):
    """Least common multiple of a list of positive integers."""
    out = 1
    for n in nums:
        out *= n
    return out
'''},
         spec="Return the least common multiple: lcm_all([4, 6]) == 12, lcm_all([2, 3, 4]) == 12, lcm_all([5]) == 5.",
         reference='''import math


def lcm_all(nums):
    """Least common multiple of a list of positive integers."""
    out = 1
    for n in nums:
        out = out * n // math.gcd(out, n)
    return out
''',
         test='''from solution import lcm_all
assert lcm_all([4, 6]) == 12, lcm_all([4, 6])
assert lcm_all([2, 3, 4]) == 12
assert lcm_all([5]) == 5
assert lcm_all([3, 5]) == 15
'''),
    dict(name="c_digital_root", category="A", entry="solution.py",
         files={"solution.py": '''def digital_root(n):
    """Repeatedly sum the digits of a non-negative integer until one digit remains."""
    return sum(int(d) for d in str(n))
'''},
         spec="Keep summing digits until a single digit remains: digital_root(9875) == 2 (9875 -> 29 -> 11 -> 2); "
              "digital_root(0) == 0.",
         reference='''def digital_root(n):
    """Repeatedly sum the digits of a non-negative integer until one digit remains."""
    while n >= 10:
        n = sum(int(d) for d in str(n))
    return n
''',
         test='''from solution import digital_root
assert digital_root(9875) == 2, digital_root(9875)
assert digital_root(0) == 0
assert digital_root(7) == 7
assert digital_root(38) == 2
'''),
    dict(name="c_pair_sum_count", category="A", entry="solution.py",
         files={"solution.py": '''def count_pairs(nums, target):
    """Number of index pairs i < j with nums[i] + nums[j] == target."""
    count = 0
    for i in range(len(nums)):
        for j in range(len(nums)):
            if nums[i] + nums[j] == target:
                count += 1
    return count
'''},
         spec="Count each pair of positions once, with i < j: count_pairs([1, 5, 7, -1, 5], 6) == 3, "
              "count_pairs([3, 3, 3], 6) == 3.",
         reference='''def count_pairs(nums, target):
    """Number of index pairs i < j with nums[i] + nums[j] == target."""
    count = 0
    for i in range(len(nums)):
        for j in range(i + 1, len(nums)):
            if nums[i] + nums[j] == target:
                count += 1
    return count
''',
         test='''from solution import count_pairs
assert count_pairs([1, 5, 7, -1, 5], 6) == 3, count_pairs([1, 5, 7, -1, 5], 6)
assert count_pairs([3, 3, 3], 6) == 3
assert count_pairs([], 1) == 0
assert count_pairs([2], 4) == 0
'''),
]
