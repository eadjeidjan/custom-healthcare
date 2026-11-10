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
        rows = [await care.patient_row(s, p) for p in (await s.scalars(select(Patient))).all()]
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
                                .where(Alert.status == "open").order_by(Alert.created_at.desc()))).all()
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
