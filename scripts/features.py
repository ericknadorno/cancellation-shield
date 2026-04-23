"""
nexo — Python port of lib/features.js.

Used by train_gbm.py to rebuild feature vectors from the raw reservation
JSON stored in the predictions.features column. MUST stay in sync with
lib/features.js — the JS scorer and the Python trainer MUST produce
identical numeric values for any given reservation, otherwise the model
learns one distribution and predicts another.

When lib/features.js changes, update this file in the SAME commit.
FEATURE_NAMES order is the contract: never reorder without invalidating
all trained models in model_weights.
"""

from datetime import datetime

# ─── CONSTANTS ───
BDC_MO = {
    "Alegria": [39.2, 29.2, 31.2, 22.2, 33.3, 32.0, 32.0, 29.4, 29.2, 49.0, 40.7, 33.3],
    "SB I":    [11.3, 25.3, 18.3, 37.4, 41.5, 47.4, 34.6, 37.6, 45.1, 50.0, 57.1, 34.5],
    "SB II":   [9.7, 26.5, 27.9, 31.9, 33.0, 30.1, 31.5, 30.8, 38.3, 40.5, 29.2, 46.1],
}

NAT_HIGH = ["india", "angola", "mozambique", "united arab emirates", "saudi arabia",
            "nigeria", "greece", "türkiye", "turkey", "morocco"]
NAT_MED  = ["brazil", "serbia", "singapore", "korea", "finland",
            "israel", "taiwan", "romania"]
NAT_LOW  = ["belgium", "switzerland", "latvia", "mexico", "sweden",
            "netherlands", "ukraine", "france", "czech republic", "norway"]

FEATURE_NAMES = [
    "pay", "rate", "lt", "chan", "los", "adr",
    "repeat", "card", "mod", "sea", "persons", "dow",
    "otaEmail", "nat", "natMiss", "agency", "noContact", "solo",
    "bookHour", "modCount", "adrVsAvg", "bookPayGap", "multiBook", "weather",
    "isRelay", "isGenius", "lateArrival",
    # ─── Phase 1 (Apr 2026) — leak-safe derived signals ───
    "checkedIn",         # Binary: guest did online check-in → strong negative
    "shortMidweek",      # Binary: nights <= 2 AND arrival on Tue/Wed/Thu
    "channelMonthRate"   # Cohort: observed cancel rate for (channel × month)
]

# Leak-safe subset used for TRAINING only. Mirrors LEAK_SAFE_FEATURE_NAMES in
# lib/features.js. Excludes features whose values are set (or drastically
# shifted) by the very act of cancelling:
#
#   pay      — paymentStatus flips to "fail" after cancellation voids charges.
#   mod      — wasModified. A cancellation IS a modification.
#   modCount — modificationCount. Same root cause.
#
# Inference still uses the full 27-feature vector — only training is leak-safe.
_LEAK_FEATURES = {"pay", "mod", "modCount"}
LEAK_SAFE_FEATURE_NAMES = [n for n in FEATURE_NAMES if n not in _LEAK_FEATURES]


# ─── SCORERS ───
def is_non_refundable(rate: str) -> bool:
    l = (rate or "").lower()
    return ("nr " in l or l.startswith("nr") or "non-ref" in l
            or "non-refundable" in l or "early bird" in l)


def score_rate(rate: str) -> int:
    l = (rate or "").lower()
    if "flex 3" in l or "fully flexible" in l: return 62
    if "standard" in l and "breakfast" in l:   return 50
    if "flex 5" in l:                           return 48
    if "semi-flex" in l:                        return 38
    if "standard" in l and "booking" in l:      return 32
    if "standard" in l:                         return 35
    if "flex" in l and ("ota" in l or "pku" in l): return 55
    if "best flex" in l or "best rate" in l:    return 45
    if "half board" in l:                       return 30
    if "bed and breakfast" in l or "b&b" in l:  return 28
    if "black friday" in l:                     return 35
    if "friends" in l or "family" in l:         return 5
    if "welcome" in l:                          return 3
    if is_non_refundable(rate):                 return 3
    if "long" in l:                             return 10
    if "superior" in l:                         return 20
    if "test" in l or "aut " in l or "solution" in l: return 30
    return 28


def score_channel(source: str) -> int:
    l = (source or "").lower()
    if "telephone" in l:                                 return 85
    if "a-hotels" in l or "american express" in l:       return 82
    if "booking.com" in l:                               return 38
    if "booking engine" in l:                            return 32
    if "channel" in l:                                   return 35
    if "in person" in l:                                 return 30
    if "message" in l or "email" in l:                   return 25
    if "hotels.com" in l:                                return 18
    if "airbnb" in l:                                    return 14
    if "expedia" in l:                                   return 17
    if l == "connector" or "connector" in l:             return 55
    if l == "distributor" or "distributor" in l:         return 50
    if l == "commander" or "commander" in l:             return 20
    return 25


def score_lead_time(d) -> int:
    if d is None: return 20
    try:
        d = int(d)
    except (TypeError, ValueError):
        return 20
    if d < 0:   return 5
    if d <= 1:  return 15
    if d <= 3:  return 30
    if d <= 7:  return 40
    if d <= 14: return 48
    if d <= 30: return 55
    if d <= 60: return 65
    if d <= 90: return 72
    return 80


def score_season(m, prop_name: str = "") -> int:
    if not m: return 25
    name = (prop_name or "").lower()
    key = "Alegria"
    if "santa" in name and "ii" in name:
        key = "SB II"
    elif "santa" in name:
        key = "SB I"
    b = BDC_MO.get(key, [30] * 12)
    i = (int(m) - 3 + 12) % 12
    return round((b[i] if i < len(b) else 30) * 0.7)


def score_los(n) -> int:
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        return 20
    if n <= 0:  return 20
    if n == 1:  return 30
    if n <= 2:  return 25
    if n <= 4:  return 20
    if n <= 7:  return 28
    if n <= 14: return 55
    return 70


def score_payment(p: str) -> int:
    s = (p or "").lower().strip()
    if s in ("charged", "paid", "success"): return 2
    if s == "partial":                      return 15
    if s in ("fail", "failed"):             return 50
    return 45


def score_adr(a) -> int:
    try:
        a = float(a or 0)
    except (TypeError, ValueError):
        return 25
    if a <= 0:    return 25
    if a < 80:    return 10
    if a < 120:   return 12
    if a < 180:   return 18
    if a < 250:   return 30
    if a < 400:   return 45
    if a < 1000:  return 55
    return 40


def score_nationality(nat: str) -> int:
    n = (nat or "").lower()
    if any(x in n for x in NAT_HIGH): return 10
    if any(x in n for x in NAT_MED):  return 4
    if any(x in n for x in NAT_LOW):  return -5
    return 0


def score_repeat(ps, pc) -> int:
    try:
        ps = int(ps or 0)
        pc = int(pc or 0)
    except (TypeError, ValueError):
        return 0
    if ps >= 3: return -25
    if ps >= 1: return -15
    if pc >= 2: return 20
    if pc >= 1: return 10
    return 0


def score_card(has_card) -> int:
    return -5 if has_card else 8


def score_modified(was) -> int:
    return -5 if was else 3


def score_agency(has) -> int:
    return 8 if has else 0


def score_nat_missing(n) -> int:
    return 5 if (not n or n == "") else 0


def score_dow(arrival: str) -> int:
    if not arrival: return 0
    try:
        d = datetime.strptime(arrival + "T12:00:00", "%Y-%m-%dT%H:%M:%S").weekday()
        # Python: Monday=0, Sunday=6. JS Date.getDay(): Sunday=0, Saturday=6
        # Convert to JS semantics: add 1 then mod 7
        js_day = (d + 1) % 7
    except ValueError:
        return 0
    if js_day == 5 or js_day == 6: return 5  # Friday, Saturday
    if js_day == 0: return 3                  # Sunday
    return 0


def score_persons(count, has_children) -> int:
    if has_children: return -8
    try:
        c = int(count or 0)
    except (TypeError, ValueError):
        return 0
    if c >= 3: return -3
    if c == 1: return 5
    return 0


def score_ota_email(has_ota, email: str) -> int:
    if has_ota: return 12
    if email and ("@guest.booking.com" in email or "@relay." in email): return 15
    return 0


def score_booking_hour(h) -> int:
    if h is None: return 50
    try:
        h = int(h)
    except (TypeError, ValueError):
        return 50
    if 0 <= h <= 5:  return 78
    if h >= 22:      return 65
    if 6 <= h <= 9:  return 38
    return 50


def score_mod_count(c) -> int:
    try:
        c = int(c or 0)
    except (TypeError, ValueError):
        return 35
    if c == 0: return 35
    if c == 1: return 55
    if c == 2: return 68
    return min(80, 68 + c * 4)


def score_adr_vs_avg(a, avg) -> int:
    try:
        a = float(a or 0)
        avg = float(avg or 0)
    except (TypeError, ValueError):
        return 50
    if avg == 0 or a == 0: return 50
    r = a / avg
    if r < 0.6: return 75
    if r < 0.8: return 62
    if r > 1.4: return 30
    if r > 1.1: return 40
    return 50


def score_book_pay_gap(g) -> int:
    if g is None: return 50
    try:
        g = int(g)
    except (TypeError, ValueError):
        return 50
    if g <= 0: return 28
    if g <= 1: return 38
    if g <= 3: return 50
    if g <= 7: return 62
    return 75


def score_multi_booking(c) -> int:
    try:
        c = int(c or 0)
    except (TypeError, ValueError):
        return 45
    if c <= 1: return 45
    if c == 2: return 65
    return min(82, 65 + c * 5)


def score_weather(code) -> int:
    if not code: return 50
    try:
        code = int(code)
    except (TypeError, ValueError):
        return 50
    if 200 <= code < 300: return 72
    if 500 <= code < 600: return 65
    if 600 <= code < 700: return 68
    if code == 800:        return 32
    if 801 <= code <= 802: return 40
    return 50


# ─── PHASE 1 SCORERS ───

def score_checked_in(v) -> int:
    """1 if guest did online check-in, else 0. Strong negative signal — such
    guests almost never cancel. Mirrors scoreCheckedIn in lib/features.js."""
    return 1 if v else 0


def score_short_midweek(nights, arrival) -> int:
    """1 if short stay (<=2 nights) on a midweek day (Tue/Wed/Thu arrival),
    else 0. Captures the business-travel profile as a single interaction
    feature so the GBM doesn't have to learn (nights AND dow) from scratch.
    Mirrors scoreShortMidweek in lib/features.js."""
    try:
        n = int(nights or 0)
    except (TypeError, ValueError):
        return 0
    if n <= 0 or n > 2:
        return 0
    if not arrival:
        return 0
    try:
        # JS Date.getDay(): Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
        py_dow = datetime.strptime(arrival + "T12:00:00", "%Y-%m-%dT%H:%M:%S").weekday()
        js_dow = (py_dow + 1) % 7  # Python Mon=0 → JS Tue=2 requires +1 mod 7
        return 1 if js_dow in (2, 3, 4) else 0
    except ValueError:
        return 0


def channel_bucket(s) -> str:
    """Collapse raw Mews source strings to 8 stable buckets. MUST match
    channelBucket in lib/features.js exactly — the cohort lookup table is
    keyed by bucket_month, so JS and Python have to agree on the bucket."""
    l = (s or "").lower()
    if "booking.com" in l:                                               return "booking"
    if "airbnb" in l:                                                    return "airbnb"
    if "expedia" in l or "hotels.com" in l:                              return "expedia"
    if "telephone" in l or "phone" in l:                                 return "phone"
    if "in person" in l:                                                 return "walkin"
    if ("booking engine" in l or "connector" in l
            or "distributor" in l or "commander" in l):                  return "direct"
    if "email" in l or "message" in l:                                   return "message"
    return "other"


def score_channel_month_rate(source, arr_month, cohort_rates) -> int:
    """Look up the (channel_bucket, arrival_month) cancel rate. Returns 0-100
    (percent). Falls back to the overall rate stored under "_all", then 33
    (global prior) if everything is missing. Mirrors scoreChannelMonthRate."""
    if not cohort_rates or not isinstance(cohort_rates, dict):
        return 33
    bucket = channel_bucket(source)
    key = f"{bucket}_{arr_month or 0}"
    cell = cohort_rates.get(key)
    if cell and isinstance(cell.get("rate"), (int, float)) and cell.get("count", 0) >= 30:
        return round(float(cell["rate"]) * 100)
    overall = cohort_rates.get("_all")
    if overall and isinstance(overall.get("rate"), (int, float)):
        return round(float(overall["rate"]) * 100)
    return 33


# ─── VECTOR ───
def extract_feature_vector(r: dict, cohort_rates: dict = None) -> dict:
    """Return dict keyed by FEATURE_NAMES, mirrors lib/features.js exactly.

    `cohort_rates` is optional — when absent, score_channel_month_rate
    returns the global prior. train_gbm.py passes the freshly-computed table
    during training; inference-time callers read it from the stored model.
    """
    pay = (r.get("paymentStatus") or r.get("payment") or "").lower().strip()
    email = r.get("email") or ""
    return {
        "pay":        score_payment(pay),
        "rate":       score_rate(r.get("rate") or ""),
        "lt":         score_lead_time(r.get("daysUntil")),
        "chan":       score_channel(r.get("source")),
        "los":        score_los(r.get("nights")),
        "adr":        score_adr(r.get("adr")),
        "repeat":     score_repeat(r.get("previousStays") or 0, r.get("previousCancels") or 0),
        "card":       score_card(r.get("hasCreditCard")),
        "mod":        score_modified(r.get("wasModified")),
        "sea":        score_season(r.get("arrMonth"), r.get("prop")),
        "persons":    score_persons(r.get("persons"), r.get("hasChildren")),
        "dow":        score_dow(r.get("arrival")),
        "otaEmail":   score_ota_email(r.get("hasOtaEmail"), email),
        "nat":        score_nationality(r.get("nationality")),
        "natMiss":    score_nat_missing(r.get("nationality")),
        "agency":     score_agency(r.get("hasTravelAgency")),
        "noContact":  55 if r.get("hasNoContact") else 5,
        "solo":       35 if r.get("isSolo") else 15,
        "bookHour":   score_booking_hour(r.get("bookingHour")),
        "modCount":   score_mod_count(r.get("modificationCount") or 0),
        "adrVsAvg":   score_adr_vs_avg(r.get("adr"), r.get("propAvgAdr")),
        "bookPayGap": score_book_pay_gap(r.get("bookPayGapDays")),
        "multiBook":  score_multi_booking(r.get("guestActiveBookings")),
        "weather":    score_weather(r.get("weatherCode")),
        "isRelay":    1 if r.get("isRelay") else 0,
        "isGenius":   1 if r.get("isGenius") else 0,
        "lateArrival": 1 if r.get("lateArrival") else 0,
        # Phase 1 additions — see lib/features.js for contract docs
        "checkedIn":        score_checked_in(r.get("guestCheckedIn")),
        "shortMidweek":     score_short_midweek(r.get("nights"), r.get("arrival")),
        "channelMonthRate": score_channel_month_rate(r.get("source"), r.get("arrMonth"), cohort_rates),
    }


def to_numeric_array(fv: dict) -> list:
    """Return values in the canonical FEATURE_NAMES order."""
    return [fv[name] for name in FEATURE_NAMES]
