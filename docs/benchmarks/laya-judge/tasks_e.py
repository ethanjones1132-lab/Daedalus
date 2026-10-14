"""Judge set, category E (use a library helper correctly): 12 new tasks in tier2b's *_with_lib shape (Laya partner
spec §4). Scoring only. The visible file calls a helper that does not exist; the real one is in lib/ (present in the
package, not shown); the spec names it. `reference` is used only by validate_tasks.py and is never shown."""

CHECK = '''import inspect
import solution as _sol
_src = inspect.getsource(_sol)
assert "{fake}" not in _src, "invented helper still used"
assert "{real}" in _src, "the real helper is not used"
'''

TASKS = [
    dict(name="j_snake_lib", category="E", entry="solution.py",
         files={"lib/strings.py": '''import re


def snake_case(name):
    """'HTTPServerError' -> 'http_server_error', 'userID' -> 'user_id', 'First Name' -> 'first_name'."""
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\\1_\\2", name.strip())
    s = re.sub(r"([a-z0-9])([A-Z])", r"\\1_\\2", s)
    return re.sub(r"[\\s\\-]+", "_", s).lower()
''', "solution.py": '''from casing import to_snake


def field_names(columns):
    """Database field names for spreadsheet column titles."""
    return [to_snake(c) for c in columns]
'''},
         spec="field_names turns column titles into snake_case field names. `casing.to_snake` is NOT available. "
              "Use lib/strings.py `snake_case(name)`.",
         reference='''from lib.strings import snake_case


def field_names(columns):
    """Database field names for spreadsheet column titles."""
    return [snake_case(c) for c in columns]
''',
         test=CHECK.format(fake="casing", real="snake_case") + '''from solution import field_names
assert field_names(["HTTPServerError", "userID", "First Name"]) == ["http_server_error", "user_id", "first_name"], field_names(["HTTPServerError", "userID", "First Name"])
'''),
    dict(name="j_epoch_lib", category="E", entry="solution.py",
         files={"lib/timeutil.py": '''import datetime


def to_epoch(stamp):
    """'2024-01-01T00:00:10Z' -> seconds since 1970-01-01 UTC."""
    dt = datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp())
''', "solution.py": '''from chrono import epoch


def elapsed(start, end):
    """Seconds between two UTC timestamps like '2024-01-01T00:00:10Z'."""
    return epoch(end) - epoch(start)
'''},
         spec="elapsed(start, end) is the number of seconds between two UTC timestamps. `chrono.epoch` is NOT "
              "available. Use lib/timeutil.py `to_epoch(stamp)`.",
         reference='''from lib.timeutil import to_epoch


def elapsed(start, end):
    """Seconds between two UTC timestamps like '2024-01-01T00:00:10Z'."""
    return to_epoch(end) - to_epoch(start)
''',
         test=CHECK.format(fake="chrono", real="to_epoch") + '''from solution import elapsed
assert elapsed("2024-01-01T00:00:10Z", "2024-01-01T00:01:00Z") == 50
assert elapsed("2024-02-28T23:00:00Z", "2024-03-01T00:00:00Z") == 25 * 3600
'''),
    dict(name="j_distance_lib", category="E", entry="solution.py",
         files={"lib/geometry.py": '''import math


def distance(p, q):
    """Straight-line distance between points p and q, each (x, y)."""
    return math.hypot(q[0] - p[0], q[1] - p[1])
''', "solution.py": '''from geomx import dist


def route_length(points):
    """Length of the path through the points in order, rounded to 3 decimals."""
    return round(sum(dist(a, b) for a, b in zip(points, points[1:])), 3)
'''},
         spec="route_length sums the straight-line legs between consecutive points. `geomx.dist` is NOT "
              "available. Use lib/geometry.py `distance(p, q)`.",
         reference='''from lib.geometry import distance


def route_length(points):
    """Length of the path through the points in order, rounded to 3 decimals."""
    return round(sum(distance(a, b) for a, b in zip(points, points[1:])), 3)
''',
         test=CHECK.format(fake="geomx", real="distance") + '''from solution import route_length
assert route_length([(0, 0), (3, 4), (3, 0)]) == 9.0
assert route_length([(1, 1)]) == 0
assert route_length([(0, 0), (1, 1)]) == 1.414
'''),
    dict(name="j_hex_lib", category="E", entry="solution.py",
         files={"lib/colors.py": '''def hex_to_rgb(code):
    """'#ff8800' or '#f80' -> (255, 136, 0)."""
    h = code.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
''', "solution.py": '''from colorx import parse


def brightness(code):
    """Perceived brightness 0-255 of a hex colour: (299 R + 587 G + 114 B) / 1000, rounded."""
    r, g, b = parse(code)
    return round((299 * r + 587 * g + 114 * b) / 1000)
'''},
         spec="brightness accepts '#rrggbb' and short '#rgb' colours. `colorx.parse` is NOT available. Use "
              "lib/colors.py `hex_to_rgb(code)`.",
         reference='''from lib.colors import hex_to_rgb


def brightness(code):
    """Perceived brightness 0-255 of a hex colour: (299 R + 587 G + 114 B) / 1000, rounded."""
    r, g, b = hex_to_rgb(code)
    return round((299 * r + 587 * g + 114 * b) / 1000)
''',
         test=CHECK.format(fake="colorx", real="hex_to_rgb") + '''from solution import brightness
assert brightness("#ffffff") == 255
assert brightness("#000") == 0
assert brightness("#f80") == 156, brightness("#f80")
'''),
    dict(name="j_email_lib", category="E", entry="solution.py",
         files={"lib/check.py": '''import re


def is_email(text):
    """A plausible email address: name@domain.tld."""
    return re.fullmatch(r"[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}", text.strip()) is not None
''', "solution.py": '''from validators import email


def valid_emails(entries):
    """The valid addresses from a sign-up list, stripped, in order."""
    return [e.strip() for e in entries if email(e)]
'''},
         spec="valid_emails keeps the plausible addresses, stripped, in order. `validators.email` is NOT "
              "available. Use lib/check.py `is_email(text)`.",
         reference='''from lib.check import is_email


def valid_emails(entries):
    """The valid addresses from a sign-up list, stripped, in order."""
    return [e.strip() for e in entries if is_email(e)]
''',
         test=CHECK.format(fake="validators", real="is_email") + '''from solution import valid_emails
assert valid_emails([" a@b.co ", "nope", "x@y", "q@w.org"]) == ["a@b.co", "q@w.org"]
'''),
    dict(name="j_add_days_lib", category="E", entry="solution.py",
         files={"lib/calendar_days.py": '''import datetime


def add_days(date_text, days):
    """'2024-01-31' plus 1 day -> '2024-02-01'."""
    return (datetime.date.fromisoformat(date_text) + datetime.timedelta(days=days)).isoformat()
''', "solution.py": '''from datex import shift


def due_date(issued, terms_days=30):
    """Payment due date for an invoice issued on an ISO date."""
    return shift(issued, terms_days)
'''},
         spec="due_date(issued, terms_days) is the ISO date terms_days after issued. `datex.shift` is NOT "
              "available. Use lib/calendar_days.py `add_days(date_text, days)`.",
         reference='''from lib.calendar_days import add_days


def due_date(issued, terms_days=30):
    """Payment due date for an invoice issued on an ISO date."""
    return add_days(issued, terms_days)
''',
         test=CHECK.format(fake="datex", real="add_days") + '''from solution import due_date
assert due_date("2024-01-31") == "2024-03-01"
assert due_date("2024-12-25", 7) == "2025-01-01"
'''),
    dict(name="j_accents_lib", category="E", entry="solution.py",
         files={"lib/text.py": '''import unicodedata


def strip_accents(text):
    """'Café Zoë' -> 'Cafe Zoe'."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
''', "solution.py": '''from unidecode2 import plain


def search_key(name):
    """Key for accent- and case-insensitive search."""
    return plain(name).lower().strip()
'''},
         spec="search_key makes names match regardless of accents and case: 'Café Zoë ' -> 'cafe zoe'. "
              "`unidecode2` is NOT available. Use lib/text.py `strip_accents(text)`.",
         reference='''from lib.text import strip_accents


def search_key(name):
    """Key for accent- and case-insensitive search."""
    return strip_accents(name).lower().strip()
''',
         test=CHECK.format(fake="unidecode2", real="strip_accents") + '''from solution import search_key
assert search_key("Caf\\u00e9 Zo\\u00eb ") == "cafe zoe", search_key("Caf\\u00e9 Zo\\u00eb ")
'''),
    dict(name="j_miles_lib", category="E", entry="solution.py",
         files={"lib/distance.py": '''def km_to_miles(km):
    """Kilometres to miles, rounded to 2 decimals."""
    return round(km * 0.621371, 2)
''', "solution.py": '''from units3 import km2mi


def trip_summary(legs_km):
    """Total trip length as a label like '12.43 mi'."""
    return f"{km2mi(sum(legs_km)):.2f} mi"
'''},
         spec="trip_summary labels the total length in miles with 2 decimals. `units3.km2mi` is NOT available. "
              "Use lib/distance.py `km_to_miles(km)`.",
         reference='''from lib.distance import km_to_miles


def trip_summary(legs_km):
    """Total trip length as a label like '12.43 mi'."""
    return f"{km_to_miles(sum(legs_km)):.2f} mi"
''',
         test=CHECK.format(fake="units3", real="km_to_miles") + '''from solution import trip_summary
assert trip_summary([10, 10]) == "12.43 mi", trip_summary([10, 10])
assert trip_summary([]) == "0.00 mi"
'''),
    dict(name="j_bmi_lib", category="E", entry="solution.py",
         files={"lib/health.py": '''def bmi(weight_kg, height_m):
    """Body-mass index, rounded to one decimal."""
    return round(weight_kg / height_m ** 2, 1)
''', "solution.py": '''from healthx import body_mass


def bmi_category(weight_kg, height_m):
    """'under' below 18.5, 'normal' below 25, otherwise 'over'."""
    b = body_mass(weight_kg, height_m)
    return "under" if b < 18.5 else "normal" if b < 25 else "over"
'''},
         spec="bmi_category classifies the rounded BMI. `healthx.body_mass` is NOT available. Use lib/health.py "
              "`bmi(weight_kg, height_m)`.",
         reference='''from lib.health import bmi


def bmi_category(weight_kg, height_m):
    """'under' below 18.5, 'normal' below 25, otherwise 'over'."""
    b = bmi(weight_kg, height_m)
    return "under" if b < 18.5 else "normal" if b < 25 else "over"
''',
         test=CHECK.format(fake="healthx", real="bmi(") + '''from solution import bmi_category
assert bmi_category(50, 1.8) == "under"
assert bmi_category(70, 1.75) == "normal"
assert bmi_category(90, 1.7) == "over"
'''),
    dict(name="j_mime_lib", category="E", entry="solution.py",
         files={"lib/mimes.py": '''TYPES = {".html": "text/html", ".css": "text/css", ".png": "image/png", ".json": "application/json"}


def mime_type(filename):
    """Content type for a file name by its extension (case-insensitive); unknown -> application/octet-stream."""
    dot = filename.rfind(".")
    ext = filename[dot:].lower() if dot >= 0 else ""
    return TYPES.get(ext, "application/octet-stream")
''', "solution.py": '''from mimetypes2 import guess


def content_header(filename):
    """HTTP header line for serving filename."""
    return f"Content-Type: {guess(filename)}"
'''},
         spec="content_header('LOGO.PNG') must be 'Content-Type: image/png'. `mimetypes2.guess` is NOT available. "
              "Use lib/mimes.py `mime_type(filename)`.",
         reference='''from lib.mimes import mime_type


def content_header(filename):
    """HTTP header line for serving filename."""
    return f"Content-Type: {mime_type(filename)}"
''',
         test=CHECK.format(fake="mimetypes2", real="mime_type") + '''from solution import content_header
assert content_header("LOGO.PNG") == "Content-Type: image/png"
assert content_header("data.bin") == "Content-Type: application/octet-stream"
assert content_header("index.html") == "Content-Type: text/html"
'''),
    dict(name="j_luhn_lib", category="E", entry="solution.py",
         files={"lib/checksum.py": '''def luhn_valid(digits):
    """True if a string of digits passes the Luhn check."""
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return bool(digits) and total % 10 == 0
''', "solution.py": '''from cardx import check


def valid_account_numbers(entries):
    """The entries whose digits (spaces removed) pass the Luhn check, without spaces, in order."""
    return [e.replace(" ", "") for e in entries if check(e.replace(" ", ""))]
'''},
         spec="valid_account_numbers keeps the entries whose digits pass the Luhn check, spaces removed. "
              "`cardx.check` is NOT available. Use lib/checksum.py `luhn_valid(digits)`.",
         reference='''from lib.checksum import luhn_valid


def valid_account_numbers(entries):
    """The entries whose digits (spaces removed) pass the Luhn check, without spaces, in order."""
    return [e.replace(" ", "") for e in entries if luhn_valid(e.replace(" ", ""))]
''',
         test=CHECK.format(fake="cardx", real="luhn_valid") + '''from solution import valid_account_numbers
assert valid_account_numbers(["7992 7398 713", "1234 5678", "79927398710"]) == ["79927398713"]
'''),
    dict(name="j_duration_lib", category="E", entry="solution.py",
         files={"lib/durations.py": '''def fmt_duration(seconds):
    """3723 -> '1h 02m 03s'; 125 -> '2m 05s'; 45 -> '45s'."""
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"
''', "solution.py": '''from timefmt import human


def track_label(title, seconds):
    """'Intro (2m 05s)'."""
    return f"{title} ({human(seconds)})"
'''},
         spec="track_label('Intro', 125) must be 'Intro (2m 05s)'. `timefmt.human` is NOT available. Use "
              "lib/durations.py `fmt_duration(seconds)`.",
         reference='''from lib.durations import fmt_duration


def track_label(title, seconds):
    """'Intro (2m 05s)'."""
    return f"{title} ({fmt_duration(seconds)})"
''',
         test=CHECK.format(fake="timefmt", real="fmt_duration") + '''from solution import track_label
assert track_label("Intro", 125) == "Intro (2m 05s)"
assert track_label("Live set", 3723) == "Live set (1h 02m 03s)"
assert track_label("Jingle", 45) == "Jingle (45s)"
'''),
]
