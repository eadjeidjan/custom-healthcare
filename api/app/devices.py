"""IoT devices: registration with a one-time API key, reading ingestion, daily vitals with baselines and alerts,
and a live sample feed for simulated devices (so the demo charts move).

Readings of `steps`, `fluid_ml` and `sleep_minutes` are increments: the daily value is their sum. All other metrics
are point measurements: the daily value is their mean."""
import asyncio
import hashlib
import logging
import math
import os
import random
import secrets
import statistics
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import bcrypt
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.units import temp
from app.db import Device, Patient, Reading, now, open_session

log = logging.getLogger("app.devices")

KINDS = ("wearable", "pulse_oximeter", "smart_bottle", "thermometer")
STATUSES = ("active", "offline", "retired")
OFFLINE_AFTER = timedelta(hours=6)
MAX_BATCH = 1000
MAX_AGE = timedelta(days=7)          # a gateway may upload a week of buffered readings
MAX_FUTURE = timedelta(minutes=5)    # clock skew


@dataclass(frozen=True)
class MetricInfo:
    label: str
    unit: str
    lo: float          # plausible range (outside = rejected as a sensor error)
    hi: float
    daily: str         # "mean" | "sum"
    digits: int = 0


METRICS: dict[str, MetricInfo] = {
    "heart_rate": MetricInfo("Heart rate", "bpm", 25, 250, "mean"),
    "hrv_rmssd": MetricInfo("HRV (RMSSD)", "ms", 1, 300, "mean"),
    "spo2": MetricInfo("SpO₂", "%", 50, 100, "mean", 1),
    "skin_temp_c": MetricInfo("Skin temperature", "°C", 20, 43, "mean", 1),
    "body_temp_c": MetricInfo("Body temperature", "°C", 32, 43.5, "mean", 1),
    "steps": MetricInfo("Steps", "steps", 0, 50000, "sum"),
    "sleep_minutes": MetricInfo("Sleep", "min", 0, 1440, "sum"),
    "fluid_ml": MetricInfo("Fluid intake", "mL", 0, 5000, "sum"),
    "resp_rate": MetricInfo("Respiratory rate", "/min", 4, 60, "mean", 1),
}
SUM_METRICS = {m for m, i in METRICS.items() if i.daily == "sum"}

# which metrics each kind of device measures (used by the sample feed and the web's device cards)
KIND_METRICS: dict[str, tuple[str, ...]] = {
    "wearable": ("heart_rate", "hrv_rmssd", "skin_temp_c", "steps", "sleep_minutes", "resp_rate"),
    "pulse_oximeter": ("spo2", "heart_rate"),
    "smart_bottle": ("fluid_ml",),
    "thermometer": ("body_temp_c",),
}
KIND_LABEL = {"wearable": "Wearable", "pulse_oximeter": "Pulse oximeter", "smart_bottle": "Smart bottle",
              "thermometer": "Thermometer"}


def utc(dt: Optional[datetime]) -> Optional[datetime]:
    """SQLite returns naive datetimes; treat them as UTC."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


# ---------- devices ----------

def effective_status(d: Device) -> str:
    if d.status == "retired":
        return "retired"
    seen = utc(d.last_seen)
    if seen is None or now() - seen > OFFLINE_AFTER:
        return "offline"
    return d.status


def device_out(d: Device) -> dict:
    return {"id": d.id, "patient_id": d.patient_id, "kind": d.kind, "label": d.label or KIND_LABEL.get(d.kind, d.kind),
            "vendor": d.vendor, "serial": d.serial, "status": effective_status(d), "simulated": d.simulated,
            "battery": d.battery, "last_seen": utc(d.last_seen), "created_at": utc(d.created_at),
            "metrics": list(KIND_METRICS.get(d.kind, ()))}


def _digest(key: str) -> bytes:
    """bcrypt takes at most 72 bytes; the key is longer, so bcrypt its SHA-256."""
    return hashlib.sha256(key.encode()).hexdigest().encode()


def hash_key(key: str) -> str:
    return bcrypt.hashpw(_digest(key), bcrypt.gensalt(rounds=10)).decode()


def new_key(device_id: str) -> str:
    """`sgd_<device id>_<secret>`: the id lets us find the device, the secret is checked against the bcrypt hash."""
    return f"sgd_{device_id}_{secrets.token_urlsafe(32)}"


async def register(s: AsyncSession, patient: Patient, kind: str, label: str = "", vendor: str = "",
                   serial: str = "", simulated: bool = False) -> tuple[Device, str]:
    d = Device(patient_id=patient.id, kind=kind, label=label.strip() or KIND_LABEL[kind],
               vendor=vendor.strip() or ("Sample (simulated)" if simulated else ""), serial=serial.strip(),
               status="active", simulated=simulated)
    s.add(d)
    await s.flush()
    key = new_key(d.id)
    d.token_hash = hash_key(key)
    await s.commit()
    return d, key


async def rotate_key(s: AsyncSession, d: Device) -> str:
    key = new_key(d.id)
    d.token_hash = hash_key(key)
    _key_cache.clear()
    await s.commit()
    return key


# sha256(key) -> (device id, token_hash at the time it was verified): skips bcrypt for a device pushing often
_key_cache: dict[str, tuple[str, str]] = {}


async def device_for_key(s: AsyncSession, key: str) -> Optional[Device]:
    key = (key or "").strip()
    parts = key.split("_", 2)
    if len(parts) != 3 or parts[0] != "sgd" or len(key) > 200:
        return None
    d = await s.get(Device, parts[1])
    if d is None or not d.token_hash:
        return None
    fp = _digest(key).decode()
    hit = _key_cache.get(fp)
    if hit and hit == (d.id, d.token_hash):
        return d
    try:
        ok = bcrypt.checkpw(_digest(key), d.token_hash.encode())
    except ValueError:
        ok = False
    if not ok:
        return None
    if len(_key_cache) > 5000:
        _key_cache.clear()
    _key_cache[fp] = (d.id, d.token_hash)
    return d


def check_reading(metric: str, value: float, ts: Optional[datetime], at: datetime) -> tuple[Optional[datetime], str]:
    """(timestamp, '') when plausible, else (None, reason)."""
    info = METRICS.get(metric)
    if info is None:
        return None, f"unknown metric '{metric}'"
    if value is None or not math.isfinite(value):
        return None, f"{metric}: value is not a number"
    if not info.lo <= value <= info.hi:
        return None, f"{metric}: {value:g} is outside the plausible range {info.lo:g}–{info.hi:g} {info.unit}"
    ts = utc(ts) or at
    if ts > at + MAX_FUTURE:
        return None, f"{metric}: timestamp {ts.isoformat()} is in the future"
    if ts < at - MAX_AGE:
        return None, f"{metric}: timestamp {ts.isoformat()} is older than 7 days"
    return ts, ""


async def ingest(s: AsyncSession, d: Device, readings: list[dict], battery: Optional[int] = None) -> dict:
    at = now()
    accepted, errors = 0, []
    for i, r in enumerate(readings):
        ts, why = check_reading(r["metric"], r["value"], r.get("ts"), at)
        if ts is None:
            errors.append(f"#{i}: {why}")
            continue
        s.add(Reading(device_id=d.id, patient_id=d.patient_id, ts=ts, metric=r["metric"], value=float(r["value"])))
        accepted += 1
    if accepted:
        d.last_seen = at
        if d.status == "offline":
            d.status = "active"
    if battery is not None:
        d.battery = max(0, min(100, int(battery)))
    await s.commit()
    return {"accepted": accepted, "rejected": len(errors), "errors": errors[:20]}


# ---------- vitals ----------

def _median(xs: list[float]) -> Optional[float]:
    return statistics.median(xs) if xs else None


def _day_value(metric: str, row: dict) -> float:
    return row["total"] if metric in SUM_METRICS else row["mean"]


def _resting(values: list[float]) -> Optional[float]:
    """Resting heart rate: mean of the lowest quarter of the readings."""
    if not values:
        return None
    xs = sorted(values)
    q = xs[:max(1, len(xs) // 4)]
    return sum(q) / len(q)


def _r(v: Optional[float], digits: int = 1) -> Optional[float]:
    return None if v is None else round(v, digits)


async def daily(s: AsyncSession, patient_id: str, since: date) -> dict[str, dict[date, dict]]:
    """{metric: {day: {mean, min, max, n, total}}} aggregated in the database."""
    start = datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc)
    day = func.date(Reading.ts)
    rows = (await s.execute(
        select(Reading.metric, day, func.avg(Reading.value), func.min(Reading.value), func.max(Reading.value),
               func.count(), func.sum(Reading.value))
        .where(Reading.patient_id == patient_id, Reading.ts >= start)
        .group_by(Reading.metric, day))).all()
    out: dict[str, dict[date, dict]] = {}
    for metric, d, mean, lo, hi, n, total in rows:
        if metric not in METRICS or d is None:
            continue
        d = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
        out.setdefault(metric, {})[d] = {"mean": float(mean), "min": float(lo), "max": float(hi), "n": int(n),
                                         "total": float(total)}
    return out


async def vitals(s: AsyncSession, patient_id: str, days: int = 14) -> dict:
    today = now().date()
    first_day = today - timedelta(days=days - 1)
    base_from = today - timedelta(days=14)               # baseline: the 14 full days before today
    agg = await daily(s, patient_id, min(first_day, base_from))

    # resting heart rate per day (needs the raw values)
    hr_since = datetime.combine(min(first_day, base_from), datetime.min.time(), tzinfo=timezone.utc)
    hr_rows = (await s.execute(select(Reading.ts, Reading.value).where(
        Reading.patient_id == patient_id, Reading.metric == "heart_rate", Reading.ts >= hr_since))).all()
    hr_by_day: dict[date, list[float]] = {}
    for ts, v in hr_rows:
        hr_by_day.setdefault(utc(ts).date(), []).append(v)
    resting = {d: _resting(vs) for d, vs in hr_by_day.items()}

    metrics: dict[str, list[dict]] = {}
    baselines: dict[str, float] = {}
    bands: dict[str, list[float]] = {}
    for metric, by_day in agg.items():
        info = METRICS[metric]
        series = []
        for d in sorted(by_day):
            if d < first_day:
                continue
            row = by_day[d]
            item = {"date": d.isoformat(), "mean": _r(row["mean"], 2), "min": _r(row["min"], 2),
                    "max": _r(row["max"], 2), "n": row["n"]}
            if metric in SUM_METRICS:
                # steps, sleep and fluids are increments: the day's value is their SUM (as in
                # app.features.daily_aggregates). `mean` carries the sum too, so any consumer that plots
                # `mean` (the portal) shows daily totals; min/max stay per reading.
                item["total"] = item["sum"] = item["mean"] = _r(row["total"], 0)
            item["value"] = item["mean"]          # the daily value to chart: sum or mean by metric
            if metric == "heart_rate" and resting.get(d) is not None:
                item["resting"] = _r(resting[d], 1)
            series.append(item)
        if series:
            metrics[metric] = series
        base_vals = [_day_value(metric, by_day[d]) for d in by_day if base_from <= d < today]
        if metric == "heart_rate":   # baseline of the resting rate, the number the alert compares against
            base_vals = [resting[d] for d in by_day if base_from <= d < today and resting.get(d) is not None]
        if len(base_vals) >= 3:
            baselines[metric] = round(_median(base_vals), info.digits + 1)
            qs = statistics.quantiles(base_vals, n=4) if len(base_vals) >= 4 else [min(base_vals), 0, max(base_vals)]
            bands[metric] = [round(qs[0], info.digits + 1), round(qs[-1], info.digits + 1)]

    latest: dict[str, dict] = {}
    last_ts = (await s.execute(select(Reading.metric, func.max(Reading.ts)).where(Reading.patient_id == patient_id)
                               .group_by(Reading.metric))).all()
    for metric, ts in last_ts:
        if metric not in METRICS:
            continue
        v = await s.scalar(select(Reading.value).where(Reading.patient_id == patient_id, Reading.metric == metric,
                                                       Reading.ts == ts).limit(1))
        latest[metric] = {"value": v, "ts": utc(ts)}

    alerts = await vitals_alerts(s, patient_id, baselines, agg)
    return {"metrics": metrics, "latest": latest, "baselines": baselines, "baseline_bands": bands, "alerts": alerts,
            "units": {m: i.unit for m, i in METRICS.items()}, "days": days}


async def vitals_alerts(s: AsyncSession, patient_id: str, baselines: dict[str, float],
                        agg: dict[str, dict[date, dict]]) -> list[dict]:
    """Simple device rules over the last 24 hours. Decision support: they prompt a check, they don't diagnose."""
    at = now()
    since = at - timedelta(hours=24)
    rows = (await s.execute(select(Reading.metric, Reading.ts, Reading.value).where(
        Reading.patient_id == patient_id, Reading.ts >= since,
        Reading.metric.in_(("spo2", "body_temp_c", "heart_rate"))).order_by(Reading.ts))).all()
    by: dict[str, list[tuple[datetime, float]]] = {}
    for m, ts, v in rows:
        by.setdefault(m, []).append((utc(ts), v))
    alerts: list[dict] = []

    # SpO2 below 92 % for 15 minutes or more (a reading counts until the next one, at most 60 min)
    spo2 = by.get("spo2", [])
    longest, low_min, run_start = 0.0, None, None
    for i, (ts, v) in enumerate(spo2):
        nxt = spo2[i + 1][0] if i + 1 < len(spo2) else min(at, ts + timedelta(minutes=1))
        if v < 92:
            run_start = run_start or ts
            low_min = v if low_min is None else min(low_min, v)
            end = min(nxt, ts + timedelta(minutes=60))
            longest = max(longest, (end - run_start).total_seconds() / 60)
            if nxt - ts > timedelta(minutes=60):
                run_start = None
        else:
            run_start = None
    if longest >= 15:
        alerts.append({"metric": "spo2", "severity": "severe", "value": low_min,
                       "message": f"SpO₂ below 92 % for about {round(longest)} min in the last 24 h (lowest "
                                  f"{low_min:g} %). Recheck now; persistent low oxygen needs emergency care."})

    temps = by.get("body_temp_c", [])
    hot = [v for _, v in temps if v >= 38.5]
    if hot:
        alerts.append({"metric": "body_temp_c", "severity": "severe", "value": max(hot),
                       "message": f"Temperature {temp(max(hot))} in the last 24 h (≥ {temp(38.5)}). Fever in sickle cell "
                                  f"disease needs urgent medical review."})

    hr = [v for _, v in by.get("heart_rate", [])]
    base = baselines.get("heart_rate")
    rest = _resting(hr) if len(hr) >= 12 else None   # resting rate over the last 24 h (includes a night)
    if base and rest and rest >= base * 1.2:
        alerts.append({"metric": "heart_rate", "severity": "moderate", "value": round(rest),
                       "message": f"Resting heart rate {rest:.0f} bpm is {100 * (rest / base - 1):.0f} % above the "
                                  f"14-day baseline ({base:.0f} bpm): possible infection, pain or dehydration."})

    yesterday = at.date() - timedelta(days=1)
    fluid = agg.get("fluid_ml", {}).get(yesterday)
    if fluid and fluid["total"] < 1500:
        alerts.append({"metric": "fluid_ml", "severity": "moderate", "value": round(fluid["total"]),
                       "message": f"Fluid intake yesterday was {fluid['total']:.0f} mL (below 1.5 L). "
                                  f"Dehydration is a crisis trigger."})

    hrv_base = baselines.get("hrv_rmssd")
    hrv_today = agg.get("hrv_rmssd", {}).get(at.date())
    if hrv_base and hrv_today and hrv_today["n"] >= 6 and hrv_today["mean"] <= hrv_base * 0.7:
        alerts.append({"metric": "hrv_rmssd", "severity": "moderate", "value": round(hrv_today["mean"]),
                       "message": f"Heart rate variability today ({hrv_today['mean']:.0f} ms) is "
                                  f"{100 * (1 - hrv_today['mean'] / hrv_base):.0f} % below baseline: a stress or "
                                  f"illness signal."})
    return alerts


async def raw_readings(s: AsyncSession, patient_id: str, metric: str, hours: int) -> list[dict]:
    since = now() - timedelta(hours=hours)
    rows = (await s.execute(select(Reading.ts, Reading.value).where(
        Reading.patient_id == patient_id, Reading.metric == metric, Reading.ts >= since)
        .order_by(Reading.ts).limit(20000))).all()
    return [{"ts": utc(ts), "value": v} for ts, v in rows]


# ---------- live sample feed ----------

def feed_enabled() -> bool:
    s = get_settings()
    v = getattr(s, "simulate_devices", None)
    if v is None and os.environ.get("SIMULATE_DEVICES"):
        v = os.environ["SIMULATE_DEVICES"].strip().lower() in ("1", "true", "yes", "on")
    if v is None:
        v = not s.is_production and s.uses_postgres   # default: on for the dev stack, off in production and tests
    return bool(v)


FEED_SECONDS = 60
# random walk: (noise sd, pull toward the recent level per minute, fallback level)
WALK = {"heart_rate": (1.8, 0.12, 78), "spo2": (0.35, 0.2, 96), "hrv_rmssd": (2.5, 0.15, 45),
        "skin_temp_c": (0.05, 0.15, 33.5), "body_temp_c": (0.08, 0.3, 36.8), "resp_rate": (0.5, 0.2, 16)}
EVERY_MIN = {"heart_rate": 1, "spo2": 1, "steps": 1, "hrv_rmssd": 5, "skin_temp_c": 5, "resp_rate": 5,
             "body_temp_c": 240}


async def _patient_state(s: AsyncSession, patient_id: str) -> dict[str, dict]:
    """Per metric: the last value and time; the patient's hour-of-day profile over the last 7 days (so nights stay
    lower than days, and night-only metrics such as sleep HRV stay at night); the recent trend (last 24 h mean minus
    the 7-day mean, so a deteriorating patient keeps deteriorating); and for sum metrics the daily total over the last
    3 full days."""
    at = now()
    out: dict[str, dict] = {}
    last = (await s.execute(select(Reading.metric, func.max(Reading.ts)).where(Reading.patient_id == patient_id)
                            .group_by(Reading.metric))).all()
    for metric, ts in last:
        v = await s.scalar(select(Reading.value).where(Reading.patient_id == patient_id, Reading.metric == metric,
                                                       Reading.ts == ts).limit(1))
        out[metric] = {"ts": utc(ts), "value": v}
    hour = func.extract("hour", Reading.ts)
    prof = (await s.execute(select(Reading.metric, hour, func.avg(Reading.value)).where(
        Reading.patient_id == patient_id, Reading.ts >= at - timedelta(days=7),
        Reading.metric.in_(tuple(WALK))).group_by(Reading.metric, hour))).all()
    for metric, h, avg in prof:
        out.setdefault(metric, {}).setdefault("profile", {})[int(h)] = float(avg)
    for since, key in ((at - timedelta(days=7), "mean7"), (at - timedelta(hours=24), "mean24")):
        rows = (await s.execute(select(Reading.metric, func.avg(Reading.value)).where(
            Reading.patient_id == patient_id, Reading.ts >= since).group_by(Reading.metric))).all()
        for metric, avg in rows:
            out.setdefault(metric, {})[key] = float(avg)
    for st in out.values():
        if "mean7" in st and "mean24" in st:
            st["trend"] = st["mean24"] - st["mean7"]
    midnight = datetime.combine(at.date(), datetime.min.time(), tzinfo=timezone.utc)
    totals = (await s.execute(select(Reading.metric, func.sum(Reading.value)).where(
        Reading.patient_id == patient_id, Reading.ts >= midnight - timedelta(days=3), Reading.ts < midnight,
        Reading.metric.in_(tuple(SUM_METRICS))).group_by(Reading.metric))).all()
    for metric, total in totals:
        out.setdefault(metric, {})["daily"] = float(total) / 3
    return out


def _activity(hour: int) -> float:
    """Share of the day's steps per waking minute, shaped by the hour (UTC = Ghana time)."""
    if hour < 6 or hour >= 22:
        return 0.05
    return 1.0 + 0.5 * math.sin((hour - 9) / 13 * math.pi)


def next_values(kind: str, state: dict[str, dict], at: datetime, rng: random.Random) -> list[tuple[str, float]]:
    out: list[tuple[str, float]] = []
    for metric in KIND_METRICS.get(kind, ()):
        st = state.get(metric, {})
        last_ts: Optional[datetime] = st.get("ts")
        mins = (at - last_ts).total_seconds() / 60 if last_ts else 1e9
        info = METRICS[metric]
        if metric in WALK:
            if mins < EVERY_MIN[metric] - 0.2:
                continue
            sd, pull, fallback = WALK[metric]
            prof: dict[int, float] = st.get("profile") or {}
            if prof and at.hour not in prof:
                if metric not in ("heart_rate", "spo2"):
                    continue                  # e.g. HRV and respiratory rate measured only during sleep
                target = sum(prof.values()) / len(prof)
            else:
                target = prof.get(at.hour, st.get("mean24", fallback))
            target += max(-15.0, min(15.0, st.get("trend", 0.0))) if prof else 0.0
            prev = st.get("value", target)
            steps = max(1.0, min(mins, 240) / max(1, EVERY_MIN[metric]))
            v = prev + (1 - (1 - pull) ** steps) * (target - prev) + rng.gauss(0, sd)
            if metric == "spo2":
                v = round(min(100.0, v))
            v = round(max(info.lo, min(info.hi, v)), info.digits if info.digits else 0)
            out.append((metric, v))
        elif metric == "steps":
            per_day = st.get("daily", 5000)
            v = max(0, round(rng.gauss(per_day / (16 * 60) * _activity(at.hour), 8)))
            if v:
                out.append((metric, v))
        elif metric == "fluid_ml":
            gap = rng.uniform(50, 110)
            if 6 <= at.hour < 23 and mins >= gap:
                per_day = st.get("daily", 2000)
                out.append((metric, round(max(50, rng.gauss(per_day / 11, 40)) / 10) * 10))
        elif metric == "sleep_minutes":
            if at.hour >= 7 and (last_ts is None or last_ts.date() < at.date()):
                per_day = st.get("daily", 420)
                out.append((metric, round(max(120, min(720, rng.gauss(per_day, 35))))))
    return out


async def feed_tick(rng: Optional[random.Random] = None) -> int:
    """One step of the sample feed: a new reading set for each simulated, active device of the featured patients."""
    rng = rng or random.Random()
    at = now()
    n = 0
    async with open_session() as s:
        devs = (await s.scalars(select(Device).join(Patient, Patient.id == Device.patient_id).where(
            Device.simulated.is_(True), Device.status != "retired", Patient.featured.is_(True)))).all()
        states: dict[str, dict] = {}
        for d in devs:
            if d.patient_id not in states:
                states[d.patient_id] = await _patient_state(s, d.patient_id)
            vals = next_values(d.kind, states[d.patient_id], at, rng)
            for metric, v in vals:
                s.add(Reading(device_id=d.id, patient_id=d.patient_id, ts=at, metric=metric, value=v))
                states[d.patient_id][metric] = {**states[d.patient_id].get(metric, {}), "ts": at, "value": v}
                n += 1
            d.last_seen = at
            d.status = "active"
            if d.battery is None:
                d.battery = rng.randint(60, 100)
            elif rng.random() < 1 / 40:
                d.battery = 100 if d.battery <= 10 else d.battery - 1
        await s.commit()
    return n


async def run_feed() -> None:
    log.info("Sample device feed on: a reading every %d s for simulated devices", FEED_SECONDS)
    await asyncio.sleep(5)
    while True:
        try:
            await feed_tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001  (e.g. the dev DB being reseeded)
            log.warning("Sample device feed: %s", e)
        await asyncio.sleep(FEED_SECONDS)


_feed: Optional[asyncio.Task] = None


def start_feed() -> Optional[asyncio.Task]:
    global _feed
    if _feed is None or _feed.done():
        _feed = asyncio.create_task(run_feed())
    return _feed


async def stop_feed() -> None:
    global _feed
    if _feed is not None:
        _feed.cancel()
        try:
            await _feed
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    _feed = None
