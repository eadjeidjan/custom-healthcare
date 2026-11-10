"""Patient portal (role "patient"): a person with sickle cell disease sees and updates only their own record.

Every route depends on `patient_user` and works on `user.patient_id`; no route accepts a patient id from the client.
Check-ins reuse the staff check-in logic (same scoring, same assessment, same staff alerts)."""
import json
import re
from datetime import date, timedelta
from functools import lru_cache
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app import care, devices, imaging, labs, portal_assistant, rag, risk
from app.units import temp
from app.db import Assessment, CheckIn, Device, ImagingStudy, LabResult, Patient, User, get_session
from app.routers import patients as staff_patients
from app.security import patient_user

router = APIRouter()

EMERGENCY_NUMBER = "112"            # Ghana's national emergency number (police, fire, ambulance)
AMBULANCE_NUMBER = "193"            # National Ambulance Service (older direct line, still widely listed)
_PHONE = re.compile(r"(\+?\d[\d\s-]{6,}\d)")


async def _me(user: User, session: AsyncSession) -> Patient:
    p = await session.get(Patient, user.patient_id)
    if p is None:
        raise HTTPException(404, "Your health record isn't linked yet. Please ask your care team.")
    return p


# ---------- plain-language next steps ----------

# what a patient can do about each factor that raises risk (the staff plan is written for the care team)
PATIENT_STEPS = {
    "low_hydration": ("Drink water through the day: aim for 8 or more cups",
                      "Not drinking enough makes blood cells more likely to sickle."),
    "cold": ("Stay warm: wear layers and avoid cold water, wind and strong air conditioning",
             "Cold can set off a crisis."),
    "infection": ("Call your care team today about feeling unwell",
                  "Infections are a common cause of crises."),
    "fever": (f"Check your temperature again; {temp(38.5)} or more means go to hospital now",
              "Fever can be a sign of a serious infection."),
    "missed_hu": ("Take your hydroxyurea every day as your team planned",
                  "It works best when taken every day."),
    "short_sleep": ("Try to get 7–9 hours of sleep tonight", "Good sleep helps your body cope with pain."),
    "stress": ("Take a few minutes to relax: slow breathing, a walk or talking to someone you trust",
               "Stress can make a crisis more likely."),
    "alcohol": ("Skip alcohol for now", "Alcohol dries your body out."),
    "exertion": ("Take it easy today: rest often and drink extra water when active",
                 "Hard exercise uses a lot of oxygen and water."),
    "pain": ("Start your home pain plan early and tell your care team if it isn't helping",
             "Treating pain early can stop it getting worse."),
    "pain_trend": ("Let your care team know your pain has been going up",
                   "Rising pain can be the first sign of a crisis."),
    "low_spo2": ("Check your oxygen again; under 92 % means go to hospital now",
                 "Low oxygen can make cells sickle."),
    "hb_drop": ("Ask your care team about a blood test", "Your blood count is lower than usual."),
    "menstruating": ("During your period: drink extra, stay warm and start your pain plan early",
                     "Periods can set off pain for some people."),
}
DEFAULT_STEPS = [   # (topic factor key, action, why)
    ("low_hydration", "Drink water regularly through the day",
     "Staying hydrated is one of the best ways to prevent a crisis."),
    ("cold", "Keep warm and dress in layers", "Cold and sudden temperature changes can set off a crisis."),
    ("missed_hu", "Take your medicines as your care team planned", "Regular medicines help prevent crises."),
]


def next_steps(a: Optional[Assessment], checked_in_today: bool) -> list[dict]:
    """Red flags first, then today's check-in, then steps for the factors raising risk, then everyday basics."""
    flags = list(a.red_flags or []) if a else []
    steps = [{"action": "Get emergency care now: call 112 or go to the nearest emergency department",
              "why": f["label"], "who": "patient", "urgency": "now"} for f in flags][:1]
    if not checked_in_today:
        steps.append({"action": "Do today's check-in (under a minute)", "why": "It keeps your risk up to date.",
                      "who": "patient", "urgency": "today"})
    for f in (a.factors or []) if a else []:
        if f.get("direction") == "up" and f["key"] in PATIENT_STEPS:
            act, why = PATIENT_STEPS[f["key"]]
            urgency = "now" if f["key"] in ("fever", "low_spo2") else "today"
            steps.append({"action": act, "why": why, "who": "patient", "urgency": urgency})
    for key, act, why in DEFAULT_STEPS:
        if not any(s["action"] == PATIENT_STEPS[key][0] for s in steps):
            steps.append({"action": act, "why": why, "who": "patient", "urgency": "today"})
    seen, out = set(), []
    for s in steps:
        if s["action"] not in seen:
            seen.add(s["action"])
            out.append(s)
    return out[:3 + len(flags[:1])]


async def streak(session: AsyncSession, pid: str) -> int:
    """Days in a row with a check-in, ending today (or yesterday if today's isn't done yet)."""
    rows = await session.scalars(select(CheckIn.date).where(CheckIn.patient_id == pid,
                                                            CheckIn.date >= date.today() - timedelta(days=400))
                                 .order_by(CheckIn.date.desc()))
    days = set(rows.all())
    d = date.today() if date.today() in days else date.today() - timedelta(days=1)
    n = 0
    while d in days:
        n += 1
        d -= timedelta(days=1)
    return n


def device_out(d: Device) -> dict:
    return devices.device_out(d)        # no key material; status says "offline" when it stopped syncing


def care_team_phone(p: Patient) -> str:
    m = _PHONE.search(p.care_team or "")
    return m.group(1).strip() if m else ""


@router.get("/portal/me")
async def me(user: User = Depends(patient_user), session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    a = await care.latest_assessment(session, p.id)
    patient = await care.patient_out(session, p)
    patient.pop("notes", None)
    patient.update(region=p.region, district=p.district, facility=p.facility)
    today = await session.scalar(select(CheckIn.id).where(CheckIn.patient_id == p.id, CheckIn.date == date.today()))
    devices = (await session.scalars(select(Device).where(Device.patient_id == p.id, Device.status != "retired")
                                     .order_by(Device.created_at))).all()
    team_phone = care_team_phone(p)
    return {
        "patient": patient,
        "risk": care.assessment_out(a) if a else None,
        "streak_days": await streak(session, p.id),
        "checked_in_today": today is not None,
        "next_steps": next_steps(a, today is not None),
        "devices": [device_out(d) for d in devices],
        "care_team": p.care_team,
        # score cut-offs (0-100) for the gentle dial and the trend bands; they follow the current model
        "thresholds": {k: round(v * 100, 1) for k, v in risk.THRESHOLDS.items()},
        "emergency": {
            "phone": EMERGENCY_NUMBER, "ambulance": AMBULANCE_NUMBER, "care_team_phone": team_phone,
            "message": f"If you have a fever of {temp(38.5)} or more, chest pain or trouble breathing, signs of a stroke, "
                       "an erection that won't go down, or pain your home plan can't control: call "
                       f"{EMERGENCY_NUMBER} or go to the nearest emergency department now.",
        },
    }


# ---------- check-ins ----------

@router.get("/portal/checkins")
async def my_checkins(days: int = 30, user: User = Depends(patient_user),
                      session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    return [care.checkin_out(c) for c in await care.recent_days(session, p.id, max(1, min(days, 365)))]


@router.post("/portal/checkins")
async def my_checkin(body: staff_patients.CheckInIn, user: User = Depends(patient_user),
                     session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    before = await care.latest_assessment(session, p.id)
    previous = {"score": before.score, "level": before.level, "created_at": before.created_at} if before else None
    # the staff route does the work: upsert the day, score, save the assessment, raise/upgrade the staff alert
    out = await staff_patients.add_checkin(p.id, body, user, session)
    a = out["assessment"]
    out["previous"] = previous
    out["next_steps"] = next_steps(await session.get(Assessment, a["id"]), True)
    out["streak_days"] = await streak(session, p.id)
    return out


@router.get("/portal/risk-history")
async def risk_history(days: int = 60, user: User = Depends(patient_user),
                       session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    since = date.today() - timedelta(days=max(1, min(days, 365)))
    rows = await session.scalars(select(Assessment).where(Assessment.patient_id == p.id, Assessment.for_date >= since)
                                 .order_by(Assessment.created_at))
    by_day: dict[date, Assessment] = {}
    for a in rows:
        by_day[a.for_date] = a          # the day's latest assessment wins
    return [{"date": d.isoformat(), "score": a.score, "level": a.level} for d, a in sorted(by_day.items())]


# ---------- vitals from devices ----------

@router.get("/portal/vitals")
async def my_vitals(days: int = 14, user: User = Depends(patient_user), session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    return await devices.vitals(session, p.id, max(1, min(days, 90)))     # same function as the staff route


@router.get("/portal/devices")
async def my_devices(user: User = Depends(patient_user), session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    rows = await session.scalars(select(Device).where(Device.patient_id == p.id).order_by(Device.created_at))
    return [device_out(d) for d in rows]


# ---------- records ----------

# plain-language meaning of each lab (reading age ~12)
LAB_ABOUT = {
    "hb": "Haemoglobin carries oxygen in your blood. Your team compares it with your usual level.",
    "wbc": "White blood cells fight infection. A high number can mean an infection or inflammation.",
    "retic": "Reticulocytes are young red blood cells. They show how fast your body is making new blood.",
    "ldh": "LDH goes up when red blood cells break down faster than usual.",
    "bili": "Bilirubin comes from broken-down red cells. A high level can make eyes look yellow.",
    "hbf": "Foetal haemoglobin (HbF) protects against sickling. Hydroxyurea can raise it.",
    "plt": "Platelets help your blood clot.",
    "crp": "CRP rises when there is inflammation or infection in the body.",
    "creat": "Creatinine shows how well your kidneys are working.",
    "ferritin": "Ferritin shows how much iron is stored in your body (it can rise after many transfusions).",
    "anc": "Neutrophils are infection-fighting white cells. Your team watches them if you take hydroxyurea.",
}


def lab_out(r: LabResult) -> dict:
    out = labs.lab_out(r)
    meaning = {None: "In the usual range.", "low": "Lower than the usual range.",
               "high": "Higher than the usual range."}[out["flag"]]
    return {**out, "about": LAB_ABOUT.get(r.code, ""),
            "meaning": meaning if r.ref_low is not None or r.ref_high is not None else ""}


MODALITY = {"xray": "X-ray", "mri": "MRI scan", "ct": "CT scan", "ultrasound": "Ultrasound",
            "tcd": "Transcranial Doppler (brain blood-flow scan)"}


def imaging_out(i: ImagingStudy) -> dict:
    """Report and impression only: no structured or AI findings, no files."""
    return {"id": i.id, "patient_id": i.patient_id, "study_date": i.study_date, "modality": i.modality,
            "modality_label": MODALITY.get(i.modality, i.modality), "body_part": i.body_part,
            "indication": i.indication, "report": i.report, "impression": i.impression}


@router.get("/portal/records")
async def my_records(user: User = Depends(patient_user), session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    latest = await labs.latest_by_code(session, p.id)
    return {"labs": [lab_out(r) for r in latest.values()],
            "imaging": [imaging_out(i) for i in await imaging.list_studies(session, p.id)]}


# ---------- learn cards ----------

# Short self-care cards in plain words, each written from one section of the bundled guidance (api/knowledge).
# (file, section heading, title, summary, icon)
CARDS = [
    ("red-flags-and-emergency-care.md", "Fever in sickle cell disease", "Fever is an emergency",
     f"A temperature of {temp(38.5)} or more can mean a serious infection. Don't wait: go to the emergency department "
     "or call 112 straight away.", "thermometer"),
    ("red-flags-and-emergency-care.md", "Chest pain, breathlessness or low oxygen (acute chest syndrome)",
     "Chest pain or hard breathing",
     "Chest pain, a cough with fever, or struggling to breathe can be acute chest syndrome. It needs hospital care "
     "now.", "lungs"),
    ("red-flags-and-emergency-care.md", "Stroke signs in sickle cell disease", "Know the stroke signs",
     "A drooping face, a weak arm or leg, trouble speaking, or a sudden very bad headache: call 112 at once. "
     "Every minute counts.", "brain"),
    ("red-flags-and-emergency-care.md", "Priapism in sickle cell disease", "A painful erection that won't go down",
     "If an erection lasts more than 2 hours (or keeps coming back), go to the emergency department. It's common "
     "in sickle cell and nothing to be embarrassed about.", "alert"),
    ("prevention-and-self-care.md", "Hydration in sickle cell disease", "Drink water all day",
     "Water keeps your blood flowing easily. Sip through the day, not just when thirsty, and drink more when it's "
     "hot, when you exercise or when you're unwell. Pale pee is a good sign.", "droplet"),
    ("prevention-and-self-care.md", "Keeping warm and avoiding temperature extremes", "Stay warm",
     "Cold, wind and sudden temperature changes can start a crisis. Wear layers, dry off quickly after a bath or "
     "rain, and avoid cold water and strong air conditioning.", "sun"),
    ("prevention-and-self-care.md", "Pacing physical activity", "Move, but pace yourself",
     "Being active is good for you. Warm up, rest often, drink before, during and after, and stop if you feel "
     "unwell, out of breath or in pain.", "activity"),
    ("prevention-and-self-care.md", "Sleep and stress management in sickle cell disease", "Sleep well, stress less",
     "Good sleep and calm help with pain. Keep a regular bedtime. Slow breathing, a walk or talking to someone can "
     "ease stress. Tell your team about loud snoring.", "moon"),
    ("prevention-and-self-care.md", "Avoiding other triggers", "Skip smoking and alcohol",
     "Smoke (even other people's) and alcohol can set off a crisis. Alcohol also dries you out.", "ban"),
    ("prevention-and-self-care.md", "Infection prevention: vaccines and penicillin", "Protect against infection",
     "Your spleen may not fight germs well. Keep vaccines up to date, wash your hands, take medicines your team "
     "prescribed, and get any fever checked fast.", "shield"),
    ("prevention-and-self-care.md", "Travel advice for people with sickle cell disease", "Travelling safely",
     "Talk to your care team before a trip. Pack enough medicine, drink regularly, keep warm on flights and walk "
     "around the cabin. Ask about malaria prevention.", "plane"),
    ("disease-modifying-therapy.md", "Hydroxyurea adherence and monitoring", "Hydroxyurea works when taken daily",
     "If your team prescribed hydroxyurea, take it every day. It can mean fewer crises. You'll need regular blood "
     "tests while on it. Never stop it without asking your team.", "pill"),
    ("acute-pain-management-principles.md", "Individualised pain plans", "Have a pain plan",
     "Ask your care team for a written plan that says what to do for pain at home and when to come to hospital. "
     "Start it early when pain begins.", "clipboard"),
    ("voc-overview-and-triggers.md", "Common triggers of a vaso-occlusive crisis", "What can start a crisis",
     "Not drinking enough, cold, infection, stress, poor sleep, hard exercise, alcohol and sometimes periods. "
     "Your daily check-in watches for these.", "zap"),
    ("using-sickleguard.md", "Limits of SickleGuard", "What SickleGuard can and can't do",
     "SickleGuard looks at your check-ins to spot rising risk early. It can be wrong and it does not replace your "
     "care team. If you feel unwell, trust yourself and get help.", "info"),
]


@lru_cache
def learn_cards() -> list[dict]:
    out = []
    for fname, section, title, summary, icon in CARDS:
        path = rag.KNOWLEDGE_DIR / fname
        if not path.exists():
            continue
        text = path.read_text()
        out.append({"title": title, "summary": summary, "doc_title": rag.title_of(text, fname),
                    "section": section if f"## {section}" in text else "", "icon": icon})
    return out


@router.get("/portal/learn")
async def learn(_: User = Depends(patient_user)):
    return learn_cards()


# ---------- ask (patient-safe assistant) ----------

class AskIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    new_conversation: bool = False


@router.post("/portal/ask")
async def ask(body: AskIn, user: User = Depends(patient_user), session: AsyncSession = Depends(get_session)):
    p = await _me(user, session)
    context = await portal_assistant.patient_context(session, p)
    thread_id = portal_assistant.thread_id_for(user.id)
    if body.new_conversation:
        portal_assistant.forget(user.id)

    async def events():
        yield {"data": json.dumps({"type": "thread", "thread_id": thread_id})}
        try:
            async for ev in portal_assistant.stream(body.message, user.id, context):
                yield {"data": json.dumps(ev, default=str)}
        except Exception:  # noqa: BLE001
            yield {"data": json.dumps({"type": "error", "message": "Sorry, something went wrong. Please try again. "
                                       "If you feel unwell, call your care team or 112."})}
        yield {"data": json.dumps({"type": "done"})}

    return EventSourceResponse(events(), ping=15)


@router.get("/portal/ask/history")
async def ask_history(user: User = Depends(patient_user)):
    return portal_assistant.history(user.id)
