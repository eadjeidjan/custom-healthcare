"""Records: devices + ingestion + vitals, labs (manual, CSV, FHIR), imaging (findings, TCD, files, AI second look),
record summary, the sample feed and the MCP tools."""
import json
import random
from datetime import date, datetime, timedelta, timezone

import pytest

from app import assistant, db, devices, imaging, labs, llm
from app.config import get_settings
from app.security import make_token

V1 = "/api/v1"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def _new_patient(client, mrn: str, sex: str = "F") -> str:
    r = await client.post(f"{V1}/patients", json={"mrn": mrn, "name": f"Rec {mrn}", "date_of_birth": "1998-03-02",
                                                   "sex": sex, "genotype": "HbSS", "hb_baseline": 8.0})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.fixture
def data_dir(tmp_path):
    s = get_settings()
    old = s.data_dir
    s.data_dir = str(tmp_path)
    yield tmp_path
    s.data_dir = old


async def test_device_register_ingest_and_status(client):
    pid = await _new_patient(client, "REC-D1")
    r = await client.post(f"{V1}/patients/{pid}/devices", json={"kind": "pulse_oximeter", "serial": "PX-1"})
    assert r.status_code == 201
    dev = r.json()
    key = dev["api_key"]
    assert key.startswith(f"sgd_{dev['id']}_") and dev["status"] == "offline" and dev["label"] == "Pulse oximeter"
    listed = (await client.get(f"{V1}/patients/{pid}/devices")).json()
    assert listed[0]["id"] == dev["id"] and "api_key" not in listed[0]
    async with db.open_session() as s:   # only the hash is stored
        stored = await s.get(db.Device, dev["id"])
        assert stored.token_hash and key not in stored.token_hash

    t0 = datetime.now(timezone.utc) - timedelta(minutes=40)
    batch = [{"metric": "spo2", "value": 90 if 10 <= i < 30 else 97, "ts": (t0 + timedelta(minutes=i)).isoformat()}
             for i in range(40)]
    batch += [{"metric": "spo2", "value": 140}, {"metric": "glucose", "value": 5},
              {"metric": "heart_rate", "value": 80, "ts": (t0 - timedelta(days=9)).isoformat()},
              {"metric": "heart_rate", "value": 80, "ts": (t0 + timedelta(hours=2)).isoformat()},
              {"metric": "body_temp_c", "value": 38.9}]
    no_auth = {"Authorization": ""}
    r = await client.post(f"{V1}/ingest/readings", json={"readings": batch, "battery": 64},
                          headers={**no_auth, "X-Device-Key": key})
    out = r.json()
    assert r.status_code == 200 and out["accepted"] == 41 and out["rejected"] == 4, out
    assert any("plausible range" in e for e in out["errors"]) and any("unknown metric" in e for e in out["errors"])
    assert (await client.post(f"{V1}/ingest/readings", json={"readings": batch[:1]},
                              headers={**no_auth, "X-Device-Key": key[:-2] + "xx"})).status_code == 401
    assert (await client.post(f"{V1}/ingest/readings", json={"readings": batch[:1]},
                              headers=no_auth)).status_code == 401
    assert (await client.post(f"{V1}/ingest/readings", json={"readings": batch[:1] * 1001},
                              headers={**no_auth, "X-Device-Key": key})).status_code == 422

    d = (await client.get(f"{V1}/patients/{pid}/devices")).json()[0]
    assert d["status"] == "active" and d["battery"] == 64 and d["last_seen"]

    v = (await client.get(f"{V1}/patients/{pid}/vitals?days=14")).json()
    assert v["metrics"]["spo2"][-1]["n"] == 40 and v["metrics"]["spo2"][-1]["min"] == 90
    assert v["latest"]["body_temp_c"]["value"] == 38.9
    kinds = {a["metric"] for a in v["alerts"]}
    assert {"spo2", "body_temp_c"} <= kinds
    fever = [a for a in v["alerts"] if a["metric"] == "body_temp_c"][0]["message"]
    assert "38.9 °C (102.0 °F)" in fever   # temperatures are shown in °C and °F
    raw = (await client.get(f"{V1}/patients/{pid}/readings?metric=spo2&hours=2")).json()
    assert len(raw) == 40 and raw[0]["value"] == 97
    assert (await client.get(f"{V1}/patients/{pid}/readings?metric=nope")).status_code == 422

    # retire: readings refused; rotate refused
    r = await client.patch(f"{V1}/devices/{dev['id']}", json={"status": "retired", "label": "Old oximeter"})
    assert r.json()["status"] == "retired" and r.json()["label"] == "Old oximeter"
    assert (await client.post(f"{V1}/ingest/readings", json={"readings": batch[:1]},
                              headers={**no_auth, "X-Device-Key": key})).status_code == 403
    assert (await client.post(f"{V1}/devices/{dev['id']}/rotate-key")).status_code == 409


async def test_offline_after_six_hours_and_key_rotation(client):
    pid = await _new_patient(client, "REC-D2")
    dev = (await client.post(f"{V1}/patients/{pid}/devices", json={"kind": "thermometer"})).json()
    async with db.open_session() as s:
        d = await s.get(db.Device, dev["id"])
        d.last_seen = datetime.now(timezone.utc) - timedelta(hours=7)
        await s.commit()
    assert (await client.get(f"{V1}/patients/{pid}/devices")).json()[0]["status"] == "offline"
    new = (await client.post(f"{V1}/devices/{dev['id']}/rotate-key")).json()["api_key"]
    body = {"readings": [{"metric": "body_temp_c", "value": 36.9}]}
    assert (await client.post(f"{V1}/ingest/readings", json=body,
                              headers={"Authorization": "", "X-Device-Key": dev["api_key"]})).status_code == 401
    assert (await client.post(f"{V1}/ingest/readings", json=body,
                              headers={"Authorization": "", "X-Device-Key": new})).json()["accepted"] == 1


async def test_vitals_baseline_and_resting_hr_alert(client):
    pid = await _new_patient(client, "REC-D3")
    now = datetime.now(timezone.utc)
    async with db.open_session() as s:
        for day in range(2, 16):
            d0 = datetime.combine(now.date() - timedelta(days=day), datetime.min.time(), tzinfo=timezone.utc)
            for h in range(0, 24, 2):
                s.add(db.Reading(patient_id=pid, ts=d0 + timedelta(hours=h), metric="heart_rate", value=70 + (h % 6)))
            s.add(db.Reading(patient_id=pid, ts=d0 + timedelta(hours=9), metric="fluid_ml", value=2400))
            s.add(db.Reading(patient_id=pid, ts=d0 + timedelta(hours=15), metric="fluid_ml", value=200))
        for m in range(48):    # the last 24 h, night included: resting rate well above baseline
            s.add(db.Reading(patient_id=pid, ts=now - timedelta(minutes=30 * m), metric="heart_rate", value=92 + m % 6))
        await s.commit()
    v = (await client.get(f"{V1}/patients/{pid}/vitals?days=14")).json()
    assert 69 <= v["baselines"]["heart_rate"] <= 72
    day = v["metrics"]["fluid_ml"][-1]
    assert v["baselines"]["fluid_ml"] == 2600 and day["total"] == day["mean"] == day["value"] == 2600   # summed
    lo, hi = v["baseline_bands"]["heart_rate"]
    assert lo <= v["baselines"]["heart_rate"] <= hi
    assert any(a["metric"] == "heart_rate" and "above the 14-day baseline" in a["message"] for a in v["alerts"])


async def test_labs_manual_flags_and_units(client):
    pid = await _new_patient(client, "REC-L1", sex="M")
    r = await client.post(f"{V1}/patients/{pid}/labs", json={"code": "hb", "value": 72, "unit": "g/L",
                                                              "taken_at": "2026-01-05"})
    lab = r.json()
    assert r.status_code == 201 and lab["value"] == 7.2 and lab["unit"] == "g/dL" and lab["flag"] == "low"
    assert lab["ref_low"] == 13.0 and lab["name"] == "Haemoglobin" and lab["source"] == "manual"
    r = (await client.post(f"{V1}/patients/{pid}/labs", json={"code": "LDH", "value": 610})).json()
    assert r["code"] == "ldh" and r["flag"] == "high"
    assert (await client.post(f"{V1}/patients/{pid}/labs", json={"code": "zinc", "value": 1})).status_code == 422
    assert (await client.post(f"{V1}/patients/{pid}/labs", json={"code": "hb", "value": 70})).status_code == 422
    assert (await client.post(f"{V1}/patients/{pid}/labs",
                              json={"code": "hb", "value": 8, "unit": "furlongs"})).status_code == 422
    rows = (await client.get(f"{V1}/patients/{pid}/labs?days=3650")).json()
    assert [x["code"] for x in rows] == ["ldh", "hb"]   # newest first
    assert (await client.delete(f"{V1}/labs/{rows[0]['id']}")).json()["ok"]


async def test_labs_import_csv_and_fhir(client):
    pid = await _new_patient(client, "REC-L2")
    csv = ("taken_at,code,value,unit\n2026-10-01,hb,7.9,g/dL\n2026-10-01,718-7,8.1,\n2026-10-01,retic,9,%\n"
           "2026-10-01,bili,2.0,mg/dL\n2026-10-01,unicorn,3,\n2031-01-01,hb,8,\n2026-10-01,wbc,abc,\n"
           "2026-10-01,hb,7.9,g/dL\n")
    r = (await client.post(f"{V1}/patients/{pid}/labs/import",
                           files={"file": ("labs.csv", csv.encode(), "text/csv")})).json()
    assert r["imported"] == 4 and r["skipped"] == 1 and len(r["errors"]) == 3, r
    bili = [x for x in (await client.get(f"{V1}/patients/{pid}/labs")).json() if x["code"] == "bili"][0]
    assert bili["value"] == pytest.approx(34.2) and bili["flag"] == "high"

    def obs(loinc, value, unit, when="2026-10-20T09:00:00Z", status="final"):
        return {"resource": {"resourceType": "Observation", "status": status, "effectiveDateTime": when,
                             "code": {"coding": [{"system": "http://loinc.org", "code": loinc}]},
                             "valueQuantity": {"value": value, "unit": unit}}}
    bundle = {"resourceType": "Bundle", "type": "collection", "entry": [
        obs("718-7", 7.5, "g/dL"), obs("2532-0", 540, "U/L"), obs("4576-5", 12, "%"), obs("1988-5", 1.5, "mg/dL"),
        obs("8867-4", 92, "/min"), obs("718-7", 7.0, "g/dL", status="entered-in-error"),
        {"resource": {"resourceType": "Patient", "id": "x"}},
        {"resource": {"resourceType": "Observation", "status": "final",
                      "code": {"coding": [{"system": "http://loinc.org", "code": "777-3"}]}}}]}
    r = (await client.post(f"{V1}/patients/{pid}/labs/import",
                           files={"file": ("bundle.json", json.dumps(bundle).encode(), "application/json")})).json()
    assert r["imported"] == 4 and r["skipped"] == 3 and len(r["errors"]) == 1, r
    crp = [x for x in (await client.get(f"{V1}/patients/{pid}/labs")).json() if x["code"] == "crp"][0]
    assert crp["value"] == 15 and crp["source"] == "fhir"
    bad = await client.post(f"{V1}/patients/{pid}/labs/import", files={"file": ("x.json", b"{nope", "text/plain")})
    assert bad.status_code == 422


def test_keyword_findings_and_tcd():
    fs = imaging.keyword_findings("Patchy consolidation in the left lower lobe. No pleural effusion. "
                                  "No evidence of cardiomegaly. Mild splenomegaly.")
    codes = {f["code"] for f in fs}
    assert codes == {"acs_infiltrate", "splenomegaly"}
    assert imaging.keyword_findings("Lungs are clear. Normal study.")[0]["code"] == "normal"
    assert imaging.keyword_findings("Osteonecrosis of the right femoral head.")[0]["code"] == "avn_hip"
    assert imaging.tcd_finding(185)["code"] == "tcd_conditional"
    assert imaging.tcd_finding(200)["code"] == "tcd_abnormal" and imaging.tcd_finding(200)["severity"] == "severe"
    assert imaging.tcd_finding(150)["code"] == "normal"


async def test_imaging_upload_findings_file_and_auth(client, data_dir):
    pid = await _new_patient(client, "REC-I1")
    r = await client.post(f"{V1}/patients/{pid}/imaging", data={
        "modality": "xray", "study_date": "2026-11-01", "body_part": "chest", "indication": "fever, chest pain",
        "report": "New right lower lobe consolidation. No effusion.", "impression": "Possible acute chest syndrome."},
        files={"file": ("cxr.png", PNG, "image/png")})
    assert r.status_code == 201, r.text
    st = r.json()
    assert st["findings"][0]["code"] == "acs_infiltrate" and st["findings"][0]["severity"] == "severe"
    assert st["findings_method"] == "rules" and st["ai_summary"] is None   # no key → no second look
    assert st["file_url"] == f"/api/v1/imaging/{st['id']}/file" and st["content_type"] == "image/png"
    assert (data_dir / "imaging" / pid / f"{st['id']}.png").read_bytes() == PNG

    f = await client.get(st["file_url"])
    assert f.status_code == 200 and f.content == PNG and f.headers["content-type"] == "image/png"
    assert (await client.get(st["file_url"], headers={"Authorization": ""})).status_code == 401

    tcd = (await client.post(f"{V1}/patients/{pid}/imaging", data={
        "modality": "tcd", "study_date": "2026-10-01", "report": "Right MCA TAMMV 205 cm/s."})).json()
    assert tcd["tcd_velocity"] is None and tcd["findings"][0]["code"] == "tcd_abnormal" and tcd["file_url"] is None
    tcd2 = (await client.post(f"{V1}/patients/{pid}/imaging", data={
        "modality": "tcd", "study_date": "2026-11-02", "tcd_velocity": "176"})).json()
    assert tcd2["findings"][0]["code"] == "tcd_conditional"
    listed = (await client.get(f"{V1}/patients/{pid}/imaging")).json()
    assert [x["id"] for x in listed] == [tcd2["id"], st["id"], tcd["id"]]

    # refused: wrong content, disguised content, too big, future date
    bad = await client.post(f"{V1}/patients/{pid}/imaging", data={"modality": "xray", "study_date": "2026-11-01"},
                            files={"file": ("x.png", b"MZ\x90\x00 not an image", "image/png")})
    assert bad.status_code == 415
    bad = await client.post(f"{V1}/patients/{pid}/imaging", data={"modality": "xray", "study_date": "2026-11-01"},
                            files={"file": ("x.pdf", PNG, "application/pdf")})
    assert bad.status_code == 415
    big = PNG + b"\x00" * imaging.MAX_BYTES
    assert (await client.post(f"{V1}/patients/{pid}/imaging", data={"modality": "xray", "study_date": "2026-11-01"},
                              files={"file": ("x.png", big, "image/png")})).status_code == 413
    future = (date.today() + timedelta(days=3)).isoformat()
    assert (await client.post(f"{V1}/patients/{pid}/imaging",
                              data={"modality": "xray", "study_date": future})).status_code == 422

    # a path outside data_dir is never served
    async with db.open_session() as s:
        row = await s.get(db.ImagingStudy, st["id"])
        row.file_path = "../../../../etc/passwd"
        await s.commit()
    assert (await client.get(st["file_url"])).status_code == 404
    assert (await client.delete(f"{V1}/imaging/{tcd['id']}")).json()["ok"]


class _FakeModel:
    """Answers both structured-output schemas used by imaging.py."""
    def __init__(self):
        self.schema = None
        self.seen = []

    def with_structured_output(self, schema):
        m = _FakeModel()
        m.schema, m.seen = schema, self.seen
        return m

    async def ainvoke(self, messages):
        self.seen.append(messages)
        if self.schema is imaging._SecondLook:
            return imaging._SecondLook(image_type="frontal chest radiograph", is_medical_image=True, readable=True,
                                       summary="There may be an opacity at the right base. Give 500 mg of x.",
                                       findings=[imaging._Finding(code="acs_infiltrate", label="Right basal opacity")])
        return imaging._Extracted(findings=[imaging._Finding(code="avn_hip", label="Left femoral head AVN")])


async def test_ai_findings_and_second_look_with_fake_model(client, data_dir):
    pid = await _new_patient(client, "REC-I2")
    fake = _FakeModel()
    llm.use_models(chat=fake)
    try:
        st = (await client.post(f"{V1}/patients/{pid}/imaging", data={
            "modality": "xray", "study_date": "2026-11-01", "body_part": "pelvis", "report": "See impression."},
            files={"file": ("hip.png", PNG, "image/png")})).json()
        again = await client.post(f"{V1}/imaging/{st['id']}/second-look")
    finally:
        llm.use_models()
    assert st["findings_method"] == "ai" and st["findings"] == [
        {"code": "avn_hip", "label": "Left femoral head AVN", "severity": "moderate"}]
    assert st["ai_findings"][0]["severity"] == "severe" and "500 mg" not in st["ai_summary"]
    assert st["ai_label"].startswith("AI second look, not a radiology report")
    image_part = fake.seen[-1][1].content[1]
    assert image_part["type"] == "image_url" and image_part["image_url"]["url"].startswith("data:image/png;base64,")
    assert again.status_code == 200


async def test_record_summary_and_mcp_tools(client, data_dir):
    pid = await _new_patient(client, "REC-S1")
    await client.post(f"{V1}/patients/{pid}/labs", json={"code": "hb", "value": 5.9})
    await client.post(f"{V1}/patients/{pid}/imaging", data={"modality": "tcd", "study_date": "2025-06-01",
                                                             "tcd_velocity": "210"})
    await client.post(f"{V1}/patients/{pid}/imaging", data={"modality": "tcd", "study_date": "2026-06-01",
                                                             "tcd_velocity": "150"})
    await client.post(f"{V1}/patients/{pid}/imaging", data={"modality": "ultrasound", "study_date": "2026-05-01",
                                                             "report": "Multiple gallstones."})
    dev = (await client.post(f"{V1}/patients/{pid}/devices", json={"kind": "pulse_oximeter"})).json()
    await client.post(f"{V1}/ingest/readings", json={"readings": [{"metric": "spo2", "value": 89}]},
                      headers={"Authorization": "", "X-Device-Key": dev["api_key"]})
    await client.post(f"{V1}/patients/{pid}/checkins", json={"pain": 8})
    r = (await client.get(f"{V1}/patients/{pid}/record-summary")).json()
    assert r["devices"] == 1 and r["labs_latest"]["hb"]["value"] == 5.9
    assert [f["code"] for f in r["imaging_flags"]] == ["gallstones"]   # the newer normal TCD supersedes 210 cm/s
    by = {(i["source"], i["key"]): i for i in r["risk_inputs"]}
    assert by[("lab", "hb")]["flag"] == "low" and "-2.1 vs baseline" in by[("lab", "hb")]["value"]
    assert by[("device", "spo2_latest")]["flag"] == "low" and by[("checkin", "pain")]["number"] == 8
    assert {i["source"] for i in r["risk_inputs"]} == {"device", "lab", "imaging", "checkin"}

    tools = {t.name: t for t in assistant.local_tools()}
    name = "Rec REC-S1"
    labs_out = await tools["get_labs"].ainvoke({"patient": name})
    assert labs_out["latest"]["hb"]["flag"] == "low"
    img = await tools["get_imaging_findings"].ainvoke({"patient": name})
    assert len(img["studies"]) == 3 and img["flags"][0]["code"] == "gallstones"
    vit = await tools["get_vitals"].ainvoke({"patient": name, "days": 3})
    assert vit["latest"]["spo2"]["value"] == 89
    summ = await tools["get_record_summary"].ainvoke({"patient": name})
    assert summ["devices"] == 1
    assert "No patient" in await tools["get_labs"].ainvoke({"patient": "zzz-nobody"})


async def test_sample_feed_continues_the_trend(client):
    pid = (await client.get(f"{V1}/patients?q=Ama")).json()[0]["id"]   # a featured patient
    dev = (await client.post(f"{V1}/patients/{pid}/devices",
                             json={"kind": "pulse_oximeter", "simulated": True})).json()
    bottle = (await client.post(f"{V1}/patients/{pid}/devices",
                                json={"kind": "smart_bottle", "simulated": True})).json()
    now = datetime.now(timezone.utc)
    async with db.open_session() as s:
        for m in range(1, 120):
            s.add(db.Reading(patient_id=pid, device_id=dev["id"], ts=now - timedelta(minutes=m), metric="spo2",
                             value=93))
            s.add(db.Reading(patient_id=pid, device_id=dev["id"], ts=now - timedelta(minutes=m), metric="heart_rate",
                             value=104))
        await s.commit()
    assert not devices.feed_enabled()   # tests run on SQLite: the background feed stays off
    n = await devices.feed_tick(random.Random(7))
    assert n >= 2
    async with db.open_session() as s:
        from sqlalchemy import select
        new = (await s.scalars(select(db.Reading).where(db.Reading.device_id == dev["id"])
                               .order_by(db.Reading.id.desc()).limit(2))).all()
        vals = {r.metric: r.value for r in new}
        d = await s.get(db.Device, dev["id"])
        assert d.last_seen is not None and d.battery is not None
    assert 91 <= vals["spo2"] <= 95 and 92 <= vals["heart_rate"] <= 116
    await client.patch(f"{V1}/devices/{dev['id']}", json={"status": "retired"})
    await client.patch(f"{V1}/devices/{bottle['id']}", json={"status": "retired"})


async def test_records_are_staff_only(client):
    pid = (await client.get(f"{V1}/patients?q=Ama")).json()[0]["id"]
    async with db.open_session() as s:
        u = db.User(email="rec-portal@example.org", name="P", password_hash="x", role="patient", patient_id=pid)
        s.add(u)
        await s.commit()
        token = make_token(u)
    h = {"Authorization": f"Bearer {token}"}
    for path in (f"/patients/{pid}/devices", f"/patients/{pid}/vitals", f"/patients/{pid}/labs",
                 f"/patients/{pid}/imaging", f"/patients/{pid}/record-summary", "/records/catalogue"):
        assert (await client.get(V1 + path, headers=h)).status_code == 403, path
    assert (await client.get(f"{V1}/patients/{pid}/labs", headers={"Authorization": ""})).status_code == 401
    cat = (await client.get(f"{V1}/records/catalogue")).json()
    assert set(cat["metrics"]) == set(devices.METRICS) and len(cat["labs"]) == len(labs.CATALOGUE)


