"""Population analytics for the policy dashboard: anonymised aggregates only.

Everything here works on the whole registry (all patients), and nothing it returns can identify a person:
- no names, MRNs, ids, dates of birth, phone numbers or free text ever leave this module;
- any group (region, facility, month) built from fewer than MIN_GROUP patients is suppressed: counts become "<5",
  rates become null, and the row says `suppressed: true` (the privacy floor, see docs/POLICY.md).

Sources for the fixed numbers (populations, effect sizes, costs) are listed in docs/POLICY.md. When the research work
stream's `docs/research/sim_params.json` exists, populations and intervention effects found there override the
defaults below.
"""
from __future__ import annotations

import csv
import io
import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import risk
from app.db import Assessment, Crisis, Patient

MIN_GROUP = 5          # privacy floor: groups with fewer patients are suppressed
SUPPRESSED = "<5"

# Ghana 2021 Population and Housing Census, General Report Vol 3A (Ghana Statistical Service). Sum = 30,832,019.
CENSUS_2021 = {
    "Western": 2_060_585, "Central": 2_859_821, "Greater Accra": 5_455_692, "Volta": 1_659_040,
    "Eastern": 2_925_653, "Ashanti": 5_440_463, "Western North": 880_921, "Ahafo": 564_668, "Bono": 1_208_649,
    "Bono East": 1_203_400, "Oti": 747_248, "Northern": 2_310_939, "Savannah": 653_266, "North East": 658_946,
    "Upper East": 1_301_226, "Upper West": 901_502,
}
REGIONS = list(CENSUS_2021)

# Defaults used when the data is too thin to estimate them (and as the documented fallbacks)
DEFAULT_LOS = 3.0                 # median length of stay for SCD admissions in Ghana (Narh et al., BMJ Open 2021)
DEFAULT_ADMIT_RATE = 0.45         # share of crises that lead to admission when the registry has no crises yet
DEFAULT_COST_BED_DAY = 600.0      # GHS per ward bed-day, illustrative; editable in the UI (?cost_per_bed_day=)
DEFAULT_ED_VISIT = 250.0          # GHS per crisis treated without admission (emergency/day-care visit), illustrative
# Prior seasonal index by month (1 = average month). Harmattan (Dec-Feb: cold, dry, dusty) is the high season.
SEASON_PRIOR = {1: 1.25, 2: 1.15, 3: 1.0, 4: 0.95, 5: 0.92, 6: 0.92, 7: 0.95, 8: 0.92, 9: 0.92, 10: 0.92,
                11: 1.0, 12: 1.2}

# Factors a health programme can act on (keys from app.risk.FEATURES)
MODIFIABLE = {"low_hydration", "cold", "infection", "fever", "missed_hu", "short_sleep", "stress", "alcohol",
              "exertion", "low_spo2"}
LEVER = {"low_hydration": "Hydration programme", "cold": "Cold-season outreach", "infection": "Infection prevention",
         "fever": "Infection prevention", "missed_hu": "Adherence support", "short_sleep": "Sleep and stress support",
         "stress": "Sleep and stress support", "alcohol": "Health education", "exertion": "Health education",
         "low_spo2": "Infection prevention"}

RESEARCH_FILE = Path(__file__).resolve().parents[2] / "docs" / "research" / "sim_params.json"


# ---------------------------------------------------------------- research parameters (optional file)
def _norm_region(name: str) -> Optional[str]:
    n = (name or "").strip().lower().replace("region", "").replace("-", " ").replace("_", " ").strip()
    n = " ".join(n.split())
    for r in REGIONS:
        if r.lower() == n:
            return r
    return None


def research_params() -> dict:
    """Reads docs/research/sim_params.json when it exists (any reasonable shape); {} otherwise."""
    try:
        raw = json.loads(RESEARCH_FILE.read_text())
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def populations() -> tuple[dict[str, int], str]:
    """Region -> population, and where the figures came from."""
    raw = research_params()
    found: dict[str, int] = {}

    def take(obj: Any) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                r = _norm_region(k)
                if r and isinstance(v, (int, float)) and v > 1000:
                    found[r] = int(v)
                elif r and isinstance(v, dict):
                    for pk in ("population", "population_2021", "pop", "census_2021"):
                        if isinstance(v.get(pk), (int, float)):
                            found[r] = int(v[pk])
                            break
                elif isinstance(v, (dict, list)):
                    take(v)
        elif isinstance(obj, list):
            for it in obj:
                if isinstance(it, dict):
                    r = _norm_region(str(it.get("region") or it.get("name") or ""))
                    pop = next((it[k] for k in ("population", "population_2021", "pop", "census_2021")
                                if isinstance(it.get(k), (int, float))), None)
                    if r and pop:
                        found[r] = int(pop)
                    else:
                        take(it)

    take(raw)
    if len(found) == 16:
        return found, "Ghana Statistical Service, 2021 Population and Housing Census (via docs/research/sim_params.json)"
    return dict(CENSUS_2021), "Ghana Statistical Service, 2021 Population and Housing Census (General Report Vol 3A)"


# ---------------------------------------------------------------- data snapshot
@dataclass
class P:
    """One patient as analytics sees it: no identifying fields at all."""
    key: int
    region: str
    facility: str
    genotype: str
    on_hu: bool
    crises_12m_field: int
    prob: Optional[float] = None        # latest model probability (0-1), if assessed recently
    score: Optional[float] = None
    level: Optional[str] = None
    factors: list = field(default_factory=list)


@dataclass
class C:
    pkey: int
    date: date
    hospitalised: bool
    los: Optional[float]


@dataclass
class Snapshot:
    today: date
    patients: list[P]
    crises: list[C]
    scores: list[tuple[int, date, float]]  # (patient key, for_date, score) for monthly average risk


CURRENT_DAYS = 30   # an assessment older than this is not "current"


async def snapshot(s: AsyncSession, today: Optional[date] = None, months_back: int = 25) -> Snapshot:
    today = today or date.today()
    since = today - timedelta(days=31 * months_back)
    rows = (await s.execute(select(Patient.id, Patient.region, Patient.facility, Patient.genotype,
                                   Patient.on_hydroxyurea, Patient.crises_12m))).all()
    keys = {pid: i for i, (pid, *_rest) in enumerate(rows)}
    pats = [P(key=keys[pid], region=_norm_region(reg) or (reg or "Unknown"), facility=(fac or "").strip(),
              genotype=gt, on_hu=bool(hu), crises_12m_field=c12 or 0)
            for pid, reg, fac, gt, hu, c12 in rows]

    latest = (select(Assessment.patient_id, func.max(Assessment.created_at).label("m"))
              .group_by(Assessment.patient_id).subquery())
    arows = (await s.execute(select(Assessment.patient_id, Assessment.for_date, Assessment.probability,
                                    Assessment.score, Assessment.level, Assessment.factors)
                             .join(latest, (Assessment.patient_id == latest.c.patient_id)
                                   & (Assessment.created_at == latest.c.m)))).all()
    for pid, d, prob, score, level, factors in arows:
        if pid not in keys or d is None or (today - d).days > CURRENT_DAYS:
            continue
        p = pats[keys[pid]]
        p.prob, p.score, p.level, p.factors = prob, score, level, factors or []

    crows = (await s.execute(select(Crisis.patient_id, Crisis.date, Crisis.hospitalised, Crisis.los_days)
                             .where(Crisis.date >= since, Crisis.date <= today))).all()
    crises = [C(keys[pid], d, bool(h), los) for pid, d, h, los in crows if pid in keys]

    srows = (await s.execute(select(Assessment.patient_id, Assessment.for_date, Assessment.score)
                             .where(Assessment.for_date >= since))).all()
    scores = [(keys[pid], d, sc) for pid, d, sc in srows if pid in keys and d is not None]
    return Snapshot(today, pats, crises, scores)


# ---------------------------------------------------------------- helpers
def _cnt(n: int, suppressed: bool) -> int | str:
    return SUPPRESSED if suppressed else n


def _r(x: Optional[float], d: int = 1) -> Optional[float]:
    return None if x is None else round(x, d)


def _pct_change(cur: Optional[float], prev: Optional[float]) -> Optional[float]:
    if cur is None or prev is None or prev == 0:
        return None
    return round((cur - prev) / prev * 100, 1)


def _los(c: C, default: float) -> float:
    return c.los if c.los is not None and c.los > 0 else default


@dataclass
class Period:
    crises: int
    admissions: int
    bed_days: float
    avg_los: Optional[float]
    patients_with_crisis: int


def _period(crises: list[C], start: date, end: date, default_los: float = DEFAULT_LOS) -> Period:
    """Crises with start < date <= end."""
    cs = [c for c in crises if start < c.date <= end]
    adm = [c for c in cs if c.hospitalised]
    known = [c.los for c in adm if c.los is not None and c.los > 0]
    los = sum(known) / len(known) if known else None
    bed = sum(_los(c, los or default_los) for c in adm)
    return Period(len(cs), len(adm), bed, los, len({c.pkey for c in cs}))


def _cost(period: Period, cost_bed_day: float, ed_visit: float) -> float:
    return period.bed_days * cost_bed_day + (period.crises - period.admissions) * ed_visit


def baseline_prob(rate_per_year: float) -> float:
    """7-day probability of at least one crisis for a yearly crisis rate (Poisson)."""
    return 1 - math.exp(-max(0.0, rate_per_year) * 7 / 365)


def _rates(snap: Snapshot) -> dict[int, float]:
    """Crises per year by patient: events in the last 12 months, or the recorded crises_12m if larger."""
    cutoff = snap.today - timedelta(days=365)
    n: dict[int, int] = defaultdict(int)
    for c in snap.crises:
        if c.date > cutoff:
            n[c.pkey] += 1
    return {p.key: float(max(n.get(p.key, 0), p.crises_12m_field)) for p in snap.patients}


def current_prob(p: P, rate: float) -> float:
    return p.prob if p.prob is not None else baseline_prob(rate)


# ---------------------------------------------------------------- overview
def overview(snap: Snapshot, cost_bed_day: float = DEFAULT_COST_BED_DAY, ed_visit: float = DEFAULT_ED_VISIT) -> dict:
    t = snap.today
    cur = _period(snap.crises, t - timedelta(days=365), t)
    prev = _period(snap.crises, t - timedelta(days=730), t - timedelta(days=365))
    n = len(snap.patients)
    sup = 0 < n < MIN_GROUP
    rates = _rates(snap)
    hu = sum(p.on_hu for p in snap.patients)
    high = sum(1 for p in snap.patients if p.level in ("high", "critical"))
    assessed = [p for p in snap.patients if p.score is not None]
    exp_7d = sum(current_prob(p, rates[p.key]) for p in snap.patients)
    cost, cost_prev = _cost(cur, cost_bed_day, ed_visit), _cost(prev, cost_bed_day, ed_visit)
    has_prev = any(c.date <= t - timedelta(days=365) for c in snap.crises)
    # 30-day window vs the 30 days before, for a "recent" pulse
    c30 = _period(snap.crises, t - timedelta(days=30), t)
    c30p = _period(snap.crises, t - timedelta(days=60), t - timedelta(days=30))
    out = {
        "as_of": t.isoformat(),
        "patients": _cnt(n, sup),
        "regions": len({p.region for p in snap.patients if p.region in CENSUS_2021}),
        "facilities": len({p.facility for p in snap.patients if p.facility}),
        "crises_12m": None if sup else cur.crises,
        "admissions_12m": None if sup else cur.admissions,
        "bed_days_12m": None if sup else round(cur.bed_days),
        "avg_los": None if sup else _r(cur.avg_los if cur.avg_los is not None
                                       else (cur.bed_days / cur.admissions if cur.admissions else None)),
        "avg_los_imputed": cur.avg_los is None and cur.admissions > 0,
        "admission_rate": None if sup or not cur.crises else round(cur.admissions / cur.crises, 3),
        "hu_coverage": None if sup or not n else round(hu / n, 3),
        "high_risk_now": None if sup else _cnt(high, 0 < high < MIN_GROUP),
        "assessed_now": None if sup else len(assessed),
        "avg_risk_now": None if sup or not assessed else _r(sum(p.score for p in assessed) / len(assessed)),
        "expected_crises_7d": None if sup else _r(exp_7d),
        "crises_30d": None if sup else c30.crises,
        "est_cost_ghs_12m": None if sup else round(cost),
        "cost_per_bed_day_ghs": cost_bed_day,
        "ed_visit_cost_ghs": ed_visit,
        "suppressed": sup,
        "period": {"current": [(t - timedelta(days=365)).isoformat(), t.isoformat()],
                   "previous": [(t - timedelta(days=730)).isoformat(), (t - timedelta(days=365)).isoformat()]},
        "deltas": {},
    }
    if not sup and has_prev:
        out["deltas"] = {
            "crises_12m": {"previous": prev.crises, "change_pct": _pct_change(cur.crises, prev.crises)},
            "admissions_12m": {"previous": prev.admissions, "change_pct": _pct_change(cur.admissions, prev.admissions)},
            "bed_days_12m": {"previous": round(prev.bed_days), "change_pct": _pct_change(cur.bed_days, prev.bed_days)},
            "avg_los": {"previous": _r(prev.avg_los), "change_pct": _pct_change(cur.avg_los, prev.avg_los)},
            "est_cost_ghs_12m": {"previous": round(cost_prev), "change_pct": _pct_change(cost, cost_prev)},
        }
    if not sup:
        out["deltas"]["crises_30d"] = {"previous": c30p.crises, "change_pct": _pct_change(c30.crises, c30p.crises)}
    return out


# ---------------------------------------------------------------- regions / facilities
def _group_row(snap: Snapshot, members: list[P], cost_bed_day: float, ed_visit: float) -> dict:
    keys = {p.key for p in members}
    t = snap.today
    cs = [c for c in snap.crises if c.pkey in keys]
    cur = _period(cs, t - timedelta(days=365), t)
    n = len(members)
    assessed = [p for p in members if p.score is not None]
    high = sum(1 for p in members if p.level in ("high", "critical"))
    return {
        "patients": n,
        "crises_12m": cur.crises,
        "admissions_12m": cur.admissions,
        "bed_days_12m": round(cur.bed_days),
        "avg_los": _r(cur.avg_los),
        "crises_per_patient": round(cur.crises / n, 2) if n else None,
        "hu_coverage": round(sum(p.on_hu for p in members) / n, 3) if n else None,
        "avg_risk": _r(sum(p.score for p in assessed) / len(assessed)) if assessed else None,
        "high_risk_now": high,
        "est_cost_ghs_12m": round(_cost(cur, cost_bed_day, ed_visit)),
    }


_GROUP_FIELDS = ("crises_12m", "admissions_12m", "bed_days_12m", "avg_los", "crises_per_patient", "hu_coverage",
                 "avg_risk", "high_risk_now", "est_cost_ghs_12m")


def _suppress(row: dict) -> dict:
    row = dict(row, patients=SUPPRESSED, suppressed=True)
    for k in _GROUP_FIELDS + ("per_100k", "crises_per_100k", "admissions_per_100k"):
        if k in row:
            row[k] = None
    return row


def regions(snap: Snapshot, cost_bed_day: float = DEFAULT_COST_BED_DAY, ed_visit: float = DEFAULT_ED_VISIT) -> list[dict]:
    pops, _src = populations()
    by: dict[str, list[P]] = defaultdict(list)
    for p in snap.patients:
        by[p.region].append(p)
    out = []
    for reg in REGIONS + sorted(r for r in by if r not in CENSUS_2021):
        members = by.get(reg, [])
        pop = pops.get(reg)
        row = {"region": reg, "population": pop, **_group_row(snap, members, cost_bed_day, ed_visit)}
        per = (lambda x: round(x / pop * 100_000, 2)) if pop else (lambda x: None)
        row.update(per_100k=per(row["patients"]), crises_per_100k=per(row["crises_12m"]),
                   admissions_per_100k=per(row["admissions_12m"]), suppressed=False)
        n = len(members)
        if n == 0:
            row.update({k: None for k in _GROUP_FIELDS + ("per_100k", "crises_per_100k", "admissions_per_100k")},
                       patients=0)
        elif n < MIN_GROUP:
            row = _suppress(row)
        out.append(row)
    return out


def facilities(snap: Snapshot, cost_bed_day: float = DEFAULT_COST_BED_DAY,
               ed_visit: float = DEFAULT_ED_VISIT) -> list[dict]:
    """Facilities with at least MIN_GROUP patients by name; the rest pooled (names not shown)."""
    by: dict[tuple[str, str], list[P]] = defaultdict(list)
    for p in snap.patients:
        by[(p.facility or "Not recorded", p.region)].append(p)
    out, small = [], []
    for (fac, reg), members in sorted(by.items(), key=lambda kv: -len(kv[1])):
        if len(members) >= MIN_GROUP:
            out.append({"facility": fac, "region": reg, **_group_row(snap, members, cost_bed_day, ed_visit),
                        "suppressed": False})
        else:
            small.extend(members)
    if small:
        row = {"facility": "Other facilities (fewer than 5 patients each)", "region": None,
               **_group_row(snap, small, cost_bed_day, ed_visit), "suppressed": False, "pooled": True}
        out.append(_suppress(row) if len(small) < MIN_GROUP else row)
    return out


# ---------------------------------------------------------------- trends
def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _months(today: date, n: int) -> list[str]:
    y, m, out = today.year, today.month, []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out[::-1]


def trends(snap: Snapshot, months: int = 12, region: Optional[str] = None) -> list[dict]:
    months = max(1, min(36, months))
    keys = None
    if region:
        reg = _norm_region(region) or region
        keys = {p.key for p in snap.patients if p.region == reg}
    cs = [c for c in snap.crises if keys is None or c.pkey in keys]
    known = [c.los for c in cs if c.hospitalised and c.los]
    default_los = sum(known) / len(known) if known else DEFAULT_LOS
    agg: dict[str, dict] = {m: {"crises": 0, "admissions": 0, "bed_days": 0.0, "pts": set()}
                            for m in _months(snap.today, months)}
    for c in cs:
        a = agg.get(_month_key(c.date))
        if a is None:
            continue
        a["crises"] += 1
        a["pts"].add(c.pkey)
        if c.hospitalised:
            a["admissions"] += 1
            a["bed_days"] += _los(c, default_los)
    # average risk: mean per patient in the month, then mean across patients (so daily check-ins don't dominate)
    per: dict[str, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
    for k, d, sc in snap.scores:
        if keys is None or k in keys:
            per[_month_key(d)][k].append(sc)
    out = []
    for m, a in agg.items():
        n_pts = len(a["pts"])
        sup = 0 < n_pts < MIN_GROUP
        means = [sum(v) / len(v) for v in per.get(m, {}).values()]
        risk_sup = 0 < len(means) < MIN_GROUP
        out.append({
            "month": m,
            "crises": _cnt(a["crises"], sup),
            "admissions": None if sup else a["admissions"],
            "bed_days": None if sup else round(a["bed_days"], 1),
            "avg_risk": None if risk_sup or not means else round(sum(means) / len(means), 1),
            "patients_with_crisis": _cnt(n_pts, sup),
            "patients_assessed": _cnt(len(means), risk_sup),
            "suppressed": sup,
            "risk_suppressed": risk_sup,
        })
    return out


# ---------------------------------------------------------------- seasonality + forecast
def seasonality(snap: Snapshot, pseudo: float = 50.0) -> dict:
    """Monthly crisis index (1 = average month) from up to 24 months of registry crises.

    Each calendar month m: index_m = (crises_m + K * prior_m) / (months_observed_m * mean_per_month + K), with K = 50
    pseudo-crises, so a month with little data stays near the Harmattan prior and a month with lots of data follows
    the registry. Only months since the first recorded crisis count as observed. Normalised to average 1."""
    span_start = snap.today - timedelta(days=730)
    cs = [c for c in snap.crises if c.date > span_start]
    counts: dict[int, int] = defaultdict(int)
    for c in cs:
        counts[c.date.month] += 1
    first = min((c.date for c in cs), default=None)
    observed: dict[int, int] = defaultdict(int)
    if first:
        for m in _months(snap.today, 24):
            y, mo = int(m[:4]), int(m[5:])
            if (y, mo) >= (first.year, first.month):
                observed[mo] += 1
    total, n_obs = len(cs), sum(observed.values())
    mean = total / n_obs if n_obs else 0.0
    idx = {m: (counts[m] + pseudo * SEASON_PRIOR[m]) / (observed[m] * mean + pseudo) for m in range(1, 13)}
    norm = sum(idx.values()) / 12
    idx = {m: v / norm for m, v in idx.items()}
    return {"index": {m: round(v, 3) for m, v in idx.items()}, "crises_used": total, "months_observed": n_obs,
            "pseudo_count": pseudo}


def forecast(snap: Snapshot, weeks: int = 8, region: Optional[str] = None) -> dict:
    """Expected crises per week: each patient's current 7-day probability, decaying back to their own baseline
    (their yearly crisis rate) with a half-life of one week, times the seasonal index of the week relative to now."""
    weeks = max(1, min(26, weeks))
    rates = _rates(snap)
    members = snap.patients
    if region:
        reg = _norm_region(region) or region
        members = [p for p in members if p.region == reg]
    t = snap.today
    cur = _period([c for c in snap.crises if c.pkey in {p.key for p in members}], t - timedelta(days=365), t)
    admit = cur.admissions / cur.crises if cur.crises >= 10 else DEFAULT_ADMIT_RATE
    los = cur.avg_los or DEFAULT_LOS
    season = seasonality(snap)["index"]
    s_now = season[t.month]
    start = t + timedelta(days=(7 - t.weekday()) % 7 or 7)      # next Monday
    sup = 0 < len(members) < MIN_GROUP
    rows = []
    for h in range(weeks):
        ws = start + timedelta(days=7 * h)
        mid = ws + timedelta(days=3)
        s_rel = season[mid.month] / s_now
        decay = 0.5 ** (h + (start - t).days / 7)
        mu, var = 0.0, 0.0
        for p in members:
            base = baseline_prob(rates[p.key])
            now = current_prob(p, rates[p.key])
            pr = min(0.95, max(0.0, (base + (now - base) * decay) * s_rel))
            mu += pr
            var += pr * (1 - pr)
        rel = 0.10 + 0.025 * h            # model + seasonal uncertainty, widening with the horizon
        sd = math.sqrt(var + (rel * mu) ** 2)
        rows.append({
            "week_start": ws.isoformat(),
            "expected_crises": None if sup else round(mu, 1),
            "low": None if sup else round(max(0.0, mu - 1.645 * sd), 1),
            "high": None if sup else round(mu + 1.645 * sd, 1),
            "expected_admissions": None if sup else round(mu * admit, 1),
            "expected_bed_days": None if sup else round(mu * admit * los, 1),
            "season_index": round(season[mid.month], 2),
            "harmattan": mid.month in (12, 1, 2),
            "suppressed": sup,
        })
    return {"weeks": rows, "admission_rate": round(admit, 3), "avg_los": round(los, 1),
            "seasonality": season, "interval": "90%", "patients": _cnt(len(members), sup)}


# ---------------------------------------------------------------- risk drivers
def risk_shares(snap: Snapshot) -> dict[str, float]:
    """Population-wide share of modelled risk by factor (internal: used by the scenarios, never returned per factor
    when fewer than 5 patients have it)."""
    tot: dict[str, float] = defaultdict(float)
    for p in snap.patients:
        for f in p.factors or []:
            try:
                imp = float(f.get("impact") or 0)
            except (TypeError, ValueError, AttributeError):
                continue
            if imp > 0 and f.get("direction") != "down":
                tot[str(f.get("key") or "")] += imp
    total = sum(tot.values())
    return {k: v / total for k, v in tot.items()} if total else {}


def drivers(snap: Snapshot) -> dict:
    """Share of all modelled (positive) risk points across current assessments, by factor."""
    tot: dict[str, float] = defaultdict(float)
    pts: dict[str, int] = defaultdict(int)
    labels: dict[str, str] = dict(risk.LABELS)
    assessed = 0
    for p in snap.patients:
        if not p.factors:
            continue
        assessed += 1
        for f in p.factors:
            try:
                imp = float(f.get("impact") or 0)
            except (TypeError, ValueError, AttributeError):
                continue
            if imp <= 0 or f.get("direction") == "down":
                continue
            k = str(f.get("key") or "")
            tot[k] += imp
            pts[k] += 1
            labels.setdefault(k, str(f.get("label") or k))
    total = sum(tot.values())
    rows = []
    small_pts, small_mod, small_other = set(), 0.0, 0.0
    for k, v in sorted(tot.items(), key=lambda kv: -kv[1]):
        n = pts[k]
        if n < MIN_GROUP:      # factor seen in fewer than 5 patients: pooled, not shown on its own
            if k in MODIFIABLE:
                small_mod += v
            else:
                small_other += v
            continue
        rows.append({"factor": k, "label": labels.get(k, k), "share_of_risk": round(v / total, 4) if total else 0,
                     "risk_points": round(v, 1), "patients_affected": n,
                     "share_of_patients": round(n / assessed, 3) if assessed else None,
                     "modifiable": k in MODIFIABLE, "lever": LEVER.get(k), "suppressed": False})
    for key, label, v, mod in (("other_modifiable", "Other modifiable factors (each in fewer than 5 patients)",
                                small_mod, True),
                               ("other", "Other factors (each in fewer than 5 patients)", small_other, False)):
        if v > 0:
            rows.append({"factor": key, "label": label, "share_of_risk": round(v / total, 4),
                         "risk_points": round(v, 1), "patients_affected": None, "share_of_patients": None,
                         "modifiable": mod, "lever": None, "suppressed": True})
    sup = 0 < assessed < MIN_GROUP
    if sup:
        rows = []
    modifiable = sum(r["share_of_risk"] for r in rows if r["modifiable"])
    return {"drivers": rows, "assessed": _cnt(assessed, sup), "modifiable_share": round(modifiable, 4),
            "suppressed": sup}


# ---------------------------------------------------------------- interventions
# Effect sizes with sources. "effect" is the relative reduction applied to the crises the lever can reach.
EFFECTS = {
    "hydroxyurea": {"crises": 0.45, "evidence": "high",
                    "source": "Charache et al., NEJM 1995 (MSH trial: median 2.5 vs 4.5 crises/yr, -44 %); "
                              "Tshilolo et al., NEJM 2019 (REACH, sub-Saharan Africa: VOC 98.3 -> 44.6 per 100 "
                              "patient-years)"},
    "hydration": {"crises": 0.30, "evidence": "low",
                  "source": "Assumption: removes ~30 % of the risk the model attributes to low fluid intake. "
                            "Hydration is guideline advice (NHLBI expert panel, Yawn et al., JAMA 2014) but has no "
                            "trial of a hydration programme."},
    "cold_season": {"crises": 0.25, "evidence": "low",
                    "source": "Assumption: outreach (warm clothing, fluids, early review) prevents ~25 % of the "
                              "excess Harmattan crises in people reached. Excess estimated from the registry's own "
                              "seasonality."},
    "adherence": {"crises": 0.40, "evidence": "moderate",
                  "source": "Assumption anchored on hydroxyurea efficacy (MSH, REACH): restoring missed doses "
                            "recovers ~40 % of the risk the model attributes to missed hydroxyurea."},
    "ed_analgesia": {"crises": 0.0, "admissions": 0.10, "los_days": 0.5, "evidence": "low",
                     "source": "NHLBI expert panel (Yawn et al., JAMA 2014): analgesia within 60 min of arrival. "
                               "Effect on admissions (-10 %) and length of stay (-0.5 day) is an assumption."},
}
# Programme cost per person reached per year, GHS (illustrative placeholders; editable on the client)
PROGRAMME_COST = {"hydroxyurea": 2400.0, "hydration": 60.0, "cold_season": 120.0, "adherence": 180.0,
                  "ed_analgesia": 40.0}


def research_effects() -> dict:
    """Optional overrides from sim_params.json: effect_sizes_voc.hydroxyurea.rate_ratio (effect = 1 - RR), or
    {"interventions": {key: {"effect": x, "source": "..."}}}."""
    params = research_params()
    out: dict = {}
    try:
        hu = params["effect_sizes_voc"]["hydroxyurea"]["rate_ratio"]
        rr = float(hu["value"])
        if 0 < rr < 1:
            out["hydroxyurea"] = {"crises": round(1 - rr, 3),
                                  "source": f"Rate ratio {rr:g}: {hu.get('source', '')} (docs/research/sim_params.json)"
                                            "; Tshilolo et al., NEJM 2019 (REACH, sub-Saharan Africa: VOC 98.3 -> "
                                            "44.6 per 100 patient-years)"}
    except (KeyError, TypeError, ValueError):
        pass
    raw = params.get("interventions")
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in EFFECTS and isinstance(v, dict) and isinstance(v.get("effect"), (int, float)):
                out[k] = {"crises": float(v["effect"]), "source": str(v.get("source") or "sim_params.json")}
    return out


def research_highlights() -> list[dict]:
    """Context figures from docs/research/sim_params.json for the Data & methods page (label, value, source)."""
    g = research_params().get("ghana_policy")
    if not isinstance(g, dict):
        return []
    out = []

    def add(label: str, item: Any, fmt=lambda v: str(v)) -> None:
        if isinstance(item, dict) and item.get("value") is not None:
            out.append({"label": label, "value": fmt(item["value"]), "source": str(item.get("source", "")),
                        "confidence": item.get("confidence")})
    births = g.get("scd_births_per_year", {})
    if isinstance(births, dict):
        add("Babies born with SCD each year (official estimate)", births.get("official_estimate"),
            lambda v: "–".join(f"{x:,}" for x in v) if isinstance(v, list) else f"{v:,}")
        add("Babies born with SCD each year (model estimate)", births.get("model_estimate"), lambda v: f"{v:,}")
    add("Newborn screening coverage", g.get("newborn_screening_coverage"), lambda v: f"{v * 100:.1f} %")
    hu = g.get("hydroxyurea")
    if isinstance(hu, dict):
        add("Share of HbSS patients on hydroxyurea (national)", hu.get("coverage_fraction_HbSS_on_hu"),
            lambda v: f"{v * 100:.0f} %")
    nh = g.get("nhis_active_coverage")
    if isinstance(nh, dict) and nh.get("2024") is not None:
        out.append({"label": "NHIS active membership (2024)", "value": f"{nh['2024'] * 100:.1f} %",
                    "source": str(nh.get("source", "")), "confidence": nh.get("confidence")})
    return out


def interventions(snap: Snapshot, cost_bed_day: float = DEFAULT_COST_BED_DAY, ed_visit: float = DEFAULT_ED_VISIT,
                  hu_target: float = 0.6) -> dict:
    t = snap.today
    n = len(snap.patients)
    if 0 < n < MIN_GROUP or n == 0:
        return {"baseline": None, "scenarios": [], "suppressed": n > 0}
    effects = {k: {**v, **research_effects().get(k, {})} for k, v in EFFECTS.items()}
    cur = _period(snap.crises, t - timedelta(days=365), t)
    rates = _rates(snap)
    # yearly crises: registry events; fall back to recorded crises_12m when events are missing
    total_crises = cur.crises or sum(rates.values())
    admit = cur.admissions / cur.crises if cur.crises >= 10 else DEFAULT_ADMIT_RATE
    total_adm = cur.admissions if cur.crises >= 10 else total_crises * admit
    los = cur.avg_los or DEFAULT_LOS
    hu_n = sum(p.on_hu for p in snap.patients)
    cov0 = hu_n / n
    no_hu_crises = sum(rates[p.key] for p in snap.patients if not p.on_hu)
    hu_crises = sum(rates[p.key] for p in snap.patients if p.on_hu)
    rate_scale = total_crises / (sum(rates.values()) or 1)       # align per-patient rates to the event total
    no_hu_crises *= rate_scale
    hu_crises *= rate_scale
    share = risk_shares(snap)
    season = seasonality(snap)["index"]
    harm = sum(season[m] for m in (12, 1, 2)) / 12                   # share of yearly crises in Dec-Feb
    harm_excess = sum(max(0.0, season[m] - 1) for m in (12, 1, 2)) / 12   # share that is seasonal excess

    baseline = {"patients": n, "crises_per_year": round(total_crises, 1), "admissions_per_year": round(total_adm, 1),
                "admission_rate": round(admit, 3), "avg_los": round(los, 1), "hu_coverage": round(cov0, 3),
                "cost_per_bed_day_ghs": cost_bed_day, "ed_visit_cost_ghs": ed_visit,
                "crises_no_hu": round(no_hu_crises, 1), "crises_on_hu": round(hu_crises, 1),
                "patients_no_hu": n - hu_n, "patients_on_hu": hu_n}

    def scen(key: str, label: str, description: str, target_crises: float, target_admissions: float,
             target_patients: int, slider: dict, extra: list[dict]) -> dict:
        e = effects[key]
        frac = _fraction(key, slider["default"], cov0)
        res = _estimate(target_crises, target_admissions, target_patients, frac, e.get("crises", 0),
                        e.get("admissions", 0), e.get("los_days", 0), admit, los, cost_bed_day, ed_visit,
                        PROGRAMME_COST[key])
        assumptions = extra + [
            {"label": "Effect size", "value": _effect_text(e), "source": e["source"]},
            {"label": "Evidence", "value": e["evidence"], "source": ""},
            {"label": "Programme cost per person reached / year", "value": f"GHS {PROGRAMME_COST[key]:,.0f}",
             "source": "Illustrative placeholder"},
        ]
        return {"key": key, "label": label, "description": description, **res, "assumptions": assumptions,
                "evidence": e["evidence"],
                "model": {"target_crises": round(target_crises, 2), "target_admissions": round(target_admissions, 2),
                          "target_patients": target_patients, "effect_crises": e.get("crises", 0),
                          "effect_admissions": e.get("admissions", 0), "effect_los_days": e.get("los_days", 0),
                          "programme_cost_per_person_ghs": PROGRAMME_COST[key], "baseline_coverage": round(cov0, 3)},
                "slider": slider}

    hyd = share.get("low_hydration", 0.0)
    cold = share.get("cold", 0.0)
    miss = share.get("missed_hu", 0.0)
    scenarios = [
        scen("hydroxyurea", f"Raise hydroxyurea coverage to {hu_target * 100:.0f} %",
             "Offer hydroxyurea to more eligible patients (WHO Essential Medicine; safe in malaria-endemic Africa).",
             no_hu_crises, no_hu_crises * admit, n - hu_n,
             {"param": "coverage", "label": "Target coverage", "min": round(cov0, 3), "max": 0.9,
              "default": max(round(cov0, 3), hu_target), "current": round(cov0, 3)},
             [{"label": "Current coverage", "value": f"{cov0 * 100:.0f} %", "source": "Registry"},
              {"label": "Crises a year in patients not on hydroxyurea", "value": f"{no_hu_crises:.0f}",
               "source": "Registry, last 12 months"}]),
        scen("hydration", "Hydration programme",
             "Water bottles, reminders and school/workplace access to drinking water for people with SCD.",
             total_crises * hyd, total_crises * hyd * admit, n,
             {"param": "reach", "label": "Patients reached", "min": 0, "max": 1, "default": 0.5},
             [{"label": "Share of modelled risk from low fluid intake", "value": f"{hyd * 100:.1f} %",
               "source": "Latest assessments (risk drivers)"}]),
        scen("cold_season", "Cold-season outreach (Harmattan)",
             "December–February: warm clothing, fluid and early-review messages, community health worker visits.",
             total_crises * max(harm_excess, cold * harm), total_crises * max(harm_excess, cold * harm) * admit, n,
             {"param": "reach", "label": "Patients reached", "min": 0, "max": 1, "default": 0.6},
             [{"label": "Share of yearly crises in Dec–Feb", "value": f"{harm * 100:.0f} %",
               "source": "Registry seasonality (shrunk to a Harmattan prior)"},
              {"label": "Seasonal excess targeted", "value": f"{max(harm_excess, cold * harm) * 100:.1f} % of crises",
               "source": "Registry seasonality / cold-exposure share"}]),
        scen("adherence", "Hydroxyurea adherence support",
             "SMS reminders, pharmacy refills and peer support for people already prescribed hydroxyurea.",
             total_crises * miss, total_crises * miss * admit, hu_n,
             {"param": "reach", "label": "Patients on hydroxyurea reached", "min": 0, "max": 1, "default": 0.7},
             [{"label": "Share of modelled risk from missed hydroxyurea", "value": f"{miss * 100:.1f} %",
               "source": "Latest assessments (risk drivers)"}]),
        scen("ed_analgesia", "Faster emergency analgesia",
             "Triage protocol: first analgesic dose within 60 minutes of arrival; individual pain plans on file.",
             0.0, total_adm, n,
             {"param": "reach", "label": "Facilities adopting the protocol (share of patients)", "min": 0, "max": 1,
              "default": 0.5},
             [{"label": "Admissions a year", "value": f"{total_adm:.0f}", "source": "Registry, last 12 months"}]),
    ]
    return {"baseline": baseline, "scenarios": scenarios, "suppressed": False,
            "formula": "fraction = reach (or (target - current) / (1 - current) for coverage); "
                       "crises_avoided = target_crises x fraction x effect_crises; "
                       "admissions_avoided = crises_avoided x admission_rate + "
                       "target_admissions x fraction x effect_admissions; "
                       "bed_days_saved = admissions_avoided x avg_los + "
                       "(target_admissions x fraction - admissions_avoided) x effect_los_days; "
                       "cost_saved = bed_days_saved x cost_per_bed_day + "
                       "(crises_avoided - admissions_avoided) x ed_visit_cost; "
                       "programme_cost = target_patients x fraction x cost_per_person"}


def _fraction(key: str, value: float, cov0: float) -> float:
    if key == "hydroxyurea":
        return max(0.0, (value - cov0) / (1 - cov0)) if cov0 < 1 else 0.0
    return max(0.0, min(1.0, value))


def _effect_text(e: dict) -> str:
    parts = []
    if e.get("crises"):
        parts.append(f"-{e['crises'] * 100:.0f} % crises")
    if e.get("admissions"):
        parts.append(f"-{e['admissions'] * 100:.0f} % admissions")
    if e.get("los_days"):
        parts.append(f"-{e['los_days']:g} day length of stay")
    return ", ".join(parts)


def _estimate(target_crises: float, target_adm: float, target_patients: int, frac: float, eff_c: float,
              eff_a: float, eff_los: float, admit: float, los: float, cost_bed_day: float, ed_visit: float,
              cost_person: float) -> dict:
    crises_avoided = target_crises * frac * eff_c
    adm_avoided = crises_avoided * admit + target_adm * frac * eff_a
    bed_days = adm_avoided * los + max(0.0, target_adm * frac - adm_avoided) * eff_los
    saved = bed_days * cost_bed_day + max(0.0, crises_avoided - adm_avoided) * ed_visit
    prog = target_patients * frac * cost_person
    return {"crises_avoided": round(crises_avoided, 1), "admissions_avoided": round(adm_avoided, 1),
            "bed_days_saved": round(bed_days, 1), "cost_saved_ghs": round(saved),
            "programme_cost_ghs": round(prog), "net_saving_ghs": round(saved - prog),
            "people_reached": round(target_patients * frac)}


# ---------------------------------------------------------------- CSV
CSV_COLUMNS = ["region", "population", "patients", "per_100k", "crises_12m", "crises_per_100k", "admissions_12m",
               "admissions_per_100k", "bed_days_12m", "avg_los", "hu_coverage", "avg_risk", "high_risk_now",
               "est_cost_ghs_12m", "suppressed"]


def regions_csv(rows: list[dict], ov: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for r in rows:
        w.writerow(["" if r.get(c) is None else r.get(c) for c in CSV_COLUMNS])
    w.writerow(["Ghana (all regions)", sum(CENSUS_2021.values()), ov.get("patients"), "", ov.get("crises_12m"), "",
                ov.get("admissions_12m"), "", ov.get("bed_days_12m"), ov.get("avg_los"), ov.get("hu_coverage"),
                ov.get("avg_risk_now"), ov.get("high_risk_now"), ov.get("est_cost_ghs_12m"), ov.get("suppressed")])
    return buf.getvalue()
