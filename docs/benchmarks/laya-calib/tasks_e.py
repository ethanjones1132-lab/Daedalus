"""Calibration pool, category E (use a library helper correctly): 12 new tasks in tier2b's format (Laya partner
spec §4), shaped like tier2b's *_with_lib tasks: the visible file calls a helper that does not exist; the real one
is in lib/ (present in the package, not shown); the spec names it. Each carries `reference`, used only by
validate_tasks.py; it is never shown to a model."""

CHECK = '''import inspect
import solution as _sol
_src = inspect.getsource(_sol)
assert "{fake}" not in _src, "invented helper still used"
assert "{real}" in _src, "the real helper is not used"
'''

TASKS = [
    dict(name="c_title_lib", category="E", entry="solution.py",
         files={"lib/textfmt.py": '''SMALL = {"a", "an", "and", "of", "the", "in", "on"}


def title_word(word, first=False):
    """Capitalize a word for a title; small words stay lower-case unless they come first."""
    w = word.lower()
    if w in SMALL and not first:
        return w
    return w[:1].upper() + w[1:]
''', "solution.py": '''from str_utils import titlecase


def title_case(text):
    """Title-case a phrase for display."""
    return titlecase(text)
'''},
         spec="Implement title_case(text) for book titles. `str_utils.titlecase` is NOT available. Use the "
              "project helper lib/textfmt.py `title_word(word, first=False)` on each word.",
         reference='''from lib.textfmt import title_word


def title_case(text):
    """Title-case a phrase for display."""
    return " ".join(title_word(w, i == 0) for i, w in enumerate(text.split()))
''',
         test=CHECK.format(fake="titlecase", real="title_word") + '''from solution import title_case
assert title_case("the lord OF the rings") == "The Lord of the Rings", title_case("the lord OF the rings")
assert title_case("a tale of two cities") == "A Tale of Two Cities"
assert title_case("") == ""
'''),
    dict(name="c_date_lib", category="E", entry="solution.py",
         files={"lib/dates.py": '''def parse_iso(s):
    """'2024-05-17' -> (2024, 5, 17)."""
    y, m, d = s.strip().split("-")
    return int(y), int(m), int(d)
''', "solution.py": '''from dateparse import quick


def quarter(date_text):
    """Calendar quarter of an ISO date: 'Q1' to 'Q4'."""
    return f"Q{(quick(date_text).month - 1) // 3 + 1}"
'''},
         spec="quarter(date_text) returns 'Q1'..'Q4' for an ISO date like '2024-05-17'. `dateparse.quick` is NOT "
              "available. Use lib/dates.py `parse_iso(s)`, which returns (year, month, day).",
         reference='''from lib.dates import parse_iso


def quarter(date_text):
    """Calendar quarter of an ISO date: 'Q1' to 'Q4'."""
    _, month, _ = parse_iso(date_text)
    return f"Q{(month - 1) // 3 + 1}"
''',
         test=CHECK.format(fake="dateparse", real="parse_iso") + '''from solution import quarter
assert quarter("2024-05-17") == "Q2"
assert quarter("2023-12-01") == "Q4"
assert quarter(" 2024-01-31 ") == "Q1"
assert quarter("2024-09-30") == "Q3"
'''),
    dict(name="c_round_lib", category="E", entry="solution.py",
         files={"lib/money.py": '''from decimal import ROUND_HALF_UP, Decimal


def round_half_up(x, places=2):
    """Round like a till does: halves go up. Returns a Decimal."""
    return Decimal(str(x)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
''', "solution.py": '''from decimalx import round2


def price_label(amount):
    """Shelf label for a price in dollars, e.g. '$2.50'."""
    return f"${round2(amount)}"
'''},
         spec="price_label(amount) must round halves up, as the till does: 0.125 -> '$0.13', 1.005 -> '$1.01', "
              "2.5 -> '$2.50'. `decimalx.round2` is NOT available. Use lib/money.py `round_half_up(x, places)`.",
         reference='''from lib.money import round_half_up


def price_label(amount):
    """Shelf label for a price in dollars, e.g. '$2.50'."""
    return f"${round_half_up(amount, 2)}"
''',
         test=CHECK.format(fake="decimalx", real="round_half_up") + '''from solution import price_label
assert price_label(0.125) == "$0.13", price_label(0.125)
assert price_label(1.005) == "$1.01", price_label(1.005)
assert price_label(2.5) == "$2.50"
assert price_label(3) == "$3.00"
'''),
    dict(name="c_mask_lib", category="E", entry="solution.py",
         files={"lib/privacy.py": '''def mask_local(local):
    """Mask the part of an email address before the '@': 'alice' -> 'a***'."""
    return (local[:1] + "***") if local else "***"
''', "solution.py": '''from pii import mask


def mask_email(email):
    """Hide most of an email address for display."""
    return mask(email)
'''},
         spec="mask_email('alice@example.com') must give 'a***@example.com' (the domain stays visible). "
              "`pii.mask` is NOT available. Use lib/privacy.py `mask_local(local)` on the part before the '@'.",
         reference='''from lib.privacy import mask_local


def mask_email(email):
    """Hide most of an email address for display."""
    local, _, domain = email.partition("@")
    return f"{mask_local(local)}@{domain}"
''',
         test=CHECK.format(fake="pii", real="mask_local") + '''from solution import mask_email
assert mask_email("alice@example.com") == "a***@example.com", mask_email("alice@example.com")
assert mask_email("b@x.org") == "b***@x.org"
'''),
    dict(name="c_wrap_lib", category="E", entry="solution.py",
         files={"lib/wraptext.py": '''def wrap_words(text, width):
    """Greedy word wrap: a list of lines, none longer than width unless a single word is."""
    lines, cur = [], ""
    for word in text.split():
        if cur and len(cur) + 1 + len(word) > width:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}" if cur else word
    if cur:
        lines.append(cur)
    return lines
''', "solution.py": '''import textwrap3


def wrap_paragraph(text, width):
    """Wrap a paragraph to width columns, lines joined with newlines."""
    return textwrap3.fill(text, width)
'''},
         spec="wrap_paragraph(text, width) wraps to width columns and joins the lines with '\\n'. `textwrap3` "
              "is NOT available. Use lib/wraptext.py `wrap_words(text, width)`, which returns the list of lines.",
         reference='''from lib.wraptext import wrap_words


def wrap_paragraph(text, width):
    """Wrap a paragraph to width columns, lines joined with newlines."""
    return "\\n".join(wrap_words(text, width))
''',
         test=CHECK.format(fake="textwrap3", real="wrap_words") + '''from solution import wrap_paragraph
assert wrap_paragraph("the quick brown fox jumps", 10) == "the quick\\nbrown fox\\njumps", wrap_paragraph("the quick brown fox jumps", 10)
assert wrap_paragraph("", 5) == ""
'''),
    dict(name="c_hash_lib", category="E", entry="solution.py",
         files={"lib/ids.py": '''import hashlib


def short_hash(text, n=6):
    """The first n hex digits of the SHA-1 of text."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:n]
''', "solution.py": '''from idgen import hash6


def make_id(name):
    """A stable id: the lower-cased, hyphenated name plus a 6-digit hash of the original name."""
    return name.lower().replace(" ", "-") + "-" + hash6(name)
'''},
         spec="make_id('My Item') must be 'my-item-' followed by the first 6 hex digits of the SHA-1 of 'My Item'. "
              "`idgen.hash6` is NOT available. Use lib/ids.py `short_hash(text, n)`.",
         reference='''from lib.ids import short_hash


def make_id(name):
    """A stable id: the lower-cased, hyphenated name plus a 6-digit hash of the original name."""
    return name.lower().replace(" ", "-") + "-" + short_hash(name, 6)
''',
         test=CHECK.format(fake="idgen", real="short_hash") + '''import hashlib
from solution import make_id
assert make_id("My Item") == "my-item-" + hashlib.sha1(b"My Item").hexdigest()[:6], make_id("My Item")
assert make_id("x") == "x-" + hashlib.sha1(b"x").hexdigest()[:6]
'''),
    dict(name="c_temp_lib", category="E", entry="solution.py",
         files={"lib/units.py": '''def c_to_f(c):
    """Celsius to Fahrenheit, rounded to one decimal place."""
    return round(c * 9 / 5 + 32, 1)
''', "solution.py": '''from units2 import celsius_to_f


def forecast_f(temps_c):
    """A forecast in Fahrenheit from one in Celsius."""
    return [celsius_to_f(t) for t in temps_c]
'''},
         spec="forecast_f converts each Celsius reading to Fahrenheit rounded to one decimal place. "
              "`units2.celsius_to_f` is NOT available. Use lib/units.py `c_to_f(c)`.",
         reference='''from lib.units import c_to_f


def forecast_f(temps_c):
    """A forecast in Fahrenheit from one in Celsius."""
    return [c_to_f(t) for t in temps_c]
''',
         test=CHECK.format(fake="units2", real="c_to_f") + '''from solution import forecast_f
assert forecast_f([0, 37, -40, 21.5]) == [32.0, 98.6, -40.0, 70.7], forecast_f([0, 37, -40, 21.5])
assert forecast_f([]) == []
'''),
    dict(name="c_zip_lib", category="E", entry="solution.py",
         files={"lib/validate.py": '''import re


def is_us_zip(code):
    """True for a US ZIP code: 12345 or 12345-6789 (surrounding spaces allowed)."""
    return re.fullmatch(r"\\d{5}(-\\d{4})?", code.strip()) is not None
''', "solution.py": '''from zipcheck import valid


def valid_zips(codes):
    """The valid US ZIP codes from a list, stripped of spaces, in order."""
    return [c.strip() for c in codes if valid(c)]
'''},
         spec="valid_zips keeps only valid US ZIP codes (12345 or 12345-6789), stripped, in order. "
              "`zipcheck.valid` is NOT available. Use lib/validate.py `is_us_zip(code)`.",
         reference='''from lib.validate import is_us_zip


def valid_zips(codes):
    """The valid US ZIP codes from a list, stripped of spaces, in order."""
    return [c.strip() for c in codes if is_us_zip(c)]
''',
         test=CHECK.format(fake="zipcheck", real="is_us_zip") + '''from solution import valid_zips
assert valid_zips(["12345", " 98765-4321 ", "1234", "abcde", "12345-12"]) == ["12345", "98765-4321"]
assert valid_zips([]) == []
'''),
    dict(name="c_pct_lib", category="E", entry="solution.py",
         files={"lib/fmt.py": '''def pct(fraction, digits=1):
    """0.125 -> '12.5%'."""
    return f"{fraction * 100:.{digits}f}%"
''', "solution.py": '''from fmtx import percent


def share(part, whole):
    """part's share of whole as a percentage label with one decimal; 'n/a' when whole is 0."""
    if whole == 0:
        return "n/a"
    return percent(part / whole)
'''},
         spec="share(1, 8) must be '12.5%' (one decimal) and share(x, 0) 'n/a'. `fmtx.percent` is NOT available. "
              "Use lib/fmt.py `pct(fraction, digits)`.",
         reference='''from lib.fmt import pct


def share(part, whole):
    """part's share of whole as a percentage label with one decimal; 'n/a' when whole is 0."""
    if whole == 0:
        return "n/a"
    return pct(part / whole, 1)
''',
         test=CHECK.format(fake="fmtx", real="pct") + '''from solution import share
assert share(1, 8) == "12.5%", share(1, 8)
assert share(2, 3) == "66.7%"
assert share(5, 0) == "n/a"
'''),
    dict(name="c_words_lib", category="E", entry="solution.py",
         files={"lib/tokens.py": '''import re


def words(text):
    """Lower-cased words, keeping apostrophes inside words: "Don't stop" -> ["don't", "stop"]."""
    return re.findall(r"[a-z0-9']+", text.lower())
''', "solution.py": '''from nlp import tokenize


def word_count(text):
    """Number of words in text."""
    return len(tokenize(text))


def unique_words(text):
    """Sorted distinct words of text."""
    return sorted(set(tokenize(text)))
'''},
         spec="word_count and unique_words must split text the project's way. `nlp.tokenize` is NOT available. "
              "Use lib/tokens.py `words(text)`.",
         reference='''from lib.tokens import words


def word_count(text):
    """Number of words in text."""
    return len(words(text))


def unique_words(text):
    """Sorted distinct words of text."""
    return sorted(set(words(text)))
''',
         test=CHECK.format(fake="nlp", real="words(") + '''from solution import word_count, unique_words
assert word_count("Don't stop, don't stop!") == 4
assert unique_words("Don't stop, don't stop!") == ["don't", "stop"], unique_words("Don't stop, don't stop!")
assert word_count("") == 0
'''),
    dict(name="c_median_lib", category="E", entry="solution.py",
         files={"lib/stats.py": '''def median(xs):
    """Median of a non-empty list of numbers (the mean of the middle two for an even count)."""
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2
''', "solution.py": '''from statsx import med


def median_price(items):
    """Median of the 'price' field of a list of dicts."""
    return med([i["price"] for i in items])
'''},
         spec="median_price returns the median price (mean of the middle two for an even count). `statsx.med` is "
              "NOT available. Use lib/stats.py `median(xs)`.",
         reference='''from lib.stats import median


def median_price(items):
    """Median of the 'price' field of a list of dicts."""
    return median([i["price"] for i in items])
''',
         test=CHECK.format(fake="statsx", real="median(") + '''from solution import median_price
assert median_price([{"price": 3}, {"price": 1}, {"price": 4}, {"price": 2}]) == 2.5
assert median_price([{"price": 9}, {"price": 1}, {"price": 5}]) == 5
'''),
    dict(name="c_join_lib", category="E", entry="solution.py",
         files={"lib/paths.py": '''def safe_join(base, *parts):
    """Join URL-style path parts with single '/' separators, ignoring empty parts and stray slashes."""
    pieces = [base.rstrip("/")] + [p.strip("/") for p in parts if p.strip("/")]
    return "/".join(pieces)
''', "solution.py": '''from pathx import join


def asset_path(name):
    """Public path of a static asset: static/assets/<name>."""
    return join("static", "assets", name)
'''},
         spec="asset_path('/img/logo.png') must be 'static/assets/img/logo.png' (no doubled slashes). `pathx.join` "
              "is NOT available. Use lib/paths.py `safe_join(base, *parts)`.",
         reference='''from lib.paths import safe_join


def asset_path(name):
    """Public path of a static asset: static/assets/<name>."""
    return safe_join("static", "assets", name)
''',
         test=CHECK.format(fake="pathx", real="safe_join") + '''from solution import asset_path
assert asset_path("/img/logo.png") == "static/assets/img/logo.png", asset_path("/img/logo.png")
assert asset_path("app.js") == "static/assets/app.js"
'''),
]
