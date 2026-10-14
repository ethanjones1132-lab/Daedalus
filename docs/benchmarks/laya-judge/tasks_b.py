"""Judge set, category B (hidden package): 12 new tasks in validation-b's shape (Laya partner spec §4). Scoring
only. Fix `entry`; `hidden_file` is in the package but its source is never shown; the test exercises the real
hidden module. Each hinges on one unseen convention that validation-b did not use. `reference` is used only by
validate_tasks.py and is never shown to a model."""

TASKS = [
    dict(name="j_weight_grams", category="B", entry="shipping.py", hidden_file="catalog.py",
         files={"catalog.py": '''WEIGHTS_G = {"book": 450, "laptop": 2100, "mug": 350}


def weight(item):
    """Shipping weight of a catalog item."""
    return WEIGHTS_G[item]
''', "shipping.py": '''from catalog import weight


def total_kg(items):
    """Total weight of the items in kilograms, rounded to 2 places."""
    return round(sum(weight(i) for i in items), 2)
'''},
         spec="Parcel weights are wildly off: a book plus a mug is reported as weighing 800 kg.",
         reference='''from catalog import weight


def total_kg(items):
    """Total weight of the items in kilograms, rounded to 2 places."""
    return round(sum(weight(i) for i in items) / 1000, 2)
''',
         test='''from shipping import total_kg
assert total_kg(["book", "mug"]) == 0.8, total_kg(["book", "mug"])
assert total_kg(["laptop"]) == 2.1
assert total_kg([]) == 0
'''),
    dict(name="j_duration_minutes", category="B", entry="playlist.py", hidden_file="media.py",
         files={"media.py": '''DURATIONS = {"intro": 3, "talk": 45, "qa": 20}


def duration(name):
    """Running time of a session segment."""
    return DURATIONS[name]
''', "playlist.py": '''from media import duration


def fits(names, hours):
    """True if the segments fit in the given number of hours."""
    return sum(duration(n) for n in names) <= hours
'''},
         spec="fits(['talk', 'qa'], 2) returns False, but those two segments fit easily in a two-hour slot.",
         reference='''from media import duration


def fits(names, hours):
    """True if the segments fit in the given number of hours."""
    return sum(duration(n) for n in names) <= hours * 60
''',
         test='''from playlist import fits
assert fits(["talk", "qa"], 2) is True
assert fits(["talk", "qa", "intro"], 1) is False
assert fits([], 0) is True
'''),
    dict(name="j_disk_kib", category="B", entry="report.py", hidden_file="disk.py",
         files={"disk.py": '''USED = {"/data": 2048, "/logs": 512}


def used(mount):
    """Space used on a mount, as reported by the disk tool."""
    return USED[mount]
''', "report.py": '''from disk import used


def used_mib(mount):
    """Space used on a mount in MiB."""
    return used(mount) / 1000
'''},
         spec="used_mib('/data') reports 2.048 MiB, but the disk tool itself shows exactly 2.0 MiB used.",
         reference='''from disk import used


def used_mib(mount):
    """Space used on a mount in MiB."""
    return used(mount) / 1024
''',
         test='''from report import used_mib
assert used_mib("/data") == 2.0, used_mib("/data")
assert used_mib("/logs") == 0.5
'''),
    dict(name="j_utc_offset_west", category="B", entry="clock.py", hidden_file="tz.py",
         files={"tz.py": '''OFFSETS = {"new_york": 300, "tokyo": -540, "utc": 0}


def offset_minutes(zone):
    """The zone's UTC offset in minutes."""
    return OFFSETS[zone]
''', "clock.py": '''from tz import offset_minutes


def local_hour(utc_hour, zone):
    """The local hour (0-23) in zone when it is utc_hour o'clock UTC."""
    return (utc_hour + offset_minutes(zone) // 60) % 24
'''},
         spec="local_hour(12, 'new_york') returns 17, but noon UTC is 7 in the morning in New York.",
         reference='''from tz import offset_minutes


def local_hour(utc_hour, zone):
    """The local hour (0-23) in zone when it is utc_hour o'clock UTC."""
    return (utc_hour - offset_minutes(zone) // 60) % 24
''',
         test='''from clock import local_hour
assert local_hour(12, "new_york") == 7, local_hour(12, "new_york")
assert local_hour(12, "tokyo") == 21
assert local_hour(12, "utc") == 12
'''),
    dict(name="j_month_zero_based", category="B", entry="labels.py", hidden_file="cal.py",
         files={"cal.py": '''def month_of(date_text):
    """Month number of an ISO date like '2024-03-15'."""
    return int(date_text[5:7]) - 1
''', "labels.py": '''from cal import month_of

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def month_label(date_text):
    """Short month name of an ISO date."""
    return MONTHS[month_of(date_text) - 1]
'''},
         spec="month_label('2024-03-15') returns 'Feb', and every other month is off in the same way.",
         reference='''from cal import month_of

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def month_label(date_text):
    """Short month name of an ISO date."""
    return MONTHS[month_of(date_text)]
''',
         test='''from labels import month_label
assert month_label("2024-03-15") == "Mar", month_label("2024-03-15")
assert month_label("2024-01-02") == "Jan"
assert month_label("2024-12-31") == "Dec"
'''),
    dict(name="j_sorted_desc", category="B", entry="stats.py", hidden_file="scores.py",
         files={"scores.py": '''SCORES = {"chess": [5, 9, 2], "go": [7]}


def ranked(game):
    """The game's scores, ranked."""
    return sorted(SCORES[game], reverse=True)
''', "stats.py": '''from scores import ranked


def lowest(game):
    """The lowest score recorded for game."""
    return ranked(game)[0]


def highest(game):
    """The highest score recorded for game."""
    return ranked(game)[-1]
'''},
         spec="lowest('chess') returns the best score and highest('chess') returns the worst one.",
         reference='''from scores import ranked


def lowest(game):
    """The lowest score recorded for game."""
    return ranked(game)[-1]


def highest(game):
    """The highest score recorded for game."""
    return ranked(game)[0]
''',
         test='''from stats import lowest, highest
assert lowest("chess") == 2, lowest("chess")
assert highest("chess") == 9
assert lowest("go") == highest("go") == 7
'''),
    dict(name="j_pairs_not_dict", category="B", entry="config.py", hidden_file="settings_store.py",
         files={"settings_store.py": '''def load():
    """The saved settings."""
    return [("theme", "dark"), ("lang", "en")]
''', "config.py": '''from settings_store import load


def get_setting(key, default=None):
    """One saved setting, or default when it is not saved."""
    return load().get(key, default)
'''},
         spec="get_setting('theme') crashes with AttributeError: 'list' object has no attribute 'get'.",
         reference='''from settings_store import load


def get_setting(key, default=None):
    """One saved setting, or default when it is not saved."""
    return dict(load()).get(key, default)
''',
         test='''from config import get_setting
assert get_setting("theme") == "dark"
assert get_setting("lang") == "en"
assert get_setting("missing", 1) == 1
'''),
    dict(name="j_missing_is_empty", category="B", entry="greet.py", hidden_file="users.py",
         files={"users.py": '''_NICK = {1: "Ace"}
_FULL = {1: "Alice Smith", 2: "Bob Jones"}


def nickname(uid):
    """The user's nickname."""
    return _NICK.get(uid, "")


def full_name(uid):
    """The user's full name."""
    return _FULL[uid]
''', "greet.py": '''from users import full_name, nickname


def greeting_name(uid):
    """The nickname if the user has one, otherwise the full name."""
    n = nickname(uid)
    return n if n is not None else full_name(uid)
'''},
         spec="Users who never set a nickname are greeted with an empty name.",
         reference='''from users import full_name, nickname


def greeting_name(uid):
    """The nickname if the user has one, otherwise the full name."""
    n = nickname(uid)
    return n if n else full_name(uid)
''',
         test='''from greet import greeting_name
assert greeting_name(1) == "Ace"
assert greeting_name(2) == "Bob Jones", repr(greeting_name(2))
'''),
    dict(name="j_range_exclusive", category="B", entry="batch.py", hidden_file="ids.py",
         files={"ids.py": '''def ids_between(a, b):
    """Record ids between a and b."""
    return list(range(a, b))
''', "batch.py": '''from ids import ids_between


def batch(first, last):
    """All record ids from first to last, inclusive."""
    return ids_between(first, last)
'''},
         spec="Every batch silently drops one record: batch(1, 3) never includes record 3.",
         reference='''from ids import ids_between


def batch(first, last):
    """All record ids from first to last, inclusive."""
    return ids_between(first, last + 1)
''',
         test='''from batch import batch
assert batch(1, 3) == [1, 2, 3], batch(1, 3)
assert batch(5, 5) == [5]
'''),
    dict(name="j_basis_points", category="B", entry="interest.py", hidden_file="rates.py",
         files={"rates.py": '''RATES = {"savings": 425, "cd": 500}


def annual_rate(product):
    """The product's annual interest rate."""
    return RATES[product]
''', "interest.py": '''from rates import annual_rate


def yearly_interest(balance, product):
    """Interest earned on balance over one year, in dollars, rounded to cents."""
    return round(balance * annual_rate(product) / 100, 2)
'''},
         spec="A $1,000 savings balance shows $4,250.00 of interest a year; customers expect about $42.",
         reference='''from rates import annual_rate


def yearly_interest(balance, product):
    """Interest earned on balance over one year, in dollars, rounded to cents."""
    return round(balance * annual_rate(product) / 10000, 2)
''',
         test='''from interest import yearly_interest
assert yearly_interest(1000, "savings") == 42.5, yearly_interest(1000, "savings")
assert yearly_interest(1000, "cd") == 50.0
'''),
    dict(name="j_iso_weekday", category="B", entry="shop.py", hidden_file="calendar_util.py",
         files={"calendar_util.py": '''import datetime


def weekday(date_text):
    """Day of the week of an ISO date."""
    return datetime.date.fromisoformat(date_text).isoweekday()
''', "shop.py": '''from calendar_util import weekday


def is_weekend(date_text):
    """True on Saturdays and Sundays."""
    return weekday(date_text) >= 5
'''},
         spec="The shop applies weekend prices on Fridays too.",
         reference='''from calendar_util import weekday


def is_weekend(date_text):
    """True on Saturdays and Sundays."""
    return weekday(date_text) >= 6
''',
         test='''from shop import is_weekend
assert is_weekend("2024-10-04") is False, "Friday"
assert is_weekend("2024-10-05") is True
assert is_weekend("2024-10-06") is True
assert is_weekend("2024-10-07") is False
'''),
    dict(name="j_bytes_not_str", category="B", entry="banner.py", hidden_file="wire.py",
         files={"wire.py": '''_MESSAGES = {"welcome": "Welcome, caf\\u00e9"}


def fetch(name):
    """A message from the message service."""
    return _MESSAGES[name].encode("utf-8")
''', "banner.py": '''from wire import fetch


def banner(name):
    """The message framed for display: '== text =='."""
    return "== " + fetch(name) + " =="
'''},
         spec="banner('welcome') crashes with TypeError: can only concatenate str (not \"bytes\") to str.",
         reference='''from wire import fetch


def banner(name):
    """The message framed for display: '== text =='."""
    return "== " + fetch(name).decode("utf-8") + " =="
''',
         test='''from banner import banner
assert banner("welcome") == "== Welcome, caf\\u00e9 ==", banner("welcome")
'''),
]
