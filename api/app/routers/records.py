"""Records work stream: IoT devices and readings, labs, imaging and the record summary that feeds the prediction.
Everything is staff-only except POST /ingest/readings, which authenticates the device by its API key."""
import logging
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import devices, imaging, labs
from app.db import CheckIn, Device, ImagingStudy, LabResult, Patient, User, get_session, now
from app.security import staff_user
from app.units import temp

log = logging.getLogger("app.records")


@asynccontextmanager
async def lifespan(_app):
    """Merged into the app's lifespan by include_router (runs after the app's own startup: tables exist)."""
    task = devices.start_feed() if devices.feed_enabled() else None
    yield
    if task:
        await devices.stop_feed()


router = APIRouter(lifespan=lifespan)

Kind = Literal["wearable", "pulse_oximeter", "smart_bottle", "thermometer"]
Metric = Literal["heart_rate", "hrv_rmssd", "spo2", "skin_temp_c", "body_temp_c", "steps", "sleep_minutes",
                 "fluid_ml", "resp_rate"]
Modality = Literal["xray", "mri", "ct", "ultrasound", "tcd"]


async def _patient(s: AsyncSession, pid: str) -> Patient:
    p = await s.get(Patient, pid)
    if p is None:
        raise HTTPException(404, "No such patient.")
    return p


@router.get("/records/catalogue")
async def catalogue(_: User = Depends(staff_user)):
    """Metric, lab and finding definitions (units, ranges) for forms and charts."""
    return {"metrics": {m: {"label": i.label, "unit": i.unit, "min": i.lo, "max": i.hi, "daily": i.daily}
                        for m, i in devices.METRICS.items()},
            "device_kinds": {k: {"label": devices.KIND_LABEL[k], "metrics": list(v)}
                             for k, v in devices.KIND_METRICS.items()},
            "labs": labs.catalogue_out(),
            "findings": {c: {"label": lbl, "severity": sev} for c, (lbl, sev) in imaging.CODES.items()},
            "ingest": {"max_batch": devices.MAX_BATCH, "max_age_days": devices.MAX_AGE.days}}


# ---------- devices ----------

class DeviceIn(BaseModel):
    kind: Kind
    label: str = Field(default="", max_length=120)
    vendor: str = Field(default="", max_length=120)
    serial: str = Field(default="", max_length=80)
    simulated: bool = False


class DevicePatch(BaseModel):
    status: Optional[Literal["active", "offline", "retired"]] = None
    label: Optional[str] = Field(default=None, max_length=120)


@router.get("/patients/{pid}/devices")
async def list_devices(pid: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    await _patient(s, pid)
    rows = await s.scalars(select(Device).where(Device.patient_id == pid).order_by(Device.created_at))
    return sorted([devices.device_out(d) for d in rows], key=lambda d: d["status"] == "retired")


@router.post("/patients/{pid}/devices", status_code=201)
async def add_device(pid: str, body: DeviceIn, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    p = await _patient(s, pid)
    d, key = await devices.register(s, p, body.kind, body.label, body.vendor, body.serial, body.simulated)
    return {**devices.device_out(d), "api_key": key}


async def _device(s: AsyncSession, did: str) -> Device:
    d = await s.get(Device, did)
    if d is None:
        raise HTTPException(404, "No such device.")
    return d


@router.patch("/devices/{did}")
async def patch_device(did: str, body: DevicePatch, _: User = Depends(staff_user),
                       s: AsyncSession = Depends(get_session)):
    d = await _device(s, did)
    if body.status is not None:
        d.status = body.status
    if body.label is not None:
        d.label = body.label.strip() or devices.KIND_LABEL.get(d.kind, d.kind)
    await s.commit()
    return devices.device_out(d)


@router.post("/devices/{did}/rotate-key")
async def rotate_key(did: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    """A new API key (the old one stops working). Shown once."""
    d = await _device(s, did)
    if d.status == "retired":
        raise HTTPException(409, "This device is retired.")
    key = await devices.rotate_key(s, d)
    return {**devices.device_out(d), "api_key": key}


class ReadingIn(BaseModel):
    metric: str = Field(max_length=40)
    value: float
    ts: Optional[datetime] = None


class IngestIn(BaseModel):
    readings: list[ReadingIn] = Field(min_length=1, max_length=devices.MAX_BATCH)
    battery: Optional[int] = Field(default=None, ge=0, le=100)


@router.post("/ingest/readings")
async def ingest(body: IngestIn, x_device_key: str = Header(default="", max_length=200),
                 s: AsyncSession = Depends(get_session)):
    """How a device or gateway pushes data: header X-Device-Key, up to 1000 readings per request.
    Implausible values (outside the metric's range, > 7 days old, in the future) are rejected one by one."""
    d = await devices.device_for_key(s, x_device_key)
    if d is None:
        raise HTTPException(401, "Unknown or missing device key (X-Device-Key).")
    if d.status == "retired":
        raise HTTPException(403, "This device is retired; register it again to send readings.")
    return await devices.ingest(s, d, [r.model_dump() for r in body.readings], body.battery)


@router.get("/patients/{pid}/vitals")
async def vitals(pid: str, days: int = 14, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    await _patient(s, pid)
    return await devices.vitals(s, pid, max(1, min(days, 90)))


@router.get("/patients/{pid}/readings")
async def readings(pid: str, metric: Metric, hours: int = 48, _: User = Depends(staff_user),
                   s: AsyncSession = Depends(get_session)):
    await _patient(s, pid)
    return await devices.raw_readings(s, pid, metric, max(1, min(hours, 24 * 14)))


# ---------- labs ----------

class LabIn(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    value: float
    unit: Optional[str] = Field(default=None, max_length=20)
    taken_at: Optional[datetime | date] = None


@router.get("/patients/{pid}/labs")
async def list_labs(pid: str, days: int = 365, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    await _patient(s, pid)
    return [labs.lab_out(r) for r in await labs.list_labs(s, pid, max(1, min(days, 3650)))]


@router.post("/patients/{pid}/labs", status_code=201)
async def add_lab(pid: str, body: LabIn, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    p = await _patient(s, pid)
    try:
        r = labs.make(p, body.code, body.value, body.unit, labs.parse_when(body.taken_at or now()), "manual")
    except labs.LabError as e:
        raise HTTPException(422, str(e)) from None
    s.add(r)
    await s.commit()
    return labs.lab_out(r)


@router.post("/patients/{pid}/labs/import")
async def import_labs(pid: str, file: UploadFile = File(...), _: User = Depends(staff_user),
                      s: AsyncSession = Depends(get_session)):
    """CSV `taken_at,code,value[,unit]` (code: ours, an alias or a LOINC code) or a FHIR R4 Bundle of
    Observations with LOINC codes. Values are converted to the catalogue unit; duplicates are skipped."""
    p = await _patient(s, pid)
    data = await file.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "The file is larger than 5 MB.")
    try:
        return await labs.import_file(s, p, file.filename or "", data)
    except labs.LabError as e:
        raise HTTPException(422, str(e)) from None


@router.delete("/labs/{lid}")
async def delete_lab(lid: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    r = await s.get(LabResult, lid)
    if r is None:
        raise HTTPException(404, "No such lab result.")
    await s.delete(r)
    await s.commit()
    return {"ok": True}


# ---------- imaging ----------

def _opt_float(v: Optional[str], name: str) -> Optional[float]:
    if v is None or not str(v).strip():
        return None
    try:
        return float(v)
    except ValueError:
        raise HTTPException(422, f"{name} must be a number.") from None


@router.get("/patients/{pid}/imaging")
async def list_imaging(pid: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    await _patient(s, pid)
    return [imaging.imaging_out(i) for i in await imaging.list_studies(s, pid)]


@router.post("/patients/{pid}/imaging", status_code=201)
async def add_imaging(pid: str, modality: Modality = Form(...), study_date: date = Form(...),
                      body_part: str = Form("", max_length=60), indication: str = Form("", max_length=2000),
                      report: str = Form("", max_length=20000), impression: str = Form("", max_length=4000),
                      tcd_velocity: Optional[str] = Form(None), second_look: bool = Form(True),
                      file: Optional[UploadFile] = File(None), _: User = Depends(staff_user),
                      s: AsyncSession = Depends(get_session)):
    p = await _patient(s, pid)
    if study_date > date.today():
        raise HTTPException(422, "The study date is in the future.")
    velocity = _opt_float(tcd_velocity, "tcd_velocity")
    if velocity is not None and not 0 < velocity < 400:
        raise HTTPException(422, "tcd_velocity must be between 0 and 400 cm/s.")
    data, ext = b"", None
    if file is not None and file.filename:
        data = await file.read(imaging.MAX_BYTES + 1)
        try:
            ext = imaging.check_upload(file.filename, data)
        except imaging.StoreError as e:
            raise HTTPException(413 if "15 MB" in str(e) else 415, str(e)) from None

    found, method = await imaging.extract_findings(modality, body_part, report, impression, velocity)
    st = ImagingStudy(patient_id=p.id, study_date=study_date, modality=modality, body_part=body_part.strip(),
                      indication=indication.strip(), report=report.strip(), impression=impression.strip(),
                      findings=found, tcd_velocity=velocity, source="upload" if ext else "manual", ai_findings=[])
    s.add(st)
    await s.flush()
    if ext:
        path = imaging.save_file(p.id, st.id, ext, data)
        st.file_path, st.file_name = imaging.relative(path), (file.filename or "")[:300]
        st.content_type = imaging.FILE_TYPES[ext][0]
        if second_look:
            look = await imaging.second_look(path, st.content_type, modality, body_part, indication)
            if look:
                st.ai_summary, st.ai_findings = look
    await s.commit()
    return {**imaging.imaging_out(st), "findings_method": method}


async def _study(s: AsyncSession, iid: str) -> ImagingStudy:
    st = await s.get(ImagingStudy, iid)
    if st is None:
        raise HTTPException(404, "No such imaging study.")
    return st


@router.post("/imaging/{iid}/second-look")
async def redo_second_look(iid: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    st = await _study(s, iid)
    path = imaging.stored_path(st)
    if path is None or not st.content_type.startswith("image/"):
        raise HTTPException(409, "There is no uploaded image for this study.")
    look = await imaging.second_look(path, st.content_type, st.modality, st.body_part, st.indication)
    if look is None:
        raise HTTPException(503, "The AI second look is not available (no OpenAI key or the request failed).")
    st.ai_summary, st.ai_findings = look
    await s.commit()
    return imaging.imaging_out(st)


@router.get("/imaging/{iid}/file")
async def imaging_file(iid: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    st = await _study(s, iid)
    path = imaging.stored_path(st)
    if path is None:
        raise HTTPException(404, "No file is stored for this study.")
    return FileResponse(path, media_type=st.content_type or "application/octet-stream",
                        filename=st.file_name or path.name, content_disposition_type="inline",
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.delete("/imaging/{iid}")
async def delete_imaging(iid: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    st = await _study(s, iid)
    path = imaging.stored_path(st)
    await s.delete(st)
    await s.commit()
    if path:
        path.unlink(missing_ok=True)
    return {"ok": True}


# ---------- record summary ----------

def _fmt(v: Optional[float], digits: int = 0) -> str:
    return "—" if v is None else f"{v:.{digits}f}"


async def record_summary(s: AsyncSession, p: Patient) -> dict:
    """What the record adds to the prediction: latest labs, imaging flags, device signals, the latest check-in.
    `risk_inputs` is a flat list for the model/explanations; `number` is machine-readable where it applies."""
    inputs: list[dict] = []

    def add(source: str, key: str, label: str, value: str, number: Optional[float] = None,
            flag: Optional[str] = None, at=None):
        inputs.append({"source": source, "key": key, "label": label, "value": value, "number": number,
                       "flag": flag, "at": at})

    # devices
    devs = (await s.scalars(select(Device).where(Device.patient_id == p.id, Device.status != "retired"))).all()
    v = await devices.vitals(s, p.id, 7)
    latest, base, metrics = v["latest"], v["baselines"], v["metrics"]
    if "spo2" in latest:
        x = latest["spo2"]["value"]
        add("device", "spo2_latest", "SpO₂ (latest)", f"{x:g} %", x, "low" if x < 92 else None, latest["spo2"]["ts"])
    hr_days = metrics.get("heart_rate", [])
    if hr_days and hr_days[-1].get("resting") is not None:
        r = hr_days[-1]["resting"]
        b = base.get("heart_rate")
        rel = f" ({100 * (r / b - 1):+.0f} % vs baseline {b:.0f})" if b else ""
        add("device", "resting_hr", "Resting heart rate today", f"{r:.0f} bpm{rel}", r,
            "high" if b and r >= b * 1.2 else None)
    temps = metrics.get("body_temp_c", [])
    if temps:
        t = max(d["max"] for d in temps[-2:])
        add("device", "temp_max_48h", "Highest temperature (48 h)", temp(t), t, "high" if t >= 38.5 else None)
    today = date.today().isoformat()
    for m, key, label, unit in (("fluid_ml", "fluid_yesterday", "Fluids yesterday (bottle)", "mL"),
                                ("steps", "steps_yesterday", "Steps yesterday", ""),
                                ("sleep_minutes", "sleep_last", "Sleep (last night)", "min")):
        days_ = [d for d in metrics.get(m, []) if d["date"] < today] if m != "sleep_minutes" else metrics.get(m, [])
        if days_:
            tot = days_[-1]["total"]
            b = base.get(m)
            rel = f" (baseline {b:.0f})" if b else ""
            fl = "low" if (m == "fluid_ml" and tot < 1500) or (b and tot < 0.6 * b) else None
            add("device", key, label, f"{tot:.0f} {unit}".strip() + rel, tot, fl, days_[-1]["date"])
    hrv = metrics.get("hrv_rmssd", [])
    if hrv and base.get("hrv_rmssd"):
        h, b = hrv[-1]["mean"], base["hrv_rmssd"]
        add("device", "hrv_today", "HRV today", f"{h:.0f} ms (baseline {b:.0f})", h, "low" if h <= 0.7 * b else None)

    # labs
    latest_labs = await labs.latest_by_code(s, p.id)
    for code in ("hb", "ldh", "retic", "wbc", "anc", "plt", "crp", "bili", "hbf", "creat", "ferritin"):
        r = latest_labs.get(code)
        if not r:
            continue
        out = labs.lab_out(r)
        value = f"{r.value:g} {r.unit}"
        if code == "hb" and p.hb_baseline:
            value += f" ({r.value - p.hb_baseline:+.1f} vs baseline {p.hb_baseline:g})"
            fl = "low" if r.value <= p.hb_baseline - 2 else out["flag"]
        else:
            fl = out["flag"]
        add("lab", code, r.name, value, r.value, fl, out["taken_at"])

    # imaging
    flags = imaging.active_flags(await imaging.list_studies(s, p.id))
    for f in flags:
        add("imaging", f["code"], f["label"], f"{f['severity']} · {f['modality']} {f['study_date']}", None,
            f["severity"], f["study_date"])

    # check-in
    c = await s.scalar(select(CheckIn).where(CheckIn.patient_id == p.id).order_by(CheckIn.date.desc()).limit(1))
    if c:
        add("checkin", "pain", "Pain (latest check-in)", f"{c.pain}/10", c.pain, "high" if c.pain >= 7 else None,
            c.date.isoformat())
        add("checkin", "hydration", "Fluids (latest check-in)", f"{c.hydration_litres:.1f} L", c.hydration_litres,
            "low" if c.hydration_litres < 1.5 else None, c.date.isoformat())
        add("checkin", "days_since_checkin", "Days since last check-in", str((date.today() - c.date).days),
            (date.today() - c.date).days, "high" if (date.today() - c.date).days > 3 else None)

    return {"patient_id": p.id, "labs_latest": {k: labs.lab_out(r) for k, r in latest_labs.items()},
            "imaging_flags": flags, "devices": len(devs),
            "devices_online": sum(1 for d in devs if devices.effective_status(d) == "active"),
            "vitals_alerts": v["alerts"], "risk_inputs": inputs, "generated_at": now()}


@router.get("/patients/{pid}/record-summary")
async def summary(pid: str, _: User = Depends(staff_user), s: AsyncSession = Depends(get_session)):
    return await record_summary(s, await _patient(s, pid))

