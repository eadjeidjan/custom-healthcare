"""Demo data: 12 fictional patients with 60 days of check-ins, some crises, and an assessment per day so the trend
charts have history. Runs once on an empty database (SEED_DEMO=true). All names are invented."""
import random
from datetime import date, timedelta

from sqlalchemy import func, select

from app import care, risk
from app.db import Assessment, CheckIn, Crisis, Patient, open_session

PATIENTS = [
    # name, sex, age, genotype, hydroxyurea, Hb baseline, HbF, crises 12m, story
    ("Ama Owusu", "F", 24, "HbSS", True, 8.2, 9.0, 3, "rising"),
    ("Kwame Mensah", "M", 31, "HbSS", False, 7.6, 4.0, 5, "critical"),
    ("Efua Asante", "F", 19, "HbSβ0", True, 8.0, 12.0, 2, "steady"),
    ("Kofi Boateng", "M", 42, "HbSC", False, 10.8, 3.0, 1, "steady"),
    ("Abena Darko", "F", 28, "HbSS", True, 7.9, 15.0, 1, "good"),
    ("Yaw Adjei", "M", 16, "HbSS", True, 8.4, 11.0, 4, "nonadherent"),
    ("Akosua Frimpong", "F", 35, "HbSβ+", False, 10.2, 5.0, 0, "good"),
    ("Kojo Appiah", "M", 22, "HbSS", False, 7.8, 6.0, 6, "rising"),
    ("Adwoa Ofori", "F", 27, "HbSC", False, 11.0, None, 1, "cold"),
    ("Kwabena Amoah", "M", 38, "HbSS", True, 8.6, 18.0, 0, "good"),
    ("Esi Quaye", "F", 21, "HbSS", True, 8.1, 8.0, 2, "fever"),
    ("Nana Agyeman", "M", 29, "HbSβ0", False, 7.9, 5.0, 3, "steady"),
]
DAYS = 60


def _day(r: random.Random, story: str, i: int, sex: str, hu: bool, hb0: float) -> dict:
    """i = days ago (0 = today)."""
    bad = {"rising": i < 5, "critical": i < 4, "nonadherent": i < 10, "cold": i < 3, "fever": i < 2}.get(story, False)
    if story == "steady" and r.random() < 0.08:
        bad = True
    d = dict(pain=max(0, min(10, round(r.gauss(4.5 if bad else 1.2, 1.3)))),
             hydration_litres=round(max(0.6, r.gauss(1.5 if bad else 2.6, 0.35)), 1),
             sleep_hours=round(max(3, r.gauss(5.4 if bad else 7.3, 0.7)), 1),
             stress=max(0, min(10, round(r.gauss(6 if bad else 3, 1.4)))),
             temperature_c=round(r.gauss(37.1 if bad else 36.7, 0.2), 1),
             spo2=round(min(100, r.gauss(94 if bad else 97, 1.0))),
             cold_exposure=bad and r.random() < (0.9 if story == "cold" else 0.4),
             infection_symptoms=bad and r.random() < (0.9 if story == "fever" else 0.2),
             menstruating=(r.random() < 0.15) if sex == "F" else None,
             alcohol=r.random() < (0.25 if bad else 0.05),
             strenuous_activity=r.random() < (0.3 if bad else 0.1),
             hydroxyurea_taken=(r.random() > (0.6 if story == "nonadherent" and bad else 0.05)) if hu else None)
    if i % 14 == 0 or (bad and i % 3 == 0):
        d.update(hb=round(hb0 - (r.uniform(0.6, 1.6) if bad else r.uniform(-0.3, 0.4)), 1),
                 wbc=round(r.gauss(13.5 if bad else 10, 1.2), 1), retic_percent=round(r.gauss(13 if bad else 9, 2), 1),
                 ldh=round(r.gauss(620 if bad else 420, 60)))
    if story == "critical" and i == 0:
        d.update(pain=8, temperature_c=38.7, infection_symptoms=True, chest_symptoms=True, spo2=91)
    if story == "fever" and i == 0:
        d.update(temperature_c=38.6, pain=5)
    return d


async def seed() -> bool:
    async with open_session() as s:
        if await s.scalar(select(func.count()).select_from(Patient)):
            return False
        r = random.Random(42)
        today = date.today()
        teams = ["Haematology A (Dr. Owusu-Ansah)", "Haematology B (Dr. Tetteh)"]
        for n, (name, sex, age, gt, hu, hb0, hbf, c12, story) in enumerate(PATIENTS):
            p = Patient(mrn=f"KBTH-{10231 + n * 17}", name=name, sex=sex, genotype=gt, on_hydroxyurea=hu,
                        date_of_birth=today.replace(year=today.year - age) - timedelta(days=r.randint(10, 300)),
                        hb_baseline=hb0, hbf_percent=hbf, crises_12m=c12, phone=f"+233 24 {r.randint(100, 999)} "
                        f"{r.randint(1000, 9999)}", care_team=teams[n % 2],
                        notes="Fictional demo patient.")
            s.add(p)
            await s.flush()
            profile = risk.Profile.of(p)
            history: list[risk.Day] = []
            for i in range(DAYS - 1, -1, -1):
                day = today - timedelta(days=i)
                if r.random() < 0.12 and i > 2:   # some missed check-ins
                    continue
                values = _day(r, story, i, sex, hu, hb0)
                s.add(CheckIn(patient_id=p.id, date=day, **values))
                history.insert(0, risk.Day(date=day, **values))
                if i > 0:
                    window = [h for h in history if (day - h.date).days < 14]
                    res = risk.assess(profile, window) if i > 2 else None
                    if res:
                        s.add(Assessment(patient_id=p.id, kind="checkin", for_date=day, score=res.score,
                                         level=res.level if not res.red_flags else res.level,
                                         probability=res.probability, factors=res.factors, red_flags=[],
                                         plan=care.rule_plan(res), sources=[], model_version=res.model_version,
                                         created_at=_at(day)))
            for k in range(min(c12, 3)):
                s.add(Crisis(patient_id=p.id, date=today - timedelta(days=r.randint(8, DAYS - 1)),
                             severity=r.choice(["mild", "moderate", "severe"]), hospitalised=r.random() < 0.4,
                             notes="Demo event"))
            await s.flush()
            res = await care.score_patient(s, p)
            await care.save_assessment(s, p, res, "checkin")
        await s.commit()
    return True


def _at(day: date):
    from datetime import datetime, time, timezone
    return datetime.combine(day, time(8, 30), tzinfo=timezone.utc)
