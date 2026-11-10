"""Database tables (SQLAlchemy 2, async). Postgres when deployed, SQLite in tests."""
import uuid
from datetime import date, datetime, timezone
from typing import AsyncIterator, Optional

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.config import get_settings


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(200), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), default="clinician")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Patient(Base):
    __tablename__ = "patients"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    mrn: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    date_of_birth: Mapped[date] = mapped_column(Date)
    sex: Mapped[str] = mapped_column(String(1))
    genotype: Mapped[str] = mapped_column(String(10))
    on_hydroxyurea: Mapped[bool] = mapped_column(Boolean, default=False)
    hb_baseline: Mapped[float] = mapped_column(Float)
    hbf_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    crises_12m: Mapped[int] = mapped_column(Integer, default=0)
    phone: Mapped[str] = mapped_column(String(40), default="")
    care_team: Mapped[str] = mapped_column(String(200), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CheckIn(Base):
    __tablename__ = "checkins"
    __table_args__ = (UniqueConstraint("patient_id", "date"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date)
    pain: Mapped[int] = mapped_column(Integer, default=0)
    hydration_litres: Mapped[float] = mapped_column(Float, default=2.0)
    sleep_hours: Mapped[float] = mapped_column(Float, default=7.0)
    stress: Mapped[int] = mapped_column(Integer, default=3)
    temperature_c: Mapped[float] = mapped_column(Float, default=36.8)
    spo2: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cold_exposure: Mapped[bool] = mapped_column(Boolean, default=False)
    infection_symptoms: Mapped[bool] = mapped_column(Boolean, default=False)
    chest_symptoms: Mapped[bool] = mapped_column(Boolean, default=False)
    neuro_symptoms: Mapped[bool] = mapped_column(Boolean, default=False)
    menstruating: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    alcohol: Mapped[bool] = mapped_column(Boolean, default=False)
    strenuous_activity: Mapped[bool] = mapped_column(Boolean, default=False)
    hydroxyurea_taken: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    hb: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    wbc: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    retic_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    ldh: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Crisis(Base):
    __tablename__ = "crises"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date)
    severity: Mapped[str] = mapped_column(String(10), default="moderate")
    hospitalised: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Assessment(Base):
    __tablename__ = "assessments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10), default="checkin")
    for_date: Mapped[date] = mapped_column(Date)
    score: Mapped[float] = mapped_column(Float)
    level: Mapped[str] = mapped_column(String(10))
    probability: Mapped[float] = mapped_column(Float)
    factors: Mapped[list] = mapped_column(JSON, default=list)
    red_flags: Mapped[list] = mapped_column(JSON, default=list)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    plan: Mapped[list] = mapped_column(JSON, default=list)
    sources: Mapped[list] = mapped_column(JSON, default=list)
    model_version: Mapped[str] = mapped_column(String(40), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id", ondelete="CASCADE"), index=True)
    level: Mapped[str] = mapped_column(String(10))
    score: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open")
    acknowledged_by: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(300))
    filename: Mapped[str] = mapped_column(String(300), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    chunks: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Chunk(Base):
    """Guidance passages (also kept here so search still works by keywords without an OpenAI key)."""
    __tablename__ = "chunks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    text: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)


class Thread(Base):
    __tablename__ = "threads"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    patient_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    title: Mapped[str] = mapped_column(String(200), default="New conversation")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Notification(Base):
    """Messages the assistant sent to the care team (MCP tool notify_care_team)."""
    __tablename__ = "notifications"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    patient_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


_engine = None
_maker: Optional[async_sessionmaker[AsyncSession]] = None


def engine():
    global _engine, _maker
    if _engine is None:
        _engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
        _maker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def open_session() -> AsyncSession:
    engine()
    return _maker()


async def get_session() -> AsyncIterator[AsyncSession]:
    async with open_session() as s:
        yield s


async def create_tables() -> None:
    async with engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def dispose() -> None:
    global _engine, _maker
    if _engine is not None:
        await _engine.dispose()
    _engine, _maker = None, None
