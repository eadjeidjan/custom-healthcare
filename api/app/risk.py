"""The VOC risk model.

1. `features()` turns a patient and their recent daily check-ins into numbers (hydration deficit, fever, missed
   hydroxyurea, Hb drop from baseline, ...).
2. A logistic regression (scikit-learn) gives the probability of a vaso-occlusive crisis in the next 7 days. It is
   trained on a synthetic cohort whose risk follows published triggers and markers; swap in real outcome data
   (the `crises` table) to retrain before any clinical use.
3. `explain()` says how many score points each factor adds or removes (risk now minus risk with that factor normal).
4. `red_flags()` are fixed safety rules that do not depend on the model: they always win.
"""
import threading
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Optional, Sequence

import joblib
import numpy as np

MODEL_VERSION = "voc-lr-1.0"
MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "voc_model.joblib"
THRESHOLDS = {"moderate": 0.10, "high": 0.25, "critical": 0.50}

# key, label, description, the "normal" value used to explain impact, and the synthetic cohort's true weight
FEATURES: list[tuple[str, str, str, float, float]] = [
    ("pain", "Pain today", "Pain score 0-10 on the latest check-in", 0, 0.22),
    ("pain_trend", "Pain rising", "Latest pain minus the average of the 3 days before", 0, 0.18),
    ("low_hydration", "Low fluid intake", "Litres below 2.5 L a day (3-day average)", 0, 0.70),
    ("short_sleep", "Short sleep", "Hours below 7 a night (3-day average)", 0, 0.18),
    ("stress", "Stress", "Stress 0-10 (3-day average)", 2, 0.08),
    ("fever", "Raised temperature", "Degrees above 37.5 °C", 0, 0.90),
    ("low_spo2", "Low oxygen", "SpO2 points below 95 %", 0, 0.25),
    ("cold", "Cold exposure", "Cold or wind exposure in the last 3 days", 0, 0.60),
    ("infection", "Infection symptoms", "Infection symptoms in the last 3 days", 0, 0.80),
    ("menstruating", "Menstruation", "Menstruating on the latest check-in", 0, 0.35),
    ("alcohol", "Alcohol", "Alcohol in the last 3 days", 0, 0.40),
    ("exertion", "Strenuous activity", "Strenuous activity in the last 3 days", 0, 0.35),
    ("missed_hu", "Missed hydroxyurea", "Share of the last 7 days hydroxyurea was missed (if prescribed)", 0, 1.00),
    ("hb_drop", "Hb below baseline", "g/dL below the patient's baseline haemoglobin", 0, 0.35),
    ("high_wbc", "High white cells", "WBC above 11 x10^9/L", 0, 0.12),
    ("high_retic", "High reticulocytes", "Reticulocytes above 12 %", 0, 0.06),
    ("high_ldh", "High LDH", "LDH above 500 U/L, per 100", 0, 0.30),
    ("prior_crises", "Crises in last 12 months", "Number of VOCs in the last 12 months (max 12)", 0, 0.15),
    ("severe_genotype", "Severe genotype", "HbSS or HbSβ0", 0, 0.50),
    ("low_hbf", "Low foetal haemoglobin", "How far HbF is below 10 % (0-1; unknown counts as 0.5)", 0, 0.60),
    ("on_hu", "On hydroxyurea", "Prescribed hydroxyurea (protective)", 0, -0.50),
]
KEYS = [f[0] for f in FEATURES]
LABELS = {f[0]: f[1] for f in FEATURES}
NORMAL = np.array([f[3] for f in FEATURES], dtype=float)
TRUE_W = np.array([f[4] for f in FEATURES], dtype=float)
TRUE_B = -6.0


@dataclass
class Day:
    """One check-in as the model sees it (works for ORM rows and plain dicts)."""
    date: date
    pain: float = 0
    hydration_litres: float = 2.5
    sleep_hours: float = 7
    stress: float = 2
    temperature_c: float = 36.8
    spo2: Optional[float] = None
    cold_exposure: bool = False
    infection_symptoms: bool = False
    chest_symptoms: bool = False
    neuro_symptoms: bool = False
    menstruating: Optional[bool] = None
    alcohol: bool = False
    strenuous_activity: bool = False
    hydroxyurea_taken: Optional[bool] = None
    hb: Optional[float] = None
    wbc: Optional[float] = None
    retic_percent: Optional[float] = None
    ldh: Optional[float] = None

    @classmethod
    def of(cls, row) -> "Day":
        get = (lambda k: row.get(k)) if isinstance(row, dict) else (lambda k: getattr(row, k, None))
        vals = {k: get(k) for k in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in vals.items() if v is not None})


@dataclass
class Profile:
    genotype: str
    on_hydroxyurea: bool
    hb_baseline: float
    hbf_percent: Optional[float]
    crises_12m: int

    @classmethod
    def of(cls, p) -> "Profile":
        return cls(p.genotype, bool(p.on_hydroxyurea), float(p.hb_baseline), p.hbf_percent, int(p.crises_12m or 0))


def _latest(days: Sequence[Day], attr: str, within: int = 14):
    if not days:
        return None
    ref = days[0].date
    for d in days:
        v = getattr(d, attr)
        if v is not None and (ref - d.date).days <= within:
            return v
    return None


def features(profile: Profile, days: Sequence[Day]) -> np.ndarray:
    """`days` newest first. Returns the vector in FEATURES order."""
    days = sorted(days, key=lambda d: d.date, reverse=True)
    if not days:
        days = [Day(date=date.today())]
    t = days[0]
    last3 = days[:3]
    prev3 = days[1:4]
    pain_trend = t.pain - mean(d.pain for d in prev3) if prev3 else 0.0
    hu = 0.0
    if profile.on_hydroxyurea:
        known = [d.hydroxyurea_taken for d in days[:7] if d.hydroxyurea_taken is not None]
        hu = (sum(1 for k in known if not k) / len(known)) if known else 0.0
    hb, wbc, retic, ldh = (_latest(days, a) for a in ("hb", "wbc", "retic_percent", "ldh"))
    hbf = profile.hbf_percent
    f = {
        "pain": t.pain,
        "pain_trend": max(-5.0, min(8.0, pain_trend)),
        "low_hydration": max(0.0, 2.5 - mean(d.hydration_litres for d in last3)),
        "short_sleep": max(0.0, 7 - mean(d.sleep_hours for d in last3)),
        "stress": mean(d.stress for d in last3),
        "fever": max(0.0, t.temperature_c - 37.5),
        "low_spo2": max(0.0, 95 - t.spo2) if t.spo2 is not None else 0.0,
        "cold": float(any(d.cold_exposure for d in last3)),
        "infection": float(any(d.infection_symptoms for d in last3)),
        "menstruating": float(bool(t.menstruating)),
        "alcohol": float(any(d.alcohol for d in last3)),
        "exertion": float(any(d.strenuous_activity for d in last3)),
        "missed_hu": hu,
        "hb_drop": max(0.0, profile.hb_baseline - hb) if hb is not None else 0.0,
        "high_wbc": max(0.0, wbc - 11) if wbc is not None else 0.0,
        "high_retic": max(0.0, retic - 12) if retic is not None else 0.0,
        "high_ldh": max(0.0, ldh - 500) / 100 if ldh is not None else 0.0,
        "prior_crises": float(min(12, profile.crises_12m)),
        "severe_genotype": float(profile.genotype in ("HbSS", "HbSβ0")),
        "low_hbf": 0.5 if hbf is None else max(0.0, min(1.0, (10 - hbf) / 10)),
        "on_hu": float(profile.on_hydroxyurea),
    }
    return np.array([f[k] for k in KEYS], dtype=float)


# ---------- synthetic cohort and training ----------

def synthetic_cohort(n: int = 24000, seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    """Rows of plausible patient-days; the label is drawn from a known risk function so the model's job is real
    (noisy, imbalanced) but the truth is documented."""
    r = np.random.default_rng(seed)
    severe = r.random(n) < 0.65
    on_hu = r.random(n) < np.where(severe, 0.6, 0.25)
    risky_day = r.random(n) < 0.25          # some days are bad days: several triggers together
    X = np.zeros((n, len(KEYS)))
    col = {k: i for i, k in enumerate(KEYS)}
    X[:, col["pain"]] = np.clip(r.poisson(np.where(risky_day, 3.5, 1.2)), 0, 10)
    X[:, col["pain_trend"]] = np.clip(r.normal(np.where(risky_day, 1.5, 0), 1.3), -5, 8)
    X[:, col["low_hydration"]] = np.clip(r.normal(np.where(risky_day, 0.9, 0.2), 0.45), 0, 2.5)
    X[:, col["short_sleep"]] = np.clip(r.normal(np.where(risky_day, 1.8, 0.5), 1.0), 0, 6)
    X[:, col["stress"]] = np.clip(r.normal(np.where(risky_day, 5.5, 3), 1.8), 0, 10)
    fever = r.random(n) < np.where(risky_day, 0.15, 0.02)
    X[:, col["fever"]] = np.where(fever, r.uniform(0.3, 2.0, n), 0)
    X[:, col["low_spo2"]] = np.clip(r.normal(np.where(severe, 1.5, 0.3), 1.2), 0, 10)
    X[:, col["cold"]] = r.random(n) < np.where(risky_day, 0.35, 0.08)
    X[:, col["infection"]] = r.random(n) < np.where(risky_day, 0.3, 0.05)
    X[:, col["menstruating"]] = r.random(n) < 0.08
    X[:, col["alcohol"]] = r.random(n) < np.where(risky_day, 0.2, 0.06)
    X[:, col["exertion"]] = r.random(n) < np.where(risky_day, 0.3, 0.1)
    X[:, col["missed_hu"]] = np.where(on_hu, np.clip(r.beta(1.2, np.where(risky_day, 2.5, 6.0)), 0, 1), 0)
    X[:, col["hb_drop"]] = np.clip(r.normal(np.where(risky_day, 0.8, 0.1), 0.6), 0, 4)
    X[:, col["high_wbc"]] = np.clip(r.normal(np.where(severe, 1.5, 0.3), 1.5), 0, 10)
    X[:, col["high_retic"]] = np.clip(r.normal(np.where(severe, 2, 0.5), 2), 0, 15)
    X[:, col["high_ldh"]] = np.clip(r.normal(np.where(severe, 1.2, 0.3), 1.0), 0, 6)
    X[:, col["prior_crises"]] = np.clip(r.poisson(np.where(severe, 2.2, 0.8)), 0, 12)
    X[:, col["severe_genotype"]] = severe
    X[:, col["low_hbf"]] = np.clip(r.normal(np.where(on_hu, 0.45, 0.75), 0.2), 0, 1)
    X[:, col["on_hu"]] = on_hu
    logit = TRUE_B + X @ TRUE_W + r.normal(0, 0.6, n)
    y = (r.random(n) < 1 / (1 + np.exp(-logit))).astype(int)
    return X, y


_lock = threading.Lock()
_bundle: Optional[dict] = None


def train(path: Path = MODEL_PATH) -> dict:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss, roc_auc_score
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    X, y = synthetic_cohort()
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=7, stratify=y)
    pipe = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))
    pipe.fit(Xtr, ytr)
    p = pipe.predict_proba(Xte)[:, 1]
    lr = pipe[-1]
    scale = pipe[0].scale_
    bundle = {
        "pipe": pipe, "version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "training_rows": int(len(Xtr)), "positive_rate": round(float(y.mean()), 3),
        "auc": round(float(roc_auc_score(yte, p)), 3), "brier": round(float(brier_score_loss(yte, p)), 4),
        "weights": {k: round(float(c / s), 4) for k, c, s in zip(KEYS, lr.coef_[0], scale)},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, path)
    return bundle


def model() -> dict:
    global _bundle
    with _lock:
        if _bundle is None:
            try:
                b = joblib.load(MODEL_PATH)
                _bundle = b if b.get("version") == MODEL_VERSION else train()
            except Exception:  # noqa: BLE001 - missing or unreadable: train a fresh one (about a second)
                _bundle = train()
        return _bundle


def probability(x: np.ndarray) -> float:
    return float(model()["pipe"].predict_proba(x.reshape(1, -1))[0, 1])


def level_for(p: float) -> str:
    if p >= THRESHOLDS["critical"]:
        return "critical"
    if p >= THRESHOLDS["high"]:
        return "high"
    if p >= THRESHOLDS["moderate"]:
        return "moderate"
    return "low"


def _fmt(key: str, v: float, profile: Profile, days: Sequence[Day]) -> str:
    t = days[0] if days else None
    match key:
        case "pain": return f"{v:.0f}/10"
        case "pain_trend": return f"{v:+.1f} vs previous days"
        case "low_hydration": return f"{2.5 - v:.1f} L/day"
        case "short_sleep": return f"{7 - v:.1f} h/night"
        case "stress": return f"{v:.0f}/10"
        case "fever": return f"{t.temperature_c:.1f} °C" if t else f"+{v:.1f} °C"
        case "low_spo2": return f"{95 - v:.0f} %"
        case "missed_hu": return f"missed {v:.0%} of days"
        case "hb_drop": return f"{v:.1f} g/dL below baseline {profile.hb_baseline:g}"
        case "high_wbc": return f"{v + 11:.1f} x10⁹/L"
        case "high_retic": return f"{v + 12:.1f} %"
        case "high_ldh": return f"{v * 100 + 500:.0f} U/L"
        case "prior_crises": return f"{v:.0f}"
        case "severe_genotype": return profile.genotype
        case "low_hbf": return "unknown" if profile.hbf_percent is None else f"HbF {profile.hbf_percent:g} %"
        case _: return "yes" if v else "no"


def explain(x: np.ndarray, profile: Profile, days: Sequence[Day], top: int = 7) -> list[dict]:
    base = probability(x)
    out = []
    for i, key in enumerate(KEYS):
        if x[i] == NORMAL[i]:
            continue
        alt = x.copy()
        alt[i] = NORMAL[i]
        impact = round((base - probability(alt)) * 100, 1)
        if abs(impact) < 0.5:
            continue
        out.append({"key": key, "label": LABELS[key], "value": _fmt(key, x[i], profile, days),
                    "impact": impact, "direction": "up" if impact > 0 else "down"})
    out.sort(key=lambda f: abs(f["impact"]), reverse=True)
    return out[:top]


# ---------- safety rules ----------

EMERGENCY = "Seek emergency care now (call the care team / go to the emergency department)."


def red_flags(profile: Profile, days: Sequence[Day]) -> list[dict]:
    """Rules from sickle cell guidance. They don't depend on the model and always override it."""
    days = sorted(days, key=lambda d: d.date, reverse=True)
    if not days or (date.today() - days[0].date).days > 2:
        return []
    t = days[0]
    flags = []
    if t.temperature_c >= 38.5:
        flags.append({"key": "fever", "label": f"Fever {t.temperature_c:.1f} °C",
                      "action": "Fever in sickle cell disease is an emergency (infection risk). " + EMERGENCY,
                      "critical": True})
    if t.chest_symptoms:
        flags.append({"key": "chest", "label": "Chest pain or breathing difficulty (possible acute chest syndrome)",
                      "action": EMERGENCY, "critical": True})
    if t.neuro_symptoms:
        flags.append({"key": "neuro", "label": "Stroke-like symptoms (weakness, speech, face, severe headache)",
                      "action": "Call emergency services immediately (possible stroke).", "critical": True})
    if t.spo2 is not None and t.spo2 < 92:
        flags.append({"key": "spo2", "label": f"Oxygen saturation {t.spo2:.0f} %",
                      "action": EMERGENCY, "critical": True})
    hb = _latest(days, "hb", within=2)
    if hb is not None and profile.hb_baseline - hb >= 2:
        flags.append({"key": "hb_fall", "label": f"Hb {hb:g} g/dL, ≥2 below baseline {profile.hb_baseline:g}",
                      "action": "Same-day medical review (possible aplastic crisis or splenic sequestration).",
                      "critical": False})
    if t.pain >= 8:
        flags.append({"key": "severe_pain", "label": f"Severe pain {t.pain:.0f}/10",
                      "action": "Follow the personal pain plan and contact the care team today; go to hospital if "
                                "pain is not controlled at home.", "critical": False})
    return flags


@dataclass
class Result:
    probability: float
    score: float
    level: str
    factors: list[dict]
    red_flags: list[dict]
    model_version: str


def assess(profile: Profile, days: Sequence[Day]) -> Result:
    days = sorted(days, key=lambda d: d.date, reverse=True)
    x = features(profile, days)
    p = probability(x)
    level = level_for(p)
    flags = red_flags(profile, days)
    if any(f["critical"] for f in flags):
        level = "critical"
    elif flags and level in ("low", "moderate"):
        level = "high"
    return Result(round(p, 4), round(p * 100, 1), level, explain(x, profile, days),
                  [{k: v for k, v in f.items() if k != "critical"} for f in flags], model()["version"])


def card() -> dict:
    m = model()
    return {
        "version": m["version"], "trained_at": m["trained_at"],
        "algorithm": "Logistic regression (scikit-learn) on standardised features; impact = risk now minus risk "
                     "with that factor at its normal value",
        "training_rows": m["training_rows"], "positive_rate": m["positive_rate"], "auc": m["auc"],
        "brier": m["brier"], "thresholds": THRESHOLDS,
        "features": [{"key": k, "label": lab, "weight": m["weights"][k], "description": desc}
                     for k, lab, desc, _, _ in FEATURES],
        "data_note": "Trained on a synthetic cohort of patient-days generated from published VOC triggers and "
                     "risk markers (dehydration, cold, infection, fever, hypoxia, stress, sleep, alcohol, exertion, "
                     "menstruation, hydroxyurea adherence, Hb, WBC, reticulocytes, LDH, HbF, genotype, crisis "
                     "history). Label: a VOC within the next 7 days.",
        "limitations": [
            "Synthetic training data: the numbers show how the system works, not real-world accuracy.",
            "Must be retrained and validated on real, consented patient outcomes before any clinical use.",
            "Self-reported check-ins can be missing or inaccurate; missing labs count as normal.",
            "Red-flag rules always override the model and must be reviewed by the clinical team.",
            "Not a medical device; supports, never replaces, clinical judgement.",
        ],
    }
