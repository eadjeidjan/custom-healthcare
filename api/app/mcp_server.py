"""SickleGuard's MCP server: patient data, the VOC risk model, guidance search and care-team messages as MCP tools
(streamable HTTP at /mcp). The LangGraph care assistant uses them; so can Claude Desktop or any MCP client.
Run with `python -m app.mcp_server`. When MCP_TOKEN is set every request needs `Authorization: Bearer <MCP_TOKEN>`."""
import hmac
import os

from mcp.server.fastmcp import FastMCP
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app import care, rag
from app.config import get_settings
from app.db import Alert, Notification, Patient, open_session

mcp = FastMCP("sickleguard", instructions="Sickle cell disease care tools: patients, daily check-ins, 7-day "
                                          "vaso-occlusive crisis risk, guidance search, alerts and care-team "
                                          "messages.", stateless_http=True, json_response=True)

NOT_FOUND = "No patient matches '{}'. Use list_patients to see names and MRNs."


@mcp.tool()
async def list_patients(level: str = "") -> list[dict]:
    """List patients with their latest 7-day VOC risk, highest risk first. level: low | moderate | high | critical
    (empty = all)."""
    async with open_session() as s:
        rows = [await care.patient_row(s, p) for p in (await s.scalars(select(Patient).where(Patient.featured.is_(True)))).all()]
    if level:
        rows = [r for r in rows if r["risk"] and r["risk"]["level"] == level]
    rows.sort(key=lambda r: r["risk"]["score"] if r["risk"] else -1, reverse=True)
    return [{"name": r["name"], "mrn": r["mrn"], "age": r["age"], "genotype": r["genotype"],
             "risk_score": r["risk"]["score"] if r["risk"] else None,
             "risk_level": r["risk"]["level"] if r["risk"] else None, "red_flags": r["red_flags"],
             "last_checkin": r["last_checkin"]} for r in rows]


@mcp.tool()
async def get_patient(patient: str) -> dict | str:
    """A patient's profile (genotype, hydroxyurea, baseline Hb, HbF, crisis history, care team) by name, MRN or id."""
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        if p is None:
            return NOT_FOUND.format(patient)
        out = await care.patient_out(s, p)
        crises = await s.scalars(select(care.Crisis).where(care.Crisis.patient_id == p.id)
                                 .order_by(care.Crisis.date.desc()).limit(5))
        out["recent_crises"] = [care.crisis_out(c) for c in crises]
        return {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in out.items()}


@mcp.tool()
async def get_recent_checkins(patient: str, days: int = 7) -> list[dict] | str:
    """A patient's daily check-ins (pain, fluids, sleep, stress, temperature, SpO2, triggers, hydroxyurea, labs),
    newest first. days: 1-30."""
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        if p is None:
            return NOT_FOUND.format(patient)
        rows = await care.recent_days(s, p.id, max(1, min(days, 30)))
        keep = ("date", "pain", "hydration_litres", "sleep_hours", "stress", "temperature_c", "spo2", "cold_exposure",
                "infection_symptoms", "chest_symptoms", "neuro_symptoms", "menstruating", "alcohol",
                "strenuous_activity", "hydroxyurea_taken", "hb", "wbc", "retic_percent", "ldh", "notes")
        return [{k: (str(v) if k == "date" else v) for k, v in care.checkin_out(r).items()
                 if k in keep and v not in (None, "", False)} for r in rows]


@mcp.tool()
async def predict_voc_risk(patient: str) -> dict | str:
    """Run the VOC risk model now for a patient: 7-day risk score 0-100, level, the factors driving it (score
    points) and any red flags that need emergency care. Saves the result."""
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        if p is None:
            return NOT_FOUND.format(patient)
        r = await care.score_patient(s, p)
        await care.save_assessment(s, p, r, "checkin")
        return {"patient": p.name, "risk_score": r.score, "risk_level": r.level, "factors": r.factors,
                "red_flags": r.red_flags, "suggested_plan": care.rule_plan(r), "model": r.model_version}


@mcp.tool()
async def search_guidelines(query: str, k: int = 4) -> list[dict]:
    """Search sickle cell disease guidance (triggers, prevention, red flags, pain, acute chest syndrome, labs,
    disease-modifying therapy). Returns passages with titles to cite."""
    return await rag.search(query, max(1, min(k, 8)))


@mcp.tool()
async def list_open_alerts() -> list[dict]:
    """Open high/critical risk alerts waiting for the care team."""
    async with open_session() as s:
        rows = (await s.execute(select(Alert, Patient.name).join(Patient, Patient.id == Alert.patient_id)
                                .where(Alert.status == "open", Patient.featured.is_(True))
                                .order_by(Alert.created_at.desc()))).all()
        return [{"patient": name, "level": a.level, "score": a.score, "reason": a.reason,
                 "raised": a.created_at.isoformat()} for a, name in rows]


@mcp.tool()
async def notify_care_team(patient: str, message: str) -> str:
    """Send a message to the patient's care team (recorded in SickleGuard's notifications). Use for follow-up
    requests, e.g. 'please call today about rising pain'."""
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        s.add(Notification(patient_id=p.id if p else None, message=message.strip()[:2000]))
        await s.commit()
        team = (p.care_team if p and p.care_team else "the care team")
        return f"Message recorded for {team}" + (f" about {p.name}." if p else ".")



# ---------- medical record and device tools (records work stream) ----------

@mcp.tool()
async def get_vitals(patient: str, days: int = 7) -> dict | str:
    """A patient's device vitals (wearable, pulse oximeter, smart bottle, thermometer): daily mean/min/max per metric,
    the latest reading, 14-day baselines and device alerts (low SpO2, fever, raised resting heart rate, low fluids).
    days: 1-30. Temperatures are in °C; 'display' gives °C and °F for people."""
    from app import devices
    from app.units import temp
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        if p is None:
            return NOT_FOUND.format(patient)
        v = await devices.vitals(s, p.id, max(1, min(days, 30)))
        return {"patient": p.name, "units": v["units"], "baselines": v["baselines"], "alerts": v["alerts"],
                "latest": {m: {"value": x["value"], "at": x["ts"].isoformat(),
                               **({"display": temp(x["value"])} if m in ("body_temp_c", "skin_temp_c") else {})}
                           for m, x in v["latest"].items()},
                "note": "Temperatures are stored in °C; show them to people in °C and °F (see 'display').",
                "daily": v["metrics"]}


@mcp.tool()
async def get_labs(patient: str, days: int = 365) -> dict | str:
    """A patient's lab results (Hb, WBC, ANC, platelets, reticulocytes, LDH, bilirubin, HbF, CRP, creatinine,
    ferritin) newest first, with units, adult reference ranges and low/high flags, plus the latest value per test.
    Many people with sickle cell disease sit outside adult ranges; compare with their own baseline."""
    from app import labs
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        if p is None:
            return NOT_FOUND.format(patient)
        rows = [labs.lab_out(r) for r in await labs.list_labs(s, p.id, max(1, min(days, 3650)))]
        for r in rows:
            r["taken_at"] = r["taken_at"].isoformat()
            r.pop("patient_id", None)
        latest: dict = {}
        for r in rows:
            latest.setdefault(r["code"], r)
        return {"patient": p.name, "hb_baseline": p.hb_baseline, "latest": latest, "results": rows[:100]}


@mcp.tool()
async def get_imaging_findings(patient: str) -> dict | str:
    """A patient's imaging studies (x-ray, MRI, CT, ultrasound, transcranial Doppler) newest first: impression,
    structured findings with severity, TCD velocity, and any AI second look (not a radiology report; the
    radiologist's report is authoritative). Also the currently relevant imaging flags."""
    from app import imaging
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        if p is None:
            return NOT_FOUND.format(patient)
        studies = await imaging.list_studies(s, p.id)
        out = []
        for st in studies[:20]:
            o = imaging.imaging_out(st)
            out.append({"study_date": str(o["study_date"]), "modality": o["modality"], "body_part": o["body_part"],
                        "impression": o["impression"], "findings": o["findings"], "tcd_velocity": o["tcd_velocity"],
                        "ai_second_look": ({"label": o["ai_label"], "summary": o["ai_summary"],
                                            "findings": o["ai_findings"]} if o["ai_label"] else None)})
        return {"patient": p.name, "flags": imaging.active_flags(studies), "studies": out}


@mcp.tool()
async def get_record_summary(patient: str) -> dict | str:
    """What a patient's medical record and devices add to the VOC prediction: latest labs, imaging flags, device
    signals vs baseline and the latest check-in, as a list of inputs with low/high flags."""
    from app.routers.records import record_summary
    async with open_session() as s:
        p = await care.find_patient(s, patient)
        if p is None:
            return NOT_FOUND.format(patient)
        out = await record_summary(s, p)
        return {"patient": p.name, "devices": out["devices"], "vitals_alerts": out["vitals_alerts"],
                "imaging_flags": out["imaging_flags"],
                "risk_inputs": [{**i, "at": str(i["at"]) if i["at"] is not None else None}
                                for i in out["risk_inputs"]]}

class _TokenCheck(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        token = get_settings().mcp_token
        if token:
            sent = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
            if not hmac.compare_digest(sent, token):
                return JSONResponse({"detail": "MCP token missing or wrong."}, status_code=401)
        return await call_next(request)


def app():
    from mcp.server.transport_security import TransportSecuritySettings
    mcp.settings.transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
    asgi = mcp.streamable_http_app()
    asgi.add_middleware(_TokenCheck)
    return asgi


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app(), host=os.environ.get("MCP_HOST", "127.0.0.1"), port=get_settings().mcp_port, log_level="info")
