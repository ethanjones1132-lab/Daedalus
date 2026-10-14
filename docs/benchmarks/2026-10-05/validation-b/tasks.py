"""Fresh hidden-package (category B style) tasks, written 2026-10-05 to check, on tasks disjoint from
tier2b, whether the routing found on tier2b holds: Laya flags "depends on unseen code", Gemma 26B
beats Qwen3.6 keep96 there. Same shape as tier2b's B tasks: fix `entry`; `hidden_file` is in the
package but its source is not shown; the test exercises the real hidden module.
Each task carries `reference` (a correct entry file) so validate.py can prove the test fails on the
buggy file and passes on a fix. The reference is never shown to a model.
"""
K = 3

TASKS = [
    dict(name="v_invoice_cents", category="B", entry="invoice.py", hidden_file="money.py",
         files={"money.py": '''def format_money(cents):
    """Format an integer number of cents as a dollar string."""
    sign = "-" if cents < 0 else ""
    cents = abs(int(cents))
    return f"{sign}${cents // 100}.{cents % 100:02d}"
''', "invoice.py": '''from money import format_money


def invoice_total(prices):
    """prices: item prices in dollars (floats). Returns the formatted total."""
    total = sum(prices)
    return format_money(total)
'''},
         spec="Invoice totals are shown about a hundred times too small: items costing $10.00, $5.50 and $2.25 "
              "show a total of $0.17 instead of $17.75.",
         reference='''from money import format_money


def invoice_total(prices):
    """prices: item prices in dollars (floats). Returns the formatted total."""
    return format_money(round(sum(prices) * 100))
''',
         test='''from invoice import invoice_total
assert invoice_total([10.0, 5.5, 2.25]) == "$17.75", invoice_total([10.0, 5.5, 2.25])
assert invoice_total([]) == "$0.00"
assert invoice_total([0.1, 0.2]) == "$0.30", invoice_total([0.1, 0.2])
assert invoice_total([19.99]) == "$19.99", invoice_total([19.99])
'''),
    dict(name="v_session_timeout", category="B", entry="session.py", hidden_file="clock.py",
         files={"clock.py": '''import time


def now():
    """Current time in whole seconds since the epoch."""
    return int(time.time())
''', "session.py": '''import clock

TIMEOUT_MS = 30 * 60 * 1000  # sessions last 30 minutes


def is_expired(last_seen):
    """last_seen: the clock.now() value recorded at the user's last request."""
    return clock.now() - last_seen > TIMEOUT_MS
'''},
         spec="Users stay logged in for days: a session idle for two hours is still not expired. Sessions must "
              "expire after 30 minutes of inactivity.",
         reference='''import clock

TIMEOUT_MS = 30 * 60 * 1000  # sessions last 30 minutes


def is_expired(last_seen):
    """last_seen: the clock.now() value recorded at the user's last request."""
    return clock.now() - last_seen > TIMEOUT_MS // 1000
''',
         test='''import time
time.time = lambda: 100000.0
import session
assert session.is_expired(100000 - 2 * 3600) is True
assert session.is_expired(100000 - 29 * 60) is False
assert session.is_expired(100000 - 31 * 60) is True
assert session.is_expired(100000) is False
'''),
    dict(name="v_profile_missing_user", category="B", entry="profile.py", hidden_file="store.py",
         files={"store.py": '''_USERS = {"ada": {"name": "Ada Lovelace", "plan": "pro"}, "alan": {"name": "Alan Turing", "plan": "free"}}


def get_user(user_id):
    """Return a copy of the user record."""
    rec = _USERS.get(user_id)
    return dict(rec) if rec else None
''', "profile.py": '''import store


def display_name(user_id):
    """The user's name, or 'Guest' for unknown users."""
    try:
        return store.get_user(user_id)["name"]
    except KeyError:
        return "Guest"
'''},
         spec="Opening the profile page of a deleted user crashes instead of showing 'Guest'.",
         reference='''import store


def display_name(user_id):
    """The user's name, or 'Guest' for unknown users."""
    user = store.get_user(user_id)
    return user["name"] if user else "Guest"
''',
         test='''from profile import display_name
assert display_name("ada") == "Ada Lovelace"
assert display_name("alan") == "Alan Turing"
assert display_name("bob") == "Guest"
assert display_name("") == "Guest"
'''),
    dict(name="v_delivery_km", category="B", entry="delivery.py", hidden_file="geo.py",
         files={"geo.py": '''import math


def distance(a, b):
    """Great-circle distance between two (lat, lon) points."""
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))
''', "delivery.py": '''from geo import distance

BASE_FEE = 2.00  # dollars
PER_KM = 0.50    # dollars per kilometre


def delivery_fee(shop, home):
    metres = distance(shop, home)
    return round(BASE_FEE + PER_KM * metres / 1000, 2)
'''},
         spec="Delivery fees barely change with distance: a 10 km delivery costs $2.01 instead of $7.00.",
         reference='''from geo import distance

BASE_FEE = 2.00  # dollars
PER_KM = 0.50    # dollars per kilometre


def delivery_fee(shop, home):
    km = distance(shop, home)
    return round(BASE_FEE + PER_KM * km, 2)
''',
         test='''from delivery import delivery_fee
assert delivery_fee((0, 0), (0, 0)) == 2.0
assert abs(delivery_fee((0, 0), (0, 0.0899322)) - 7.0) < 0.011, delivery_fee((0, 0), (0, 0.0899322))
assert abs(delivery_fee((0, 0), (0, 0.899322)) - 52.0) < 0.011, delivery_fee((0, 0), (0, 0.899322))
'''),
    dict(name="v_report_dates", category="B", entry="report.py", hidden_file="dates.py",
         files={"dates.py": '''def parse(s):
    """Parse a date string from the bank export into three integers."""
    d, m, y = s.split("/")
    return int(d), int(m), int(y)
''', "report.py": '''from dates import parse


def iso_date(s):
    """Convert a date string from the bank export into ISO 'YYYY-MM-DD'."""
    year, month, day = parse(s)
    return f"{year:04d}-{month:02d}-{day:02d}"
'''},
         spec="Dates in the monthly report come out scrambled: the bank's 05/03/2024 is printed as 0005-03-2024 "
              "instead of 2024-03-05.",
         reference='''from dates import parse


def iso_date(s):
    """Convert a date string from the bank export into ISO 'YYYY-MM-DD'."""
    day, month, year = parse(s)
    return f"{year:04d}-{month:02d}-{day:02d}"
''',
         test='''from report import iso_date
assert iso_date("05/03/2024") == "2024-03-05", iso_date("05/03/2024")
assert iso_date("31/12/1999") == "1999-12-31"
assert iso_date("01/10/2026") == "2026-10-01"
'''),
    dict(name="v_ship_order", category="B", entry="worker.py", hidden_file="jobs.py",
         files={"jobs.py": '''class JobStack:
    """Pending jobs."""

    def __init__(self):
        self._items = []

    def add(self, job):
        self._items.append(job)

    def take(self):
        return self._items.pop()

    def __len__(self):
        return len(self._items)
''', "worker.py": '''from jobs import JobStack


def shipping_order(orders):
    """The orders in the order they should ship: first come, first served."""
    stack = JobStack()
    for o in orders:
        stack.add(o)
    shipped = []
    while len(stack):
        shipped.append(stack.take())
    return shipped
'''},
         spec="Orders ship in reverse: the earliest order of the day ships last. Orders must ship first come, "
              "first served.",
         reference='''from jobs import JobStack


def shipping_order(orders):
    """The orders in the order they should ship: first come, first served."""
    stack = JobStack()
    for o in reversed(orders):
        stack.add(o)
    shipped = []
    while len(stack):
        shipped.append(stack.take())
    return shipped
''',
         test='''from worker import shipping_order
assert shipping_order([1, 2, 3]) == [1, 2, 3], shipping_order([1, 2, 3])
assert shipping_order([]) == []
assert shipping_order(["a"]) == ["a"]
assert shipping_order(["x", "y"]) == ["x", "y"]
'''),
    dict(name="v_sales_tax_percent", category="B", entry="checkout.py", hidden_file="taxes.py",
         files={"taxes.py": '''_RATES = {"CA": 7.25, "NY": 4.0, "OR": 0.0}


def rate(region):
    """Sales-tax rate for a region."""
    return _RATES.get(region, 5.0)
''', "checkout.py": '''from taxes import rate


def total_with_tax(subtotal, region):
    return round(subtotal * (1 + rate(region)), 2)
'''},
         spec="A customer in California was charged $165.00 for a $20.00 order. With California's 7.25% sales "
              "tax it should be $21.45.",
         reference='''from taxes import rate


def total_with_tax(subtotal, region):
    return round(subtotal * (1 + rate(region) / 100), 2)
''',
         test='''from checkout import total_with_tax
assert total_with_tax(20.0, "CA") == 21.45, total_with_tax(20.0, "CA")
assert total_with_tax(10.0, "OR") == 10.0
assert total_with_tax(100.0, "NY") == 104.0
assert total_with_tax(50.0, "TX") == 52.5
'''),
    dict(name="v_upload_retries", category="B", entry="uploader.py", hidden_file="policy.py",
         files={"policy.py": '''MAX_ATTEMPTS = 3


def may_retry(attempts_made):
    """Whether another attempt is allowed."""
    return attempts_made < MAX_ATTEMPTS
''', "uploader.py": '''import policy


def upload(send):
    """Call send() until it returns True, retrying as the policy allows. Returns the number of attempts made."""
    attempts = 0
    while True:
        attempts += 1
        if send():
            return attempts
        if not policy.may_retry(attempts + 1):
            return attempts
'''},
         spec="Uploads give up after 2 attempts, but the retry policy allows 3 attempts in total.",
         reference='''import policy


def upload(send):
    """Call send() until it returns True, retrying as the policy allows. Returns the number of attempts made."""
    attempts = 0
    while True:
        attempts += 1
        if send():
            return attempts
        if not policy.may_retry(attempts):
            return attempts
''',
         test='''from uploader import upload
calls = []
def failing():
    calls.append(1)
    return False
assert upload(failing) == 3 and len(calls) == 3, (len(calls),)
seq = iter([False, False, True])
assert upload(lambda: next(seq)) == 3
assert upload(lambda: True) == 1
'''),
    dict(name="v_heat_alert_units", category="B", entry="alerts.py", hidden_file="sensors.py",
         files={"sensors.py": '''_LATEST = {"greenhouse": 95.0, "cellar": 50.0, "office": 68.0}


def read(sensor_id):
    """Latest reading of a temperature sensor."""
    return _LATEST[sensor_id]
''', "alerts.py": '''from sensors import read

HOT_C = 30.0  # alert when warmer than 30 degrees Celsius


def too_hot(sensor_id):
    return read(sensor_id) > HOT_C
'''},
         spec="The office, a comfortable 20 °C, keeps raising heat alerts. Only places warmer than 30 °C should.",
         reference='''from sensors import read

HOT_C = 30.0  # alert when warmer than 30 degrees Celsius


def too_hot(sensor_id):
    return (read(sensor_id) - 32) * 5 / 9 > HOT_C
''',
         test='''from alerts import too_hot
assert too_hot("greenhouse") is True
assert too_hot("office") is False
assert too_hot("cellar") is False
'''),
    dict(name="v_pages_from_one", category="B", entry="listing.py", hidden_file="pager.py",
         files={"pager.py": '''def page(items, number, size=10):
    """Return one page of items."""
    start = (number - 1) * size
    return items[start:start + size] if start >= 0 else []
''', "listing.py": '''from pager import page


def all_pages(items, size=10):
    """Every page of items, in order."""
    out, n = [], 0
    while True:
        p = page(items, n, size)
        if not p:
            return out
        out.append(p)
        n += 1
'''},
         spec="The product list shows no pages at all, even though there are 25 products.",
         reference='''from pager import page


def all_pages(items, size=10):
    """Every page of items, in order."""
    out, n = [], 1
    while True:
        p = page(items, n, size)
        if not p:
            return out
        out.append(p)
        n += 1
''',
         test='''from listing import all_pages
r = list(range(25))
assert all_pages(r, 10) == [r[0:10], r[10:20], r[20:25]], all_pages(r, 10)
assert all_pages([], 10) == []
assert all_pages([1, 2], 5) == [[1, 2]]
'''),
    dict(name="v_plugin_names", category="B", entry="plugins.py", hidden_file="registry.py",
         files={"registry.py": '''_PLUGINS = {}


def register(name, fn):
    _PLUGINS[name.lower()] = fn


def lookup(name):
    """The plugin registered under `name`, or None."""
    return _PLUGINS.get(name)
''', "plugins.py": '''import registry


def run(name, *args):
    """Run the plugin called `name`. Plugin names are case-insensitive."""
    fn = registry.lookup(name)
    if fn is None:
        raise KeyError(f"no plugin {name!r}")
    return fn(*args)
'''},
         spec="Running the plugin 'Resize' fails with KeyError: no plugin 'Resize', although it was registered "
              "as 'Resize'.",
         reference='''import registry


def run(name, *args):
    """Run the plugin called `name`. Plugin names are case-insensitive."""
    fn = registry.lookup(name.lower())
    if fn is None:
        raise KeyError(f"no plugin {name!r}")
    return fn(*args)
''',
         test='''import registry
from plugins import run
registry.register("Resize", lambda x: x * 2)
assert run("Resize", 3) == 6
assert run("RESIZE", 4) == 8
assert run("resize", 1) == 2
try:
    run("Crop", 1)
    raise SystemExit("expected KeyError")
except KeyError:
    pass
'''),
    dict(name="v_basket_currency", category="B", entry="basket.py", hidden_file="rates_fx.py",
         files={"rates_fx.py": '''from decimal import Decimal

_RATES = {"EUR": Decimal("0.92"), "GBP": Decimal("0.79"), "JPY": Decimal("149.50")}


def convert(amount, currency):
    """Convert a USD amount to `currency`, rounded to cents."""
    return (Decimal(str(amount)) * _RATES[currency]).quantize(Decimal("0.01"))
''', "basket.py": '''from rates_fx import convert


def basket_total(amounts, currency):
    """Total of the basket in `currency`, as a label like '14.26 EUR'."""
    total = 0.0
    for a in amounts:
        total += convert(a, currency)
    return f"{total:.2f} {currency}"
'''},
         spec="Basket totals in any currency other than USD crash with a TypeError when the basket has items.",
         reference='''from decimal import Decimal

from rates_fx import convert


def basket_total(amounts, currency):
    """Total of the basket in `currency`, as a label like '14.26 EUR'."""
    total = Decimal("0")
    for a in amounts:
        total += convert(a, currency)
    return f"{total:.2f} {currency}"
''',
         test='''from basket import basket_total
assert basket_total([10, 5.5], "EUR") == "14.26 EUR", basket_total([10, 5.5], "EUR")
assert basket_total([], "GBP") == "0.00 GBP"
assert basket_total([1], "JPY") == "149.50 JPY"
'''),
]
