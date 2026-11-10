"""Features v2: one feature vector for (patient, as-of date) from every source we hold.

Sources: daily check-ins, IoT device readings (aggregated per day and compared with the patient's own 14-day
baseline), EMR labs (latest vs baseline, trend), imaging findings, crisis history and the patient profile.

The same pure function `build(records, as_of)` runs on rows loaded from the database (`load()`) and on rows emitted
by the simulator (`app.simulator`), so there is no train/serve skew. Rows can be ORM objects or plain dicts with the
DB column names. Missing data never crashes: the feature is set to its normal value and a `*_missing` indicator says
so (the model learns what missingness means; explanations skip the indicators).
"""
from __future__ import annotations

import bisect
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any, Iterable, Optional

import numpy as np

# ---------------------------------------------------------------------------------------------------------------
# Feature catalogue: key, label, description, normal value (used to explain impact), group, explainable
# group: check-in | device | lab | imaging | history
FEATURES: list[tuple[str, str, str, float, str, bool]] = [
    # check-ins (self-report)
    ("pain", "Pain today", "Pain score 0-10 on the latest check-in (last 2 days)", 0, "check-in", True),
    ("pain_trend", "Pain rising", "Latest pain minus the average of the 3 check-ins before", 0, "check-in", True),
    ("low_hydration", "Low fluid intake", "Litres below 2.5 L a day (3-day average, self-reported)", 0, "check-in", True),
    ("short_sleep", "Short sleep", "Hours below 7 a night (3-day average, self-reported)", 0, "check-in", True),
    ("stress", "Stress", "Stress 0-10 (3-day average)", 2, "check-in", True),
    ("cold", "Cold exposure", "Cold or wind exposure in the last 3 days", 0, "check-in", True),
    ("infection", "Infection symptoms", "Infection symptoms in the last 3 days", 0, "check-in", True),
    ("menstruating", "Menstruation", "Menstruating on the latest check-in", 0, "check-in", True),
    ("alcohol", "Alcohol", "Alcohol in the last 3 days", 0, "check-in", True),
    ("exertion", "Strenuous activity", "Strenuous activity in the last 3 days", 0, "check-in", True),
    ("missed_hu", "Missed hydroxyurea", "Share of the last 7 days hydroxyurea was missed (if prescribed)", 0,
     "check-in", True),
    ("checkin_gap", "Days since check-in", "Days since the last check-in (0-7)", 0, "check-in", False),
    # check-in or device
    ("fever", "Raised temperature", "Degrees above 37.5 °C (99.5 °F), check-in or thermometer, last 2 days", 0, "device", True),
    ("low_spo2", "Low oxygen", "SpO2 points below 95 % (pulse oximeter day mean or check-in)", 0, "device", True),
    # devices vs the patient's own 14-day baseline (days -16..-3) using the last 2 days
    ("hr_rise", "Resting heart rate up", "Wearable heart rate, bpm above own 14-day baseline", 0, "device", True),
    ("hrv_drop", "Heart-rate variability down", "Wearable HRV (RMSSD), % below own baseline", 0, "device", True),
    ("spo2_drop", "Oxygen below own baseline", "Pulse oximeter SpO2, points below own baseline", 0, "device", True),
    ("spo2_night_low", "Night-time oxygen dips", "Lowest SpO2 below 90 % (points, last 2 days)", 0, "device", True),
    ("skin_temp_rise", "Skin temperature up", "Wearable skin temperature above own baseline, in °C (1 °C = 1.8 °F)", 0, "device", True),
    ("steps_drop", "Less active", "Steps, % below own baseline (last 2 complete days)", 0, "device", True),
    ("sleep_loss", "Less sleep (wearable)", "Wearable sleep, hours below own baseline", 0, "device", True),
    ("fluid_drop", "Drinking less (smart bottle)", "Smart bottle intake, litres below own baseline (last 2 complete "
     "days)", 0, "device", True),
    ("resp_rise", "Breathing rate up", "Wearable respiratory rate, breaths/min above own baseline", 0, "device", True),
    ("wearable_missing", "No wearable data", "No wearable data in the last 2 days", 0, "device", False),
    ("oximeter_missing", "No oximeter data", "No pulse oximeter data in the last 2 days", 0, "device", False),
    ("bottle_missing", "No smart bottle data", "No smart bottle data in the last 2 days", 0, "device", False),
    ("thermometer_missing", "No thermometer data", "No thermometer reading in the last 2 days", 0, "device", False),
    # labs (EMR, or values typed on a check-in)
    ("hb_drop", "Hb below baseline", "g/dL below the patient's baseline haemoglobin (latest within 90 days)", 0,
     "lab", True),
    ("high_wbc", "High white cells", "WBC above 11 x10⁹/L (latest within 90 days)", 0, "lab", True),
    ("wbc_rise", "White cells rising", "Latest WBC minus the median of earlier results (180 days)", 0, "lab", True),
    ("high_retic", "High reticulocytes", "Reticulocytes above 12 %", 0, "lab", True),
    ("high_ldh", "High LDH", "LDH above 500 U/L, per 100", 0, "lab", True),
    ("high_crp", "Raised CRP", "CRP above 10 mg/L in the last 14 days, per 10", 0, "lab", True),
    ("labs_missing", "No recent labs", "No haemoglobin result in the last 90 days", 0, "lab", False),
    # imaging
    ("prior_acs", "Previous acute chest syndrome", "Chest imaging has shown an ACS infiltrate", 0, "imaging", True),
    ("avn", "Avascular necrosis", "Imaging has shown avascular necrosis (hip or shoulder)", 0, "imaging", True),
    ("cerebral", "Silent infarct or stroke", "Brain imaging has shown a silent infarct or stroke", 0, "imaging", True),
    ("tcd_risk", "Raised TCD velocity", "Transcranial Doppler: 1 conditional (170-199 cm/s), 2 abnormal (≥200)", 0,
     "imaging", True),
    # history and profile
    ("prior_crises", "Crises in last 12 months", "Number of VOCs in the last 12 months (max 12)", 0, "history", True),
    ("recent_crisis", "Crisis in last 30 days", "A VOC ended in the last 30 days (re-admission risk)", 0,
     "history", True),
    ("severe_genotype", "Severe genotype", "HbSS or HbSβ0", 0, "history", True),
    ("low_hbf", "Low foetal haemoglobin", "How far HbF is below 10 % (0-1; unknown counts as 0.5)", 0, "history", True),
    ("on_hu", "On hydroxyurea", "Prescribed hydroxyurea", 0, "history", True),
    ("child", "Child", "Younger than 18 years", 0, "history", False),
    ("harmattan", "Harmattan season", "December to February (cold, dry, dusty winds)", 0, "history", True),
]
# Known direction of effect (prior knowledge, enforced in training so a risk factor is never shown as protective):
# +1 can only raise risk, -1 can only lower it, 0 learned freely (missing flags, age, TCD, days since check-in).
# on_hu is -1 from the MSH randomised trial even though, observationally, sicker patients get hydroxyurea.
DIRECTION = {k: 1 for k, *_ in FEATURES}
DIRECTION.update({"on_hu": -1, "child": 0, "tcd_risk": 0, "checkin_gap": 0, "wearable_missing": 0,
                  "oximeter_missing": 0, "bottle_missing": 0, "thermometer_missing": 0, "labs_missing": 0})
KEYS = [f[0] for f in FEATURES]
INDEX = {k: i for i, k in enumerate(KEYS)}
LABELS = {f[0]: f[1] for f in FEATURES}
NORMAL = np.array([f[3] for f in FEATURES], dtype=float)
GROUP = {f[0]: f[4] for f in FEATURES}
EXPLAIN = {f[0] for f in FEATURES if f[5]}

# device metric -> the device kind that measures it, and how a day is summarised
METRIC_KIND = {"heart_rate": "wearable", "hrv_rmssd": "wearable", "skin_temp_c": "wearable", "steps": "wearable",
               "sleep_minutes": "wearable", "resp_rate": "wearable", "spo2": "pulse_oximeter",
               "fluid_ml": "smart_bottle", "body_temp_c": "thermometer"}
SUM_METRICS = {"steps", "sleep_minutes", "fluid_ml"}     # pushed as daily totals or increments -> summed per day
# all-day averages only count when the readings cover most of the day (a morning-only "today" is mostly night-time:
# lower heart rate, warmer skin, lower SpO2); same rule in training and in live use
COVERAGE_METRICS = {"heart_rate", "skin_temp_c", "spo2"}
MIN_COVERAGE_H = 16.0
LOOKBACK_DAYS = 400                                     # how far back the loader reads (12-month crisis history)
READING_DAYS = 21                                       # device history needed: 2 recent days + 14-day baseline


def get(row: Any, key: str, default=None):
    if row is None:
        return default
    v = row.get(key, default) if isinstance(row, dict) else getattr(row, key, default)
    return default if v is None else v


def _day(v) -> date:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def daily_aggregates(readings: Iterable[Any]) -> dict[date, dict[str, dict]]:
    """Raw readings -> {date: {metric: {mean, min, max, n, sum}}} (UTC days; Ghana is UTC+0)."""
    acc: dict[tuple[date, str], list[float]] = defaultdict(list)
    hours: dict[tuple[date, str], list[float]] = defaultdict(list)
    for r in readings:
        ts = get(r, "ts")
        key = (_day(ts), get(r, "metric"))
        acc[key].append(float(get(r, "value")))
        if isinstance(ts, datetime):
            hours[key].append(ts.hour + ts.minute / 60)
    out: dict[date, dict[str, dict]] = defaultdict(dict)
    for (d, m), vals in acc.items():
        h = hours.get((d, m)) or [0.0, 24.0]
        out[d][m] = {"mean": sum(vals) / len(vals), "min": min(vals), "max": max(vals), "n": len(vals),
                     "sum": sum(vals), "span_h": max(h) - min(h)}
    return dict(out)


def day_value(agg: dict, metric: str) -> float:
    a = agg[metric]
    if metric in SUM_METRICS:
        return a["sum"]
    if metric == "body_temp_c":
        return a["max"]
    return a["mean"]


@dataclass
class Records:
    """Everything known about one patient, indexed for fast as-of lookups."""
    patient: Any
    checkins: dict[date, Any] = field(default_factory=dict)
    vitals: dict[date, dict[str, dict]] = field(default_factory=dict)
    labs: dict[str, list[tuple[date, float]]] = field(default_factory=dict)
    imaging: list[tuple[date, set, Optional[float]]] = field(default_factory=list)
    crises: list[tuple[date, float]] = field(default_factory=list)     # (date, duration days)
    raw_recent: list[Any] = field(default_factory=list)                # raw readings, last ~48 h (red flags)
    _ci_dates: list[date] = field(default_factory=list)
    _crisis_dates: list[date] = field(default_factory=list)

    @classmethod
    def from_rows(cls, patient: Any, checkins: Iterable[Any] = (), vitals: Optional[dict] = None,
                  labs: Iterable[Any] = (), imaging: Iterable[Any] = (), crises: Iterable[Any] = (),
                  readings: Iterable[Any] = (), raw_recent: Iterable[Any] = ()) -> "Records":
        """`vitals` = daily aggregates (simulator); otherwise raw `readings` are aggregated here."""
        rec = cls(patient=patient)
        for c in checkins:
            rec.checkins[_day(get(c, "date"))] = c
        rec.vitals = vitals if vitals is not None else daily_aggregates(readings)
        by_code: dict[str, list[tuple[date, float]]] = defaultdict(list)
        for lab in labs:
            by_code[get(lab, "code")].append((_day(get(lab, "taken_at")), float(get(lab, "value"))))
        # values typed on check-ins count as labs too
        for d, c in rec.checkins.items():
            for attr, code in (("hb", "hb"), ("wbc", "wbc"), ("retic_percent", "retic"), ("ldh", "ldh")):
                v = get(c, attr)
                if v is not None:
                    by_code[code].append((d, float(v)))
        rec.labs = {k: sorted(v) for k, v in by_code.items()}
        rec.imaging = sorted(((_day(get(i, "study_date")),
                               {f.get("code") for f in (get(i, "findings") or []) if isinstance(f, dict)},
                               get(i, "tcd_velocity")) for i in imaging), key=lambda t: t[0])
        rec.crises = sorted((_day(get(c, "date")), float(get(c, "los_days") or 0)) for c in crises)
        rec.raw_recent = list(raw_recent)
        rec._ci_dates = sorted(rec.checkins)
        rec._crisis_dates = [c[0] for c in rec.crises]
        return rec

    # --- helpers ---
    def checkins_before(self, as_of: date, n: int, within: int) -> list[Any]:
        """Up to n check-ins on or before as_of (newest first), no older than `within` days."""
        i = bisect.bisect_right(self._ci_dates, as_of)
        out = []
        while i > 0 and len(out) < n:
            i -= 1
            d = self._ci_dates[i]
            if (as_of - d).days > within:
                break
            out.append(self.checkins[d])
        return out

    def lab(self, code: str, as_of: date, within: int) -> tuple[Optional[float], list[float]]:
        """Latest value on or before as_of within `within` days, and the earlier values (180 days)."""
        rows = self.labs.get(code)
        if not rows:
            return None, []
        i = bisect.bisect_right(rows, (as_of, float("inf")))
        if i == 0 or (as_of - rows[i - 1][0]).days > within:
            return None, []
        earlier = [v for d, v in rows[max(0, i - 12):i - 1] if (as_of - d).days <= 180]
        return rows[i - 1][1], earlier


def age_years(dob: Any, as_of: date) -> Optional[float]:
    if dob is None:
        return None
    dob = _day(dob)
    return (as_of - dob).days / 365.25


@dataclass
class FeatureSet:
    values: dict[str, float]
    info: dict[str, Any]        # raw numbers for readable explanations

    def vector(self) -> np.ndarray:
        return np.array([self.values[k] for k in KEYS], dtype=float)


def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def build(rec: Records, as_of: date) -> FeatureSet:
    """Feature vector for one patient as of the end of `as_of` (data on or before that day only)."""
    p = rec.patient
    v = {k: float(n) for k, n in zip(KEYS, NORMAL)}
    info: dict[str, Any] = {"as_of": as_of}

    # ---- check-ins ----
    cis = rec.checkins_before(as_of, 7, within=7)
    recent = [c for c in cis if (as_of - _day(get(c, "date"))).days <= 2]
    if cis:
        v["checkin_gap"] = float(min(7, (as_of - _day(get(cis[0], "date"))).days))
    else:
        v["checkin_gap"] = 7.0
    if recent:
        t = recent[0]
        last3 = cis[:3]
        prev3 = cis[1:4]
        pain = float(get(t, "pain", 0))
        v["pain"] = pain
        if prev3:
            v["pain_trend"] = max(-5.0, min(8.0, pain - _mean([float(get(c, "pain", 0)) for c in prev3])))
        hyd = _mean([float(get(c, "hydration_litres", 2.5)) for c in last3])
        slp = _mean([float(get(c, "sleep_hours", 7)) for c in last3])
        v["low_hydration"] = max(0.0, 2.5 - hyd)
        v["short_sleep"] = max(0.0, 7 - slp)
        v["stress"] = _mean([float(get(c, "stress", 2)) for c in last3])
        v["cold"] = float(any(get(c, "cold_exposure", False) for c in last3))
        v["infection"] = float(any(get(c, "infection_symptoms", False) for c in last3))
        v["menstruating"] = float(bool(get(t, "menstruating", False)))
        v["alcohol"] = float(any(get(c, "alcohol", False) for c in last3))
        v["exertion"] = float(any(get(c, "strenuous_activity", False) for c in last3))
        info.update(hydration=hyd, sleep=slp, temp_checkin=float(get(t, "temperature_c", 36.8)),
                    spo2_checkin=get(t, "spo2"))
    if bool(get(p, "on_hydroxyurea", False)):
        known = [get(c, "hydroxyurea_taken") for c in cis]
        known = [k for k in known if k is not None]
        if known:
            v["missed_hu"] = sum(1 for k in known if not k) / len(known)

    # ---- devices ----
    def series(metric: str, d0: int, d1: int) -> list[float]:
        out = []
        for k in range(d0, d1 + 1):
            agg = rec.vitals.get(as_of - timedelta(days=k))
            if agg and metric in agg:
                if metric in COVERAGE_METRICS and agg[metric].get("span_h", 24.0) < MIN_COVERAGE_H:
                    continue
                out.append(day_value(agg, metric))
        return out

    def vs_base(metric: str):
        # daily totals (steps, fluid) are incomplete until the day ends, so use the last 2 complete days for them
        # in training and in live use alike; averages (HR, SpO2, ...) can use today's readings so far
        now = series(metric, 1, 2) if metric in ("steps", "fluid_ml") else series(metric, 0, 1)
        base = series(metric, 3, 16)
        if not now or len(base) < 4:
            return None, None
        return _mean(now), median(base)

    kinds_seen = set()
    for k in (0, 1):
        agg = rec.vitals.get(as_of - timedelta(days=k))
        if agg:
            kinds_seen.update(METRIC_KIND.get(m) for m in agg)
    v["wearable_missing"] = float("wearable" not in kinds_seen)
    v["oximeter_missing"] = float("pulse_oximeter" not in kinds_seen)
    v["bottle_missing"] = float("smart_bottle" not in kinds_seen)
    v["thermometer_missing"] = float("thermometer" not in kinds_seen)

    now, base = vs_base("heart_rate")
    if now is not None:
        v["hr_rise"] = max(0.0, now - base)
        info["hr"] = (now, base)
    now, base = vs_base("hrv_rmssd")
    if now is not None and base > 0:
        v["hrv_drop"] = max(0.0, (base - now) / base * 100)
        info["hrv"] = (now, base)
    now, base = vs_base("spo2")
    if now is not None:
        v["spo2_drop"] = max(0.0, base - now)
        info["spo2"] = (now, base)
    mins = [rec.vitals[d]["spo2"]["min"] for d in (as_of, as_of - timedelta(days=1))
            if d in rec.vitals and "spo2" in rec.vitals[d]]
    if mins:
        v["spo2_night_low"] = max(0.0, 90 - min(mins))
        info["spo2_min"] = min(mins)
    now, base = vs_base("skin_temp_c")
    if now is not None:
        v["skin_temp_rise"] = max(0.0, now - base)
        info["skin"] = (now, base)
    now, base = vs_base("steps")
    if now is not None and base > 0:
        v["steps_drop"] = max(0.0, (base - now) / base * 100)
        info["steps"] = (now, base)
    now, base = vs_base("sleep_minutes")
    if now is not None:
        v["sleep_loss"] = max(0.0, (base - now) / 60)
        info["sleep_dev"] = (now / 60, base / 60)
    now, base = vs_base("fluid_ml")
    if now is not None:
        v["fluid_drop"] = max(0.0, (base - now) / 1000)
        info["fluid"] = (now / 1000, base / 1000)
    now, base = vs_base("resp_rate")
    if now is not None:
        v["resp_rise"] = max(0.0, now - base)
        info["resp"] = (now, base)

    # temperature: check-in (latest within 2 days) or thermometer max (last 2 days)
    temps = series("body_temp_c", 0, 1)
    if "temp_checkin" in info:
        temps.append(info["temp_checkin"])
    if temps:
        info["temp"] = max(temps)
        v["fever"] = max(0.0, max(temps) - 37.5)
    spo2_today = series("spo2", 0, 0)
    spo2_val = spo2_today[0] if spo2_today else info.get("spo2_checkin")
    if spo2_val is not None:
        v["low_spo2"] = max(0.0, 95 - float(spo2_val))
        info["spo2_now"] = float(spo2_val)

    # ---- labs ----
    hb_base = float(get(p, "hb_baseline", 0) or 0)
    hb, _ = rec.lab("hb", as_of, 90)
    if hb is None:
        v["labs_missing"] = 1.0
    else:
        v["hb_drop"] = max(0.0, hb_base - hb) if hb_base else 0.0
        info["hb"] = hb
    wbc, wbc_prev = rec.lab("wbc", as_of, 90)
    if wbc is not None:
        v["high_wbc"] = max(0.0, wbc - 11)
        if wbc_prev:
            v["wbc_rise"] = max(-5.0, min(10.0, wbc - median(wbc_prev)))
        info["wbc"] = wbc
    retic, _ = rec.lab("retic", as_of, 90)
    if retic is not None:
        v["high_retic"] = max(0.0, retic - 12)
        info["retic"] = retic
    ldh, _ = rec.lab("ldh", as_of, 90)
    if ldh is not None:
        v["high_ldh"] = max(0.0, ldh - 500) / 100
        info["ldh"] = ldh
    crp, _ = rec.lab("crp", as_of, 14)
    if crp is not None:
        v["high_crp"] = max(0.0, crp - 10) / 10
        info["crp"] = crp
    hbf_lab, _ = rec.lab("hbf", as_of, 730)
    hbf = hbf_lab if hbf_lab is not None else get(p, "hbf_percent")
    v["low_hbf"] = 0.5 if hbf is None else max(0.0, min(1.0, (10 - float(hbf)) / 10))
    info["hbf"] = hbf

    # ---- imaging ----
    for d, codes, tcd in rec.imaging:
        if d > as_of:
            break
        if "acs_infiltrate" in codes:
            v["prior_acs"] = 1.0
        if codes & {"avn_hip", "avn_shoulder"}:
            v["avn"] = 1.0
        if codes & {"silent_infarct", "stroke"}:
            v["cerebral"] = 1.0
        level = 2 if "tcd_abnormal" in codes else 1 if "tcd_conditional" in codes else 0
        if tcd is not None:
            level = 2 if tcd >= 200 else 1 if tcd >= 170 else 0
        if level or tcd is not None:           # the latest TCD counts (a normal repeat clears an older one)
            v["tcd_risk"] = float(level)

    # ---- history / profile ----
    i = bisect.bisect_left(rec._crisis_dates, as_of)        # crises strictly before as_of
    n12 = i - bisect.bisect_left(rec._crisis_dates, as_of - timedelta(days=365))
    if not rec.crises:
        n12 = int(get(p, "crises_12m", 0) or 0)            # manually entered count when no crisis rows exist
    v["prior_crises"] = float(min(12, n12))
    for d, dur in reversed(rec.crises[:i]):
        end = d + timedelta(days=max(1.0, dur))
        if (as_of - end).days <= 30:
            v["recent_crisis"] = 1.0
            info["last_crisis"] = d
        break
    gt = str(get(p, "genotype", ""))
    v["severe_genotype"] = float(gt in ("HbSS", "HbSβ0", "HbSB0", "HbSb0"))
    v["on_hu"] = float(bool(get(p, "on_hydroxyurea", False)))
    age = age_years(get(p, "date_of_birth"), as_of)
    v["child"] = float(age is not None and age < 18)
    v["harmattan"] = float(as_of.month in (12, 1, 2))
    return FeatureSet(v, info)


def matrix(rec: Records, dates: Iterable[date]) -> np.ndarray:
    return np.array([build(rec, d).vector() for d in dates], dtype=float)


# ---------------------------------------------------------------------------------------------------------------
# Database loader (async). Imports kept local so the simulator/training path does not need SQLAlchemy sessions.

async def load(s, patient, as_of: Optional[date] = None) -> Records:
    """Read everything the features need for one patient from the database."""
    from sqlalchemy import select

    from app.db import CheckIn, Crisis, ImagingStudy, LabResult, Reading

    as_of = as_of or date.today()
    since = as_of - timedelta(days=LOOKBACK_DAYS)
    pid = patient.id
    checkins = (await s.scalars(select(CheckIn).where(CheckIn.patient_id == pid,
                                                       CheckIn.date >= as_of - timedelta(days=14)))).all()
    r_since = datetime.combine(as_of - timedelta(days=READING_DAYS), datetime.min.time(), tzinfo=timezone.utc)
    readings = (await s.execute(select(Reading.ts, Reading.metric, Reading.value)
                                .where(Reading.patient_id == pid, Reading.ts >= r_since))).all()
    readings = [{"ts": r.ts, "metric": r.metric, "value": r.value} for r in readings]
    labs = (await s.scalars(select(LabResult).where(
        LabResult.patient_id == pid,
        LabResult.taken_at >= datetime.combine(as_of - timedelta(days=730), datetime.min.time(),
                                               tzinfo=timezone.utc)))).all()
    imaging = (await s.scalars(select(ImagingStudy).where(ImagingStudy.patient_id == pid))).all()
    crises = (await s.scalars(select(Crisis).where(Crisis.patient_id == pid, Crisis.date >= since))).all()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
    raw_recent = [r for r in readings if r["metric"] in ("spo2", "body_temp_c") and _aware(r["ts"]) >= cutoff]
    return Records.from_rows(patient, checkins=checkins, readings=readings, labs=labs, imaging=imaging,
                             crises=crises, raw_recent=raw_recent)


def _aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
