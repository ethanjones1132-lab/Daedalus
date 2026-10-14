"""The five training-task families of the adapters spec (section 4.2), as prompts for a task-writing model
(plan 2026-10-06-adapters-phase2.md, Task 3). The families mirror the pool's categories:

  A  standard-library bug-fix: a function reimplementing a stdlib behaviour with one bug; the test uses the stdlib
     original as the oracle on many inputs
  B  hidden convention: the entry file misuses a helper module whose source the model never sees; the spec is the
     user-visible symptom
  C  bad input: None, empty, whitespace or malformed input must give the stated default or exception
  D  file I/O: files in the working folder (lines, CSV, JSON); newline, header, encoding, append, missing file
  E  library use: the entry file calls a helper that does not exist; the real one is in lib/, named by the spec

The format examples are written for this file and come from no scored set. Each candidate is later validated
(buggy fails, reference passes) and checked for disjointness against tier2b, the pool and the judge set (make.py).
"""
import json
import random

FIELDS = """Return ONLY one JSON object with these keys:
- "name": a short snake_case id starting with "t_", specific to this task
- "entry": the one file the model must fix (e.g. "solution.py")
- "files": {path: content}, the package as it is given; files[entry] is the BUGGY version
- "hidden_file": (families B and E only) the helper file whose source is never shown
- "spec": RULE_SPEC
- "reference": the complete corrected content of the entry file (only the bug fixed, same style)
- "test": a Python script of plain asserts (no pytest, no prints needed) that imports from the entry module, passes on
  the reference and FAILS on the buggy file; deterministic; standard library only; finishes in under a second"""

FAMILIES = {
    "A": dict(
        what="a function of 8-30 lines that reimplements one well-defined standard-library behaviour under its own "
             "name (for example a bisect, heapq, statistics, textwrap, itertools, collections, fractions, string, "
             "base64, colorsys, calendar or difflib function), with exactly one realistic bug: an off-by-one, a wrong "
             "comparison, a wrong initial value, a missed last element, a wrong order or a wrong edge case",
        spec="what the function must do in 1-3 sentences, without hinting at the bug",
        test="use the standard-library original as the oracle: compare on at least 100 inputs from random.Random(a "
             "fixed seed), plus the edge cases",
        example={
            "name": "t_insertion_point_right",
            "entry": "solution.py",
            "files": {"solution.py": "def insertion_point(xs, x):\n    lo, hi = 0, len(xs)\n    while lo < hi:\n"
                                     "        mid = (lo + hi) // 2\n        if xs[mid] < x:\n            lo = mid + 1\n"
                                     "        else:\n            hi = mid\n    return lo\n"},
            "spec": "insertion_point(xs, x) returns the index at which x would be inserted into the sorted list xs "
                    "to keep it sorted, after any entries equal to x.",
            "reference": "def insertion_point(xs, x):\n    lo, hi = 0, len(xs)\n    while lo < hi:\n"
                         "        mid = (lo + hi) // 2\n        if xs[mid] <= x:\n            lo = mid + 1\n"
                         "        else:\n            hi = mid\n    return lo\n",
            "test": "import bisect\nimport random\nfrom solution import insertion_point\nr = random.Random(7)\n"
                    "for _ in range(300):\n    xs = sorted(r.randint(0, 9) for _ in range(r.randint(0, 12)))\n"
                    "    x = r.randint(-1, 10)\n    assert insertion_point(xs, x) == bisect.bisect_right(xs, x), (xs, x)\n"
                    "assert insertion_point([], 3) == 0\n"}),
    "B": dict(
        what="a two-file package: a helper module that encodes a convention (a unit, a scale, a sign, an index base, "
             "a key name, a return shape, an ordering, a time zone or a rounding rule) and an entry file that misuses "
             "it. The fix is in the entry file only, and a careful reader can infer the convention from names, "
             "docstring-free call sites and the symptom",
        spec="the user-visible symptom with concrete numbers (what was expected and what came out), not the cause",
        test="check the symptom's numbers and two or three more cases through the entry module only",
        example={
            "name": "t_thermostat_kelvin",
            "entry": "thermostat.py",
            "hidden_file": "sensors.py",
            "files": {"sensors.py": "def read_temp(raw):\n    return raw / 10.0  # kelvin\n",
                      "thermostat.py": "from sensors import read_temp\n\n\ndef needs_heat(raw, target_c):\n"
                                       "    return read_temp(raw) < target_c\n"},
            "spec": "The heater never turns on: with the room at about 18 C (raw reading 2911) and the target at 21 C, "
                    "needs_heat returns False.",
            "reference": "from sensors import read_temp\n\n\ndef needs_heat(raw, target_c):\n"
                         "    return read_temp(raw) - 273.15 < target_c\n",
            "test": "from thermostat import needs_heat\nassert needs_heat(2911, 21) is True\n"
                    "assert needs_heat(2961, 21) is False\nassert needs_heat(2941, 21) is True\n"}),
    "C": dict(
        what="a function that must handle None, empty, whitespace-only, wrong-type or malformed input by returning "
             "a stated default or raising a stated exception; the buggy version crashes on or mishandles one or two "
             "of those cases while normal input works",
        spec="the normal behaviour and exactly what each bad input must give, in 1-3 sentences",
        test="cover normal input and every bad-input case the spec names",
        example={
            "name": "t_parse_percent_or",
            "entry": "solution.py",
            "files": {"solution.py": "def parse_percent(text, default=None):\n"
                                     "    return float(text.strip().rstrip('%')) / 100\n"},
            "spec": "parse_percent(text, default=None) turns text like '45%', ' 12.5 % ' or '7' into a fraction "
                    "(0.45, 0.125, 0.07); it returns default for None, empty or non-numeric text instead of raising.",
            "reference": "def parse_percent(text, default=None):\n    if text is None:\n        return default\n"
                         "    s = text.strip().rstrip('%').strip()\n    try:\n        return float(s) / 100\n"
                         "    except ValueError:\n        return default\n",
            "test": "from solution import parse_percent\nassert parse_percent('45%') == 0.45\n"
                    "assert parse_percent(' 12.5 % ') == 0.125\nassert parse_percent('7') == 0.07\n"
                    "assert parse_percent(None) is None\nassert parse_percent('', 0) == 0\n"
                    "assert parse_percent('abc', -1) == -1\n"}),
    "D": dict(
        what="a module that reads or writes files in the current folder (text lines, CSV, JSON or key=value): the "
             "bug is in newline handling, a header row, quoting, encoding, append versus overwrite, sorting, or what "
             "happens when the file is missing",
        spec="what the function(s) must read or write, including the missing-file behaviour, in 1-3 sentences",
        test="create every file it needs inside the current folder (relative paths only), remove leftovers first, "
             "and check the results",
        example={
            "name": "t_logbook_append",
            "entry": "logbook.py",
            "files": {"logbook.py": "def add_entry(path, text):\n    with open(path, 'w', encoding='utf-8') as f:\n"
                                    "        f.write(text + '\\n')\n\n\ndef entries(path):\n    try:\n"
                                    "        with open(path, encoding='utf-8') as f:\n"
                                    "            return [line.rstrip('\\n') for line in f]\n"
                                    "    except FileNotFoundError:\n        return []\n"},
            "spec": "add_entry(path, text) appends text as a new line to the log file, creating it if needed; "
                    "entries(path) returns the lines in order, or [] when the file does not exist.",
            "reference": "def add_entry(path, text):\n    with open(path, 'a', encoding='utf-8') as f:\n"
                         "        f.write(text + '\\n')\n\n\ndef entries(path):\n    try:\n"
                         "        with open(path, encoding='utf-8') as f:\n"
                         "            return [line.rstrip('\\n') for line in f]\n"
                         "    except FileNotFoundError:\n        return []\n",
            "test": "import os\nfrom logbook import add_entry, entries\nif os.path.exists('t.log'):\n"
                    "    os.remove('t.log')\nassert entries('t.log') == []\nadd_entry('t.log', 'first')\n"
                    "add_entry('t.log', 'second')\nassert entries('t.log') == ['first', 'second'], entries('t.log')\n"}),
    "E": dict(
        what="an entry file that calls a helper which does not exist (a plausible but wrong name or module); the "
             "real helper lives in lib/<module>.py, is present in the package but never shown, and the spec names it "
             "with its signature and behaviour. Import it as `from lib.<module> import <name>`",
        spec="what to implement, which helper is NOT available, and the real helper's name, signature and behaviour",
        test="check results that depend on the real helper's behaviour",
        example={
            "name": "t_page_url_slug",
            "entry": "solution.py",
            "hidden_file": "lib/textkit.py",
            "files": {"lib/textkit.py": "import re\n\n\ndef slugify(text, sep='-'):\n"
                                        "    return sep.join(re.findall(r'[a-z0-9]+', text.lower()))\n",
                      "solution.py": "from lib.textkit import make_slug\n\n\ndef page_url(title):\n"
                                     "    return '/pages/' + make_slug(title)\n"},
            "spec": "Implement page_url(title) as '/pages/' plus the title's slug. `textkit.make_slug` is NOT "
                    "available: use the project helper lib/textkit.py `slugify(text, sep='-')`, which lower-cases the "
                    "text and joins its runs of letters and digits with sep.",
            "reference": "from lib.textkit import slugify\n\n\ndef page_url(title):\n"
                         "    return '/pages/' + slugify(title)\n",
            "test": "from solution import page_url\nassert page_url('Hello, World!') == '/pages/hello-world'\n"
                    "assert page_url('  2024 Report: Q3  ') == '/pages/2024-report-q3'\n"}),
}

TOPICS = """inventory restocking, parcel shipping rates, weather station logs, music playlists, recipe scaling,
chess clocks, bank interest, library loans, parking garages, election tallies, DNA sequences, warehouse picking,
flight itineraries, hotel bookings, gym memberships, school grades, payroll, tax brackets, currency exchange,
loyalty points, train timetables, bike rentals, fuel economy, solar panels, smart meters, water usage, plant care,
pet clinics, dental appointments, pharmacy refills, blood pressure readings, step counters, sleep tracking,
marathon splits, football league tables, cricket scores, board game ratings, video game saves, achievement badges,
online auctions, coupon codes, shopping carts, product reviews, return policies, subscription billing, invoices,
expense reports, mileage claims, time sheets, shift rosters, meeting rooms, calendar recurrence, time zones,
countdown timers, alarm schedules, traffic lights, elevator requests, vending machines, ticket queues, call centres,
support tickets, bug trackers, code review stats, build logs, version strings, semantic versioning, log rotation,
disk quotas, file backups, photo albums, image thumbnails, colour palettes, font sizes, map coordinates,
GPS tracks, hiking trails, ski lifts, ferry schedules, taxi fares, ride sharing, delivery windows, food menus,
allergen labels, nutrition facts, wine cellars, coffee orders, bakery batches, brewery recipes, farm harvests,
greenhouse sensors, beehives, fishing quotas, forestry plots, earthquake magnitudes, tide tables, moon phases,
star catalogues, telescope bookings, lab samples, chemical dilutions, unit conversion, recipe nutrition,
sports drafts, tournament brackets, poker hands, dice games, lottery draws, crossword grids, word frequencies,
spell checking, text justification, CSV exports, address labels, phone numbers, postal codes, email lists,
newsletter sends, password rules, user permissions, audit trails, rate limiting, cache expiry, retry backoff,
queue priorities, job scheduling, sensor calibration, battery levels, charging stations, printer queues,
museum tickets, theatre seating, cinema showtimes, concert setlists, radio playlists, podcast feeds, ebook pages,
translation memory, subtitle timing, survey answers, poll results, rental deposits, mortgage schedules,
insurance claims, car servicing, tyre pressure, fleet tracking, drone flights, robot paths, conveyor belts,
3D printer jobs, laser cutting, knitting patterns, quilt blocks, garden plots, compost temperatures""".split(",")
TOPICS = [t.strip() for t in TOPICS if t.strip()]


def prompt(family, topic, n):
    f = FAMILIES[family]
    rules = f"Family {family}: {f['what']}.\nTest: {f['test']}."
    return (f"You write training tasks for a Python bug-fixing benchmark. Write task {n} about: {topic}.\n\n{rules}\n\n"
            + FIELDS.replace("RULE_SPEC", f["spec"])
            + "\n\nInvent fresh function, module and variable names that fit the topic. Keep the files short. "
              "Here is the format, for a different topic:\n" + json.dumps(f["example"], indent=1))


def prompts(per_family, seed=0):
    """[(id, family, topic, text)]: per_family prompts per family, topics shuffled per family, in round-robin
    family order so a run cut off early still covers every family (ids and topics do not depend on the order)."""
    rng = random.Random(seed)
    by = {}
    for fam in FAMILIES:
        topics = TOPICS[:]
        rng.shuffle(topics)
        by[fam] = [(f"{fam}{i:04d}", fam, topics[i % len(topics)], prompt(fam, topics[i % len(topics)], i % 7 + 1))
                   for i in range(per_family)]
    return [by[fam][i] for i in range(per_family) for fam in FAMILIES]
