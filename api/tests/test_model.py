"""Simulator, features v2, training and device red flags (all synthetic, kept small and fast)."""
from datetime import date, datetime, timedelta, timezone

import numpy as np

from app import db, features as F, risk, simulator as S, train

START = date(2025, 1, 1)


def _sim(i=3, days=120, **kw):
    r = np.random.default_rng([99, i])
    spec = S.sample_spec(r, START, i, **kw)
    spec.devices = ("wearable", "pulse_oximeter", "smart_bottle", "thermometer")
    return S.simulate(spec, START, days, r)


def _columns(model) -> set:
    return {c.name for c in model.__table__.columns}


def test_simulator_emits_db_shaped_rows():
    s = _sim()
    assert set(s.patient_row()) <= _columns(db.Patient)
    for rows, model in ((s.checkins(), db.CheckIn), (s.readings(), db.Reading), (s.lab_rows, db.LabResult),
                        (s.imaging_rows, db.ImagingStudy), (s.crises(), db.Crisis)):
        for row in rows[:50]:
            assert set(row) <= _columns(model), model.__tablename__
    assert {r["metric"] for r in s.readings()} >= {"heart_rate", "spo2", "steps", "fluid_ml"}


def test_no_train_serve_skew_between_daily_aggregates_and_raw_readings():
    """Training uses the simulator's daily aggregates; the API aggregates raw readings. Same features."""
    s = _sim(days=60)
    kw = dict(labs=s.lab_rows, imaging=s.imaging_rows, crises=s.crises())
    a = F.Records.from_rows(s.patient_row(), s.checkins(), vitals=s.daily_vitals(), **kw)
    b = F.Records.from_rows(s.patient_row(), s.checkins(), readings=s.readings(), **kw)
    for d in s.dates[20::7]:
        va, vb = F.build(a, d).values, F.build(b, d).values
        for k in ("hr_rise", "hrv_drop", "spo2_drop", "steps_drop", "sleep_loss", "fluid_drop", "fever",
                  "wearable_missing", "oximeter_missing"):
            tol = {"hrv_drop": 3.0, "steps_drop": 1.0}.get(k, 0.6)
            assert abs(va[k] - vb[k]) <= tol, (k, d, va[k], vb[k])


def test_features_never_crash_on_missing_data():
    fs = F.build(F.Records.from_rows({"genotype": "HbSC", "hb_baseline": 10.5}), date.today())
    x = fs.vector()
    assert x.shape == (len(F.KEYS),) and np.isfinite(x).all()
    v = fs.values
    assert v["wearable_missing"] == v["labs_missing"] == 1 and v["checkin_gap"] == 7 and v["low_hbf"] == 0.5


def test_cohort_rates_follow_the_literature_and_crises_have_a_prodrome():
    sims = list(S.cohort(250, 365, seed=5))
    ss = [len(s.events) for s in sims if s.spec.genotype == "HbSS"]
    sc = [len(s.events) for s in sims if s.spec.genotype == "HbSC"]
    assert 0.4 < np.mean(ss) < 1.3 and np.mean(sc) < np.mean(ss)      # Platt 1991: SS 0.8, SC 0.4 per year
    pre, other = [], []
    for s in sims:
        days = {e["day"] - 1 for e in s.events}
        for t in range(20, 365):
            if s.a["wear_on"][t] and not s.a["active"][t]:
                (pre if t in days else other).append(s.a["hr"][t] - s.spec.hr0)
    assert np.mean(pre) > np.mean(other) + 1.0                          # resting HR drifts up the day before


def test_small_training_run_evaluates_honestly(tmp_path):
    b = train.run(patients=400, days=300, seed=3, full=False, path=tmp_path / "m.joblib", report=False)
    assert b["schema"] == risk.SCHEMA and b["keys"] == F.KEYS and b["cohort"]["source"] == "synthetic"
    assert b["auc"] > 0.6 and 0 < b["brier"] < 0.05
    assert [o["level"] for o in b["operating_points"]] == ["moderate", "high", "critical"]
    assert all(o["alerts_per_100_weeks"] >= 0 for o in b["operating_points"])
    assert b["calibration"] and all(0 <= c["predicted"] <= 1 and 0 <= c["observed"] <= 1 for c in b["calibration"])


def test_device_red_flags():
    now = datetime.now(timezone.utc)
    p = risk.Profile("HbSS", False, 8.0, 5.0, 1)

    def flags(readings):
        return risk.red_flags(F.Records.from_rows(p, raw_recent=readings), date.today(), now)

    assert flags([{"ts": now - timedelta(hours=3), "metric": "body_temp_c", "value": 38.7}])[0]["key"] == "fever"
    assert flags([{"ts": now - timedelta(hours=30), "metric": "body_temp_c", "value": 39.0}]) == []   # > 24 h ago
    sustained = [{"ts": now - timedelta(minutes=m), "metric": "spo2", "value": 90} for m in (40, 30, 20)]
    assert flags(sustained)[0]["key"] == "spo2"
    blip = [{"ts": now - timedelta(minutes=40), "metric": "spo2", "value": 89},
            {"ts": now - timedelta(minutes=35), "metric": "spo2", "value": 97}]
    assert flags(blip) == []                                             # a single low reading is not sustained


def test_explanations_keep_the_contract():
    days = [risk.Day(date=date.today() - timedelta(i), pain=6, hydration_litres=1.0, sleep_hours=5, stress=7,
                     cold_exposure=True) for i in range(5)]
    res = risk.assess(risk.Profile("HbSS", False, 8.0, 4.0, 4), days)
    assert res.factors and all(set(f) == {"key", "label", "value", "impact", "direction"} for f in res.factors)
    assert res.model_version.startswith("voc-")


async def test_model_card_and_seeded_records(client):
    c = (await client.get("/api/v1/model")).json()
    for k in ("auprc", "calibration", "operating_points", "comparison", "cohort", "feature_groups", "lead_time_days"):
        assert k in c
    assert c["cohort"]["source"] == "synthetic" and "synthetic" in c["data_note"].lower()
    assert {g["group"] for g in c["feature_groups"]} == {"check-in", "device", "lab", "imaging", "history"}
    from sqlalchemy import func, select
    async with db.open_session() as s:
        assert await s.scalar(select(func.count()).select_from(db.Device)) >= 48
        assert await s.scalar(select(func.count()).select_from(db.Reading)) > 10000
        assert await s.scalar(select(func.count()).select_from(db.ImagingStudy)) > 10
        kwame = await s.scalar(select(db.Patient).where(db.Patient.name == "Kwame Mensah"))
        assert kwame.region and kwame.facility and kwame.featured
        from app import care
        res = await care.score_patient(s, kwame)
        assert res.level == "critical" and {"fever", "chest", "spo2"} <= {f["key"] for f in res.red_flags}
