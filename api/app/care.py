"""Patient data helpers shared by the API, the LangGraph pipeline and the MCP server."""
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import risk
from app.config import DISCLAIMER
from app.db import Alert, Assessment, CheckIn, Crisis, Patient

LEVEL_RANK = {"low": 0, "moderate": 1, "high": 2, "critical": 3}

# what to do about each factor when it raises risk (also the plan used when there is no OpenAI key)
ACTIONS = {
    "low_hydration": ("Increase fluids to at least 2.5–3 L a day, more in heat or with activity",
                      "Dehydration makes red cells sickle and block small vessels.", "patient", "today"),
    "cold": ("Keep warm: layers, avoid cold water and wind, warm the home",
             "Cold and sudden temperature changes trigger vaso-occlusion.", "patient", "today"),
    "infection": ("Contact the care team today about the infection symptoms",
                  "Infection is a leading trigger of crises and of acute chest syndrome.", "care team", "today"),
    "fever": ("Check temperature again; 38.5 °C or more means emergency care",
              "Fever can mean serious infection (functional asplenia).", "patient", "now"),
    "missed_hu": ("Review hydroxyurea adherence and barriers with the patient",
                  "Hydroxyurea reduces pain crises only when taken regularly.", "care team", "this week"),
    "short_sleep": ("Aim for 7–9 hours of sleep; review sleep problems",
                    "Poor sleep is linked to more pain and crises.", "patient", "this week"),
    "stress": ("Offer stress support (counselling, relaxation, peer support)",
               "Emotional stress is a recognised crisis trigger.", "care team", "this week"),
    "alcohol": ("Avoid alcohol for now",
                "Alcohol dehydrates and is a known trigger.", "patient", "today"),
    "exertion": ("Pace activity with rest and extra fluids; avoid exhausting exercise",
                 "Overexertion raises oxygen demand and dehydration.", "patient", "today"),
    "pain": ("Follow the personal pain plan early and log pain twice a day",
             "Rising pain is often the first sign of a developing crisis.", "patient", "now"),
    "pain_trend": ("Phone check-in by the care team within 24 hours",
                   "Pain has been rising over recent days.", "care team", "today"),
    "low_spo2": ("Recheck oxygen saturation; below 92 % needs emergency care",
                 "Low oxygen promotes sickling and can signal acute chest syndrome.", "care team", "today"),
    "hb_drop": ("Arrange a same-day or next-day blood count",
                "A fall in Hb from baseline can signal haemolysis, sequestration or aplastic crisis.",
                "care team", "today"),
    "high_ldh": ("Review haemolysis markers at the next blood test",
                 "Rising LDH suggests more haemolysis.", "care team", "this week"),
    "high_wbc": ("Look for infection and review the white count trend",
                 "A high white count is linked to more severe disease and infection.", "care team", "this week"),
    "menstruating": ("Extra fluids, warmth and early pain relief during periods",
                     "Menstruation is a common trigger for some patients.", "patient", "today"),
    "prior_crises": ("Review the disease-modifying treatment plan at the next clinic",
                     "Frequent crises in the last year mean higher ongoing risk.", "care team", "this week"),
}


def age(dob: date) -> int:
    t = date.today()
    return t.year - dob.year - ((t.month, t.day) < (dob.month, dob.day))


async def recent_days(s: AsyncSession, patient_id: str, days: int = 14) -> list[CheckIn]:
    since = date.today() - timedelta(days=days)
    return list((await s.scalars(select(CheckIn).where(CheckIn.patient_id == patient_id, CheckIn.date >= since)
                                 .order_by(CheckIn.date.desc()))).all())


async def latest_assessment(s: AsyncSession, patient_id: str) -> Optional[Assessment]:
    return await s.scalar(select(Assessment).where(Assessment.patient_id == patient_id)
                          .order_by(Assessment.created_at.desc()).limit(1))


async def score_patient(s: AsyncSession, p: Patient) -> risk.Result:
    rows = await recent_days(s, p.id)
    return risk.assess(risk.Profile.of(p), [risk.Day.of(r) for r in rows])


def rule_plan(result: risk.Result) -> list[dict]:
    plan = [{"action": f["action"], "why": f["label"], "who": "patient", "urgency": "now"} for f in result.red_flags]
    for f in result.factors:
        if f["direction"] == "up" and f["key"] in ACTIONS:
            a, why, who, urgency = ACTIONS[f["key"]]
            plan.append({"action": a, "why": why, "who": who, "urgency": urgency})
    if result.level in ("high", "critical") and not result.red_flags:
        plan.append({"action": "Care team to contact the patient within 24 hours and check the personal care plan",
                     "why": f"7-day crisis risk is {result.level} ({result.score:.0f}/100).",
                     "who": "care team", "urgency": "today"})
    if not plan:
        plan.append({"action": "Keep up daily check-ins, fluids, warmth and medicines as prescribed",
                     "why": "Risk is low; routine prevention keeps it there.", "who": "patient",
                     "urgency": "this week"})
    return plan[:8]


async def save_assessment(s: AsyncSession, p: Patient, result: risk.Result, kind: str, summary: Optional[str] = None,
                          plan: Optional[list] = None, sources: Optional[list] = None) -> Assessment:
    a = Assessment(patient_id=p.id, kind=kind, for_date=date.today(), score=result.score, level=result.level,
                   probability=result.probability, factors=result.factors, red_flags=result.red_flags,
                   summary=summary, plan=plan if plan is not None else rule_plan(result), sources=sources or [],
                   model_version=result.model_version)
    s.add(a)
    await maybe_alert(s, p, result)
    await s.commit()
    return a


async def maybe_alert(s: AsyncSession, p: Patient, result: risk.Result) -> None:
    """One open alert per patient: raised when risk reaches high, upgraded when it gets worse."""
    if LEVEL_RANK[result.level] < LEVEL_RANK["high"]:
        return
    reason = "; ".join(f["label"] for f in result.red_flags) or \
             "Top factors: " + ", ".join(f"{f['label']} ({f['value']})" for f in result.factors[:3]
                                         if f["direction"] == "up")
    open_alert = await s.scalar(select(Alert).where(Alert.patient_id == p.id, Alert.status == "open")
                                .order_by(Alert.created_at.desc()).limit(1))
    if open_alert and LEVEL_RANK[open_alert.level] >= LEVEL_RANK[result.level]:
        return
    if open_alert:
        open_alert.level, open_alert.score, open_alert.reason = result.level, result.score, reason
        return
    s.add(Alert(patient_id=p.id, level=result.level, score=result.score, reason=reason))


def assessment_out(a: Assessment) -> dict:
    return {"id": a.id, "patient_id": a.patient_id, "created_at": a.created_at, "kind": a.kind, "score": a.score,
            "level": a.level, "probability": a.probability, "factors": a.factors, "red_flags": a.red_flags,
            "summary": a.summary, "plan": a.plan, "sources": a.sources, "model_version": a.model_version,
            "disclaimer": DISCLAIMER}


async def patient_row(s: AsyncSession, p: Patient) -> dict:
    a = await latest_assessment(s, p.id)
    last = await s.scalar(select(func.max(CheckIn.date)).where(CheckIn.patient_id == p.id))
    return {"id": p.id, "mrn": p.mrn, "name": p.name, "age": age(p.date_of_birth), "sex": p.sex,
            "genotype": p.genotype, "on_hydroxyurea": p.on_hydroxyurea, "crises_12m": p.crises_12m,
            "risk": {"score": a.score, "level": a.level, "at": a.created_at} if a else None,
            "last_checkin": last.isoformat() if last else None,
            "red_flags": [f["label"] for f in (a.red_flags if a else [])]}


async def patient_out(s: AsyncSession, p: Patient) -> dict:
    return {**await patient_row(s, p), "date_of_birth": p.date_of_birth, "phone": p.phone,
            "hb_baseline": p.hb_baseline, "hbf_percent": p.hbf_percent, "care_team": p.care_team,
            "notes": p.notes, "created_at": p.created_at}


def checkin_out(c: CheckIn) -> dict:
    return {k: getattr(c, k) for k in ("id", "patient_id", "date", "pain", "hydration_litres", "sleep_hours",
                                       "stress", "temperature_c", "spo2", "cold_exposure", "infection_symptoms",
                                       "chest_symptoms", "neuro_symptoms", "menstruating", "alcohol",
                                       "strenuous_activity", "hydroxyurea_taken", "hb", "wbc", "retic_percent",
                                       "ldh", "notes", "created_at")}


def crisis_out(c: Crisis) -> dict:
    return {"id": c.id, "patient_id": c.patient_id, "date": c.date, "severity": c.severity,
            "hospitalised": c.hospitalised, "notes": c.notes}


async def find_patient(s: AsyncSession, ref: str) -> Optional[Patient]:
    """By id, MRN or (part of) name."""
    ref = (ref or "").strip()
    if not ref:
        return None
    p = await s.get(Patient, ref)
    if p:
        return p
    p = await s.scalar(select(Patient).where(func.lower(Patient.mrn) == ref.lower()))
    if p:
        return p
    return await s.scalar(select(Patient).where(Patient.name.ilike(f"%{ref}%")).limit(1))
