"""Sign-in, health, dashboard, alerts and the model card."""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import assistant, care, llm, rag, risk
from app.config import VERSION
from app.db import Alert, Assessment, CheckIn, Crisis, Patient, User, get_session, now
from app.security import check_password, current_user, make_token, user_out

router = APIRouter()


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
async def login(body: LoginIn, session: AsyncSession = Depends(get_session)):
    u = await session.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if u is None or not check_password(body.password, u.password_hash):
        raise HTTPException(401, "Wrong email or password.")
    return {"token": make_token(u), "user": user_out(u)}


@router.get("/me")
async def me(user: User = Depends(current_user)):
    return user_out(user)


@router.get("/health")
async def health():
    _, src = await assistant.tools()
    m = risk.model()
    return {"ok": True, "version": VERSION, "openai": llm.configured(), "qdrant": await rag.qdrant_ok(),
            "mcp": src == "mcp", "model": {"version": m["version"], "auc": m["auc"]}}


@router.get("/model")
async def model_card(_: User = Depends(current_user)):
    return risk.card()


@router.get("/dashboard")
async def dashboard(_: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    patients = (await session.scalars(select(Patient))).all()
    rows = [await care.patient_row(session, p) for p in patients]
    rows.sort(key=lambda r: r["risk"]["score"] if r["risk"] else -1, reverse=True)
    levels = {k: 0 for k in care.LEVEL_RANK}
    for r in rows:
        if r["risk"]:
            levels[r["risk"]["level"]] += 1
    today = date.today()
    since = today - timedelta(days=30)
    trend_rows = (await session.execute(
        select(Assessment.for_date, func.avg(Assessment.score),
               func.count(func.distinct(Assessment.patient_id)).filter(Assessment.level.in_(("high", "critical"))))
        .where(Assessment.for_date >= since).group_by(Assessment.for_date).order_by(Assessment.for_date))).all()
    return {
        "patients": len(rows), "levels": levels,
        "open_alerts": await session.scalar(select(func.count()).select_from(Alert).where(Alert.status == "open")),
        "checkins_today": await session.scalar(select(func.count()).select_from(CheckIn)
                                               .where(CheckIn.date == today)),
        "crises_30d": await session.scalar(select(func.count()).select_from(Crisis).where(Crisis.date >= since)),
        "watchlist": rows[:8],
        "trend": [{"date": d.isoformat(), "avg_score": round(float(a), 1), "high": int(h)} for d, a, h in trend_rows],
    }


def alert_out(a: Alert, name: str) -> dict:
    return {"id": a.id, "patient_id": a.patient_id, "patient_name": name, "created_at": a.created_at,
            "level": a.level, "score": a.score, "reason": a.reason, "status": a.status,
            "acknowledged_by": a.acknowledged_by, "acknowledged_at": a.acknowledged_at}


@router.get("/alerts")
async def alerts(status: str = "open", _: User = Depends(current_user),
                 session: AsyncSession = Depends(get_session)):
    q = select(Alert, Patient.name).join(Patient, Patient.id == Alert.patient_id).order_by(Alert.created_at.desc())
    if status in ("open", "acknowledged"):
        q = q.where(Alert.status == status)
    return [alert_out(a, n) for a, n in (await session.execute(q.limit(200))).all()]


class AckIn(BaseModel):
    note: Optional[str] = None


@router.post("/alerts/{alert_id}/ack")
async def ack(alert_id: str, body: AckIn, user: User = Depends(current_user),
              session: AsyncSession = Depends(get_session)):
    a = await session.get(Alert, alert_id)
    if a is None:
        raise HTTPException(404, "No such alert.")
    a.status, a.acknowledged_by, a.acknowledged_at, a.note = "acknowledged", user.name, now(), (body.note or "")[:1000]
    await session.commit()
    p = await session.get(Patient, a.patient_id)
    return alert_out(a, p.name)
