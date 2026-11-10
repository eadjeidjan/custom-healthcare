"""Patients, daily check-ins, crisis events and risk assessments."""
from datetime import date, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import care, pipeline
from app.db import Assessment, CheckIn, Crisis, Patient, User, get_session
from app.security import current_user

router = APIRouter()
Genotype = Literal["HbSS", "HbSC", "HbSβ0", "HbSβ+"]


async def _patient(session: AsyncSession, pid: str) -> Patient:
    p = await session.get(Patient, pid)
    if p is None:
        raise HTTPException(404, "No such patient.")
    return p


class PatientIn(BaseModel):
    mrn: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=200)
    date_of_birth: date
    sex: Literal["F", "M"]
    genotype: Genotype
    on_hydroxyurea: bool = False
    hb_baseline: float = Field(ge=4, le=16)
    hbf_percent: Optional[float] = Field(default=None, ge=0, le=100)
    phone: str = ""
    care_team: str = ""
    notes: str = ""
    crises_12m: int = Field(default=0, ge=0, le=50)


class PatientPatch(BaseModel):
    mrn: Optional[str] = None
    name: Optional[str] = None
    date_of_birth: Optional[date] = None
    sex: Optional[Literal["F", "M"]] = None
    genotype: Optional[Genotype] = None
    on_hydroxyurea: Optional[bool] = None
    hb_baseline: Optional[float] = Field(default=None, ge=4, le=16)
    hbf_percent: Optional[float] = Field(default=None, ge=0, le=100)
    phone: Optional[str] = None
    care_team: Optional[str] = None
    notes: Optional[str] = None
    crises_12m: Optional[int] = Field(default=None, ge=0, le=50)


@router.get("/patients")
async def list_patients(q: str = "", level: str = "", _: User = Depends(current_user),
                        session: AsyncSession = Depends(get_session)):
    stmt = select(Patient)
    if q:
        stmt = stmt.where(Patient.name.ilike(f"%{q}%") | Patient.mrn.ilike(f"%{q}%"))
    rows = [await care.patient_row(session, p) for p in (await session.scalars(stmt)).all()]
    if level:
        rows = [r for r in rows if r["risk"] and r["risk"]["level"] == level]
    rows.sort(key=lambda r: r["risk"]["score"] if r["risk"] else -1, reverse=True)
    return rows


@router.post("/patients")
async def create_patient(body: PatientIn, _: User = Depends(current_user),
                         session: AsyncSession = Depends(get_session)):
    if await session.scalar(select(Patient).where(Patient.mrn == body.mrn.strip())):
        raise HTTPException(409, "A patient with this MRN already exists.")
    p = Patient(**body.model_dump())
    session.add(p)
    await session.commit()
    return await care.patient_out(session, p)


@router.get("/patients/{pid}")
async def get_patient(pid: str, _: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await care.patient_out(session, await _patient(session, pid))


@router.patch("/patients/{pid}")
async def patch_patient(pid: str, body: PatientPatch, _: User = Depends(current_user),
                        session: AsyncSession = Depends(get_session)):
    p = await _patient(session, pid)
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(p, k, v)
    await session.commit()
    return await care.patient_out(session, p)


class CheckInIn(BaseModel):
    date: Optional[date] = None
    pain: int = Field(default=0, ge=0, le=10)
    hydration_litres: float = Field(default=2.0, ge=0, le=10)
    sleep_hours: float = Field(default=7.0, ge=0, le=24)
    stress: int = Field(default=3, ge=0, le=10)
    temperature_c: float = Field(default=36.8, ge=33, le=43)
    spo2: Optional[float] = Field(default=None, ge=50, le=100)
    cold_exposure: bool = False
    infection_symptoms: bool = False
    chest_symptoms: bool = False
    neuro_symptoms: bool = False
    menstruating: Optional[bool] = None
    alcohol: bool = False
    strenuous_activity: bool = False
    hydroxyurea_taken: Optional[bool] = None
    hb: Optional[float] = Field(default=None, ge=2, le=20)
    wbc: Optional[float] = Field(default=None, ge=0, le=100)
    retic_percent: Optional[float] = Field(default=None, ge=0, le=60)
    ldh: Optional[float] = Field(default=None, ge=0, le=5000)
    notes: str = ""


@router.get("/patients/{pid}/checkins")
async def list_checkins(pid: str, days: int = 30, _: User = Depends(current_user),
                        session: AsyncSession = Depends(get_session)):
    await _patient(session, pid)
    return [care.checkin_out(c) for c in await care.recent_days(session, pid, max(1, min(days, 365)))]


@router.post("/patients/{pid}/checkins")
async def add_checkin(pid: str, body: CheckInIn, _: User = Depends(current_user),
                      session: AsyncSession = Depends(get_session)):
    p = await _patient(session, pid)
    values = body.model_dump()
    day = values.pop("date") or date.today()
    if day > date.today():
        raise HTTPException(422, "A check-in can't be in the future.")
    c = await session.scalar(select(CheckIn).where(CheckIn.patient_id == pid, CheckIn.date == day))
    if c is None:
        c = CheckIn(patient_id=pid, date=day)
        session.add(c)
    for k, v in values.items():
        setattr(c, k, v)
    await session.flush()
    result = await care.score_patient(session, p)
    a = await care.save_assessment(session, p, result, "checkin")
    return {"checkin": care.checkin_out(c), "assessment": care.assessment_out(a)}


class CrisisIn(BaseModel):
    date: date
    severity: Literal["mild", "moderate", "severe"] = "moderate"
    hospitalised: bool = False
    notes: str = ""


@router.get("/patients/{pid}/crises")
async def list_crises(pid: str, _: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    await _patient(session, pid)
    rows = await session.scalars(select(Crisis).where(Crisis.patient_id == pid).order_by(Crisis.date.desc()))
    return [care.crisis_out(c) for c in rows]


@router.post("/patients/{pid}/crises")
async def add_crisis(pid: str, body: CrisisIn, _: User = Depends(current_user),
                     session: AsyncSession = Depends(get_session)):
    await _patient(session, pid)
    c = Crisis(patient_id=pid, **body.model_dump())
    session.add(c)
    await session.commit()
    return care.crisis_out(c)


@router.get("/patients/{pid}/assessments")
async def list_assessments(pid: str, days: int = 60, _: User = Depends(current_user),
                           session: AsyncSession = Depends(get_session)):
    await _patient(session, pid)
    since = date.today() - timedelta(days=max(1, min(days, 365)))
    rows = await session.scalars(select(Assessment).where(Assessment.patient_id == pid, Assessment.for_date >= since)
                                 .order_by(Assessment.created_at.desc()))
    return [care.assessment_out(a) for a in rows]


@router.post("/patients/{pid}/assess")
async def assess(pid: str, _: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    await _patient(session, pid)
    state = await pipeline.run(pid)
    if state.get("error"):
        raise HTTPException(404, state["error"])
    return state["assessment"]
