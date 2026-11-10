"""Policy dashboard: roles, privacy floor (groups < 5 suppressed), no identifiers in any response, CSV export."""
import json
from datetime import date, timedelta

import pytest
from sqlalchemy import delete, select

from app import analytics
from app.db import Assessment, Crisis, Patient, User, open_session
from app.security import hash_password

PW = "policy-test-pass-1"
ENDPOINTS = ["overview", "regions", "facilities", "trends?months=24", "forecast?weeks=8", "forecast?detail=true",
             "drivers", "drivers?detail=true", "interventions", "interventions?detail=true", "seasonality", "meta"]
TAG = "PolTest"


async def _login(client, email: str) -> dict:
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": PW})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="module")
async def setup(client):
    """Users for each role, plus registry patients: 8 in Upper East (shown), 3 in Oti (suppressed),
    6 at one facility and 2 at another. Removed afterwards so other test files see the usual demo data."""
    today = date.today()
    async with open_session() as s:
        anchor = await s.scalar(select(Patient).limit(1))
        users = [User(email=f"{role}-pt@sickleguard.local", name=f"{role} tester", role=role,
                      password_hash=hash_password(PW), patient_id=anchor.id if role == "patient" else None)
                 for role in ("policy", "clinician", "patient")]
        s.add_all(users)
        made = []
        for i, (region, fac) in enumerate([("Upper East", "Bolgatanga Regional Hospital")] * 6
                                          + [("Upper East", "Navrongo War Memorial Hospital")] * 2
                                          + [("Oti", "Dambai Health Centre")] * 3):
            p = Patient(mrn=f"PT-MRN-{9000 + i}", name=f"{TAG} Person{i} Zzyzx", sex="F" if i % 2 else "M",
                        genotype="HbSS", on_hydroxyurea=i % 3 == 0, hb_baseline=8.0, crises_12m=2,
                        date_of_birth=date(1990, 1, 1) + timedelta(days=i), region=region, district="", facility=fac,
                        phone="+233 20 000 0000", notes=f"secret note {i}", featured=False)
            s.add(p)
            await s.flush()
            made.append(p.id)
            for k in range(3):   # crises in the last 12 months and in the previous year
                s.add(Crisis(patient_id=p.id, date=today - timedelta(days=20 + 90 * k + i), severity="moderate",
                             hospitalised=k != 1, los_days=4.0 if k != 1 else None, facility=fac,
                             notes=f"private crisis note {i}"))
            s.add(Crisis(patient_id=p.id, date=today - timedelta(days=400 + i), hospitalised=True, los_days=5.0,
                         facility=fac, notes="old"))
            s.add(Assessment(patient_id=p.id, kind="checkin", for_date=today, score=40.0 + i, level="high",
                             probability=(40.0 + i) / 100,
                             factors=[{"key": "low_hydration", "label": "Low fluid intake", "value": "1.2 L",
                                       "impact": 12.0, "direction": "up"},
                                      {"key": "missed_hu", "label": "Missed hydroxyurea", "value": "3 of 7 days",
                                       "impact": 6.0, "direction": "up"},
                                      {"key": "on_hu", "label": "On hydroxyurea", "value": "yes", "impact": -4.0,
                                       "direction": "down"}],
                             red_flags=[], plan=[], sources=[], model_version="voc-lr-1.0"))
        await s.commit()
    try:
        yield {"policy": await _login(client, "policy-pt@sickleguard.local"),
               "clinician": await _login(client, "clinician-pt@sickleguard.local"),
               "patient": await _login(client, "patient-pt@sickleguard.local")}
    finally:
        async with open_session() as s:
            await s.execute(delete(Crisis).where(Crisis.patient_id.in_(made)))
            await s.execute(delete(Assessment).where(Assessment.patient_id.in_(made)))
            await s.execute(delete(Patient).where(Patient.id.in_(made)))
            await s.execute(delete(User).where(User.email.like("%-pt@sickleguard.local")))
            await s.commit()


async def test_roles(client, setup):
    for e in ENDPOINTS + ["export.csv"]:
        assert (await client.get(f"/api/v1/policy/{e}", headers=setup["policy"])).status_code == 200, e
        assert (await client.get(f"/api/v1/policy/{e}")).status_code == 200, e      # admin (client default)
        assert (await client.get(f"/api/v1/policy/{e}", headers=setup["clinician"])).status_code == 403, e
        assert (await client.get(f"/api/v1/policy/{e}", headers=setup["patient"])).status_code == 403, e
    assert (await client.get("/api/v1/policy/overview", headers={"Authorization": "Bearer nope"})).status_code == 401
    # and the policy role cannot open clinical data
    assert (await client.get("/api/v1/patients", headers=setup["policy"])).status_code == 403


async def test_overview_and_regions(client, setup):
    h = setup["policy"]
    o = (await client.get("/api/v1/policy/overview?cost_per_bed_day=1000", headers=h)).json()
    assert o["patients"] >= 23 and o["crises_12m"] >= 33 and o["admissions_12m"] >= 22
    assert o["cost_per_bed_day_ghs"] == 1000 and o["est_cost_ghs_12m"] >= o["bed_days_12m"] * 1000
    assert o["deltas"]["crises_12m"]["previous"] >= 11       # last year's crises for the delta
    regs = {r["region"]: r for r in (await client.get("/api/v1/policy/regions", headers=h)).json()}
    assert len(regs) >= 16 and set(analytics.REGIONS) <= set(regs)
    ue = regs["Upper East"]
    assert ue["patients"] == 8 and not ue["suppressed"] and ue["crises_12m"] == 24 and ue["admissions_12m"] == 16
    assert ue["avg_los"] == 4.0 and ue["per_100k"] == round(8 / 1_301_226 * 100_000, 2)
    oti = regs["Oti"]
    assert oti["suppressed"] and oti["patients"] == "<5"
    assert all(oti[k] is None for k in ("crises_12m", "admissions_12m", "hu_coverage", "avg_risk", "per_100k"))
    assert regs["Savannah"]["patients"] == 0 and not regs["Savannah"]["suppressed"]


async def test_facilities_suppressed_and_pooled(client, setup):
    rows = (await client.get("/api/v1/policy/facilities", headers=setup["policy"])).json()
    names = [r["facility"] for r in rows]
    assert "Bolgatanga Regional Hospital" in names
    # facilities with < 5 patients are never named
    assert "Navrongo War Memorial Hospital" not in names and "Dambai Health Centre" not in names
    pooled = [r for r in rows if r.get("pooled")]
    assert pooled and pooled[0]["region"] is None


async def test_trends_forecast_drivers_interventions(client, setup):
    h = setup["policy"]
    t = (await client.get("/api/v1/policy/trends?months=12", headers=h)).json()
    assert len(t) == 12 and {"month", "crises", "admissions", "bed_days", "avg_risk"} <= set(t[0])
    for m in t:   # a month with crises from 1-4 patients is suppressed
        if m["suppressed"]:
            assert m["crises"] == "<5" and m["admissions"] is None
    f = (await client.get("/api/v1/policy/forecast?weeks=8", headers=h)).json()
    assert len(f) == 8 and all(w["low"] <= w["expected_crises"] <= w["high"] for w in f)
    assert all(w["expected_admissions"] <= w["expected_crises"] for w in f)
    d = (await client.get("/api/v1/policy/drivers?detail=true", headers=h)).json()
    hyd = next(r for r in d["drivers"] if r["factor"] == "low_hydration")
    assert hyd["modifiable"] and hyd["patients_affected"] >= 11 and 0 < hyd["share_of_risk"] <= 1
    assert all(r["patients_affected"] is None or r["patients_affected"] >= 5 for r in d["drivers"])
    assert abs(sum(r["share_of_risk"] for r in d["drivers"]) - 1) < 0.01
    iv = (await client.get("/api/v1/policy/interventions?detail=true&cost_per_bed_day=800", headers=h)).json()
    keys = {s["key"] for s in iv["scenarios"]}
    assert keys == {"hydroxyurea", "hydration", "cold_season", "adherence", "ed_analgesia"}
    for s in iv["scenarios"]:
        assert s["assumptions"] and s["crises_avoided"] >= 0 and s["admissions_avoided"] >= 0
        assert {"crises_avoided", "admissions_avoided", "cost_saved_ghs", "label", "description"} <= set(s)
    ed = next(s for s in iv["scenarios"] if s["key"] == "ed_analgesia")
    assert ed["crises_avoided"] == 0 and ed["admissions_avoided"] > 0
    cheap = (await client.get("/api/v1/policy/interventions?cost_per_bed_day=100", headers=h)).json()
    hu800 = next(s for s in iv["scenarios"] if s["key"] == "hydroxyurea")["cost_saved_ghs"]
    hu100 = next(s for s in cheap if s["key"] == "hydroxyurea")["cost_saved_ghs"]
    assert hu800 > hu100


async def test_no_identifiers_leak(client, setup):
    async with open_session() as s:
        pats = (await s.execute(select(Patient.id, Patient.name, Patient.mrn, Patient.date_of_birth,
                                       Patient.phone, Patient.notes))).all()
    blob = ""
    for e in ENDPOINTS:
        blob += json.dumps((await client.get(f"/api/v1/policy/{e}", headers=setup["policy"])).json())
    blob += (await client.get("/api/v1/policy/export.csv", headers=setup["policy"])).text
    for pid, name, mrn, dob, phone, notes in pats:
        assert pid not in blob and mrn not in blob, mrn
        assert name not in blob and name.split()[-1] not in blob, name
        assert dob.isoformat() not in blob
        if phone:
            assert phone not in blob
        if notes:
            assert notes not in blob
    assert "secret note" not in blob and "private crisis note" not in blob and TAG not in blob


async def test_export_csv(client, setup):
    r = await client.get("/api/v1/policy/export.csv", headers=setup["policy"])
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("region,population,patients")
    oti = next(line for line in lines if line.startswith("Oti,"))
    assert ",<5," in oti and oti.endswith("True")
    assert any(line.startswith("Upper East,1301226,8,") for line in lines)
    assert lines[-1].startswith("Ghana (all regions)")


def test_small_registry_is_suppressed():
    """With fewer than 5 patients in total nothing is shown."""
    today = date.today()
    snap = analytics.Snapshot(today, [analytics.P(key=i, region="Volta", facility="X", genotype="HbSS", on_hu=False,
                                                  crises_12m_field=1) for i in range(3)],
                              [analytics.C(0, today - timedelta(days=3), True, 2.0)], [])
    o = analytics.overview(snap)
    assert o["suppressed"] and o["patients"] == "<5" and o["crises_12m"] is None
    assert all(w["expected_crises"] is None for w in analytics.forecast(snap)["weeks"])
    assert analytics.interventions(snap)["scenarios"] == []
    assert next(r for r in analytics.regions(snap) if r["region"] == "Volta")["suppressed"]
