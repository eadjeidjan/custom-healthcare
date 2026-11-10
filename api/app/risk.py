"""The VOC risk model (v2).

1. `features.build()` turns everything known about a patient (check-ins, IoT device readings vs their own baseline,
   EMR labs, imaging findings, crisis history, profile) into one vector as of a date (see `app/features.py`).
2. A calibrated classifier (gradient boosting or logistic regression, chosen by `python -m app.train`) gives the
   probability of a vaso-occlusive crisis in the next 7 days. It is trained on a **synthetic** cohort from
   `app/simulator.py` (literature-calibrated); retrain on real outcomes (the `crises` table) before any clinical use.
3. `explain()` says how many score points each factor adds or removes (risk now minus risk with that factor at its
   normal value) - works for any model.
4. `red_flags()` are fixed safety rules (check-ins, thermometer, pulse oximeter, labs). They always win.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

import joblib
import numpy as np

from app import features as F
from app.units import temp

log = logging.getLogger("app.risk")
SCHEMA = 2                      # feature-vector schema; a saved model with another schema is retrained
MODEL_VERSION = "voc-gbm-2.0"   # default; the saved bundle carries the real version (voc-gbm-2.0 / voc-lr-2.0)
MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "voc_model.joblib"
# Probability of a crisis in the next 7 days. The simulated base rate is ~1.2 %, so "high" is >10x average.
THRESHOLDS = {"moderate": 0.04, "high": 0.10, "critical": 0.25}

FEATURES = F.FEATURES
KEYS = F.KEYS
LABELS = F.LABELS
NORMAL = F.NORMAL
LIMITATIONS = [
    "Synthetic training data: the numbers show how the system works, not real-world accuracy.",
    "Must be retrained and validated on real, consented patient outcomes before any clinical use.",
    "Pre-crisis changes in device signals are weakly evidenced (small pilots); the simulator assumes small 1-3 day "
    "drifts, so real device value may be lower.",
    "Self-reported check-ins can be missing or inaccurate; missing values count as normal (with a missing flag).",
    "Pulse oximeters can over-read SpO2 on darker skin; wrist skin temperature is not core temperature.",
    "Red-flag rules always override the model and must be reviewed by the clinical team.",
    "Not a medical device; supports, never replaces, clinical judgement.",
]


# ---------------------------------------------------------------------------------------------------------------
# Inputs kept for backwards compatibility (tests, simple callers): a profile plus daily check-ins
# ---------------------------------------------------------------------------------------------------------------
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
    date_of_birth: Optional[date] = None

    @classmethod
    def of(cls, p) -> "Profile":
        return cls(p.genotype, bool(p.on_hydroxyurea), float(p.hb_baseline), p.hbf_percent, int(p.crises_12m or 0),
                   getattr(p, "date_of_birth", None))


# ---------------------------------------------------------------------------------------------------------------
# Model objects (pickled in the bundle, so they live here)
# ---------------------------------------------------------------------------------------------------------------
class ColumnSubset:
    """Fit/predict an estimator on some columns only (ablations)."""

    def __init__(self, est, cols: list[int]):
        self.est, self.cols = est, list(cols)

    def fit(self, X, y):
        self.est.fit(X[:, self.cols], y)
        return self

    def predict_proba(self, X):
        return self.est.predict_proba(X[:, self.cols])


class SignedLogistic:
    """Logistic regression whose coefficients respect `features.DIRECTION`: features that come out with the wrong
    sign are dropped and the model refitted (a few rounds). Keeps explanations clinically coherent."""

    def __init__(self, directions: list[int], C: float = 0.3):
        self.directions, self.C = list(directions), C
        self.cols: list[int] = []
        self.pipe = None

    def fit(self, X, y):
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        cols = [j for j in range(X.shape[1]) if np.ptp(X[:, j]) > 0]
        for _ in range(6):
            pipe = make_pipeline(StandardScaler(), LogisticRegression(C=self.C, max_iter=3000)).fit(X[:, cols], y)
            coef = pipe[-1].coef_[0]
            bad = {c for c, w in zip(cols, coef) if self.directions[c] * w < 0}
            if not bad:
                break
            cols = [c for c in cols if c not in bad]
        self.cols, self.pipe = cols, pipe
        return self

    def predict_proba(self, X):
        return self.pipe.predict_proba(np.asarray(X)[:, self.cols])

    def weights(self) -> dict[int, float]:
        return {c: float(w / s) for c, w, s in zip(self.cols, self.pipe[-1].coef_[0], self.pipe[0].scale_)}


class CalibratedModel:
    """A fitted classifier plus a calibrator learned on separate (calibration) patients."""

    def __init__(self, base, method: str, cal):
        self.base, self.method, self.cal = base, method, cal

    @classmethod
    def fit(cls, base, raw: np.ndarray, y: np.ndarray, method: str) -> "CalibratedModel":
        if method == "isotonic":
            from sklearn.isotonic import IsotonicRegression
            cal = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw, y)
        else:
            from sklearn.linear_model import LogisticRegression
            cal = LogisticRegression(C=1e4, max_iter=1000).fit(_logit(raw).reshape(-1, 1), y)
        return cls(base, method, cal)

    def predict_proba(self, X) -> np.ndarray:
        raw = self.base.predict_proba(X)[:, 1]
        if self.method == "isotonic":
            p = self.cal.predict(raw)
        else:
            p = self.cal.predict_proba(_logit(raw).reshape(-1, 1))[:, 1]
        p = np.clip(p, 1e-4, 1 - 1e-4)
        return np.column_stack([1 - p, p])


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


# ---------------------------------------------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------------------------------------------
_lock = threading.Lock()
_bundle: Optional[dict] = None


def _compatible(b: dict) -> bool:
    return b.get("schema") == SCHEMA and b.get("keys") == list(KEYS) and "model" in b


def model() -> dict:
    """The saved model (fast). If there is none (or it is from an older feature schema), train a small one now
    (~10 s); `python -m app.train` gives the full model and the report."""
    global _bundle
    with _lock:
        if _bundle is None:
            b = None
            try:
                b = joblib.load(MODEL_PATH)
            except Exception:  # noqa: BLE001 - missing or unreadable
                b = None
            if not b or not _compatible(b):
                from app import train
                log.warning("No compatible saved VOC model: training a small one now (run `python -m app.train` "
                            "for the full model and docs/MODEL_REPORT.md).")
                b = train.quick(MODEL_PATH)
            _bundle = b
        return _bundle


def reload() -> dict:
    global _bundle
    with _lock:
        _bundle = None
    return model()


def probabilities(X: np.ndarray) -> np.ndarray:
    return model()["model"].predict_proba(np.asarray(X, dtype=float).reshape(-1, len(KEYS)))[:, 1]


def probability(x: np.ndarray) -> float:
    return float(probabilities(x.reshape(1, -1))[0])


def level_for(p: float) -> str:
    if p >= THRESHOLDS["critical"]:
        return "critical"
    if p >= THRESHOLDS["high"]:
        return "high"
    if p >= THRESHOLDS["moderate"]:
        return "moderate"
    return "low"


# ---------------------------------------------------------------------------------------------------------------
# Explanations
# ---------------------------------------------------------------------------------------------------------------
def _pair(info: dict, key: str, fmt: str) -> Optional[str]:
    v = info.get(key)
    if not v:
        return None
    return fmt.format(now=v[0], base=v[1])


def _fmt(key: str, v: float, fs: F.FeatureSet, patient: Any) -> str:
    i = fs.info
    s = None
    match key:
        case "pain": s = f"{v:.0f}/10"
        case "pain_trend": s = f"{v:+.1f} vs previous days"
        case "low_hydration": s = f"{i['hydration']:.1f} L/day" if "hydration" in i else None
        case "short_sleep": s = f"{i['sleep']:.1f} h/night" if "sleep" in i else None
        case "stress": s = f"{v:.0f}/10"
        case "fever": s = temp(i["temp"]) if "temp" in i else f"+{v:.1f} °C (+{v * 1.8:.1f} °F)"
        case "low_spo2": s = f"{i['spo2_now']:.0f} %" if "spo2_now" in i else None
        case "missed_hu": s = f"missed {v:.0%} of days"
        case "hr_rise": s = _pair(i, "hr", "{now:.0f} bpm (usual {base:.0f})")
        case "hrv_drop": s = _pair(i, "hrv", "{now:.0f} ms (usual {base:.0f})")
        case "spo2_drop": s = _pair(i, "spo2", "{now:.1f} % (usual {base:.1f})")
        case "spo2_night_low": s = f"lowest {i['spo2_min']:.0f} %" if "spo2_min" in i else None
        case "skin_temp_rise": s = f"+{v:.1f} °C (+{v * 1.8:.1f} °F) vs usual"
        case "steps_drop": s = _pair(i, "steps", "{now:,.0f} steps (usual {base:,.0f})")
        case "sleep_loss": s = _pair(i, "sleep_dev", "{now:.1f} h (usual {base:.1f})")
        case "fluid_drop": s = _pair(i, "fluid", "{now:.1f} L (usual {base:.1f})")
        case "resp_rise": s = _pair(i, "resp", "{now:.0f}/min (usual {base:.0f})")
        case "hb_drop":
            s = f"{v:.1f} g/dL below baseline {F.get(patient, 'hb_baseline', 0):g}"
        case "high_wbc": s = f"{i['wbc']:.1f} x10⁹/L" if "wbc" in i else None
        case "wbc_rise": s = f"{v:+.1f} x10⁹/L vs earlier results"
        case "high_retic": s = f"{i['retic']:.1f} %" if "retic" in i else None
        case "high_ldh": s = f"{i['ldh']:.0f} U/L" if "ldh" in i else None
        case "high_crp": s = f"{i['crp']:.0f} mg/L" if "crp" in i else None
        case "prior_crises": s = f"{v:.0f}"
        case "recent_crisis": s = f"crisis on {i['last_crisis']}" if "last_crisis" in i else "yes"
        case "severe_genotype": s = str(F.get(patient, "genotype", ""))
        case "low_hbf": s = "unknown" if i.get("hbf") is None else f"HbF {float(i['hbf']):g} %"
        case "tcd_risk": s = "abnormal" if v >= 2 else "conditional"
        case "on_hu": s = "yes" if v else "no"
    return s if s is not None else ("yes" if v else "no")


def explain(fs: F.FeatureSet, patient: Any, top: int = 7) -> list[dict]:
    """Impact of each non-normal factor in score points: risk now minus risk with that factor at its normal value
    (one batched prediction, so it is cheap for any model)."""
    x = fs.vector()
    idx = [i for i, k in enumerate(KEYS) if k in F.EXPLAIN and x[i] != NORMAL[i]]
    if not idx:
        return []
    X = np.repeat(x.reshape(1, -1), len(idx) + 1, axis=0)
    for row, i in enumerate(idx, start=1):
        X[row, i] = NORMAL[i]
    p = probabilities(X)
    out = []
    for row, i in enumerate(idx, start=1):
        impact = round(float(p[0] - p[row]) * 100, 1)
        if abs(impact) < 0.3:
            continue
        key = KEYS[i]
        out.append({"key": key, "label": LABELS[key], "value": _fmt(key, x[i], fs, patient), "impact": impact,
                    "direction": "up" if impact > 0 else "down"})
    out.sort(key=lambda f: abs(f["impact"]), reverse=True)
    return out[:top]


# ---------------------------------------------------------------------------------------------------------------
# Safety rules
# ---------------------------------------------------------------------------------------------------------------
EMERGENCY = "Seek emergency care now (call the care team / go to the emergency department)."
SPO2_SUSTAINED_MIN = 15
FEVER_C = 38.5


def _ts(v) -> datetime:
    if isinstance(v, str):
        v = datetime.fromisoformat(v)
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _sustained_low_spo2(readings: list, now: datetime) -> Optional[float]:
    """Lowest SpO2 of a run of consecutive oximeter readings < 92 % spanning >= 15 minutes in the last 24 h."""
    rows = sorted(((_ts(F.get(r, "ts")), float(F.get(r, "value"))) for r in readings
                   if F.get(r, "metric") == "spo2" and now - timedelta(hours=24) <= _ts(F.get(r, "ts")) <= now),
                  key=lambda t: t[0])
    run: list = []
    worst = None
    for ts, v in rows:
        if v < 92:
            run.append((ts, v))
            if (run[-1][0] - run[0][0]).total_seconds() >= SPO2_SUSTAINED_MIN * 60:
                low = min(x[1] for x in run)
                worst = low if worst is None else min(worst, low)
        else:
            run = []
    return worst


def red_flags(rec: F.Records, as_of: Optional[date] = None, now: Optional[datetime] = None) -> list[dict]:
    """Rules from sickle cell guidance. They don't depend on the model and always override it."""
    today = date.today()
    as_of = as_of or today
    if now is None:
        now = datetime.now(timezone.utc) if as_of >= today else datetime.combine(as_of, time(23, 59),
                                                                                    tzinfo=timezone.utc)
    p = rec.patient
    hb_base = float(F.get(p, "hb_baseline", 0) or 0)
    cis = rec.checkins_before(as_of, 1, within=2)
    t = cis[0] if cis else None
    device = [r for r in rec.raw_recent if now - timedelta(hours=24) <= _ts(F.get(r, "ts")) <= now]
    flags = []
    temp_c = float(F.get(t, "temperature_c", 0)) if t is not None else 0.0
    therm = [float(F.get(r, "value")) for r in device if F.get(r, "metric") == "body_temp_c"]
    fever_action = (f"Fever (temperature ≥ {temp(FEVER_C)}) in sickle cell disease is an emergency (infection "
                    "risk). " + EMERGENCY)
    if temp_c >= FEVER_C:
        flags.append({"key": "fever", "label": f"Fever {temp(temp_c)}", "action": fever_action, "critical": True})
    elif therm and max(therm) >= FEVER_C:
        flags.append({"key": "fever", "label": f"Fever {temp(max(therm))} (thermometer, last 24 h)",
                      "action": fever_action, "critical": True})
    if t is not None and F.get(t, "chest_symptoms", False):
        flags.append({"key": "chest", "label": "Chest pain or breathing difficulty (possible acute chest syndrome)",
                      "action": EMERGENCY, "critical": True})
    if t is not None and F.get(t, "neuro_symptoms", False):
        flags.append({"key": "neuro", "label": "Stroke-like symptoms (weakness, speech, face, severe headache)",
                      "action": "Call emergency services immediately (possible stroke).", "critical": True})
    spo2 = F.get(t, "spo2") if t is not None else None
    low = _sustained_low_spo2(device, now)
    if spo2 is not None and float(spo2) < 92:
        flags.append({"key": "spo2", "label": f"Oxygen saturation {float(spo2):.0f} %",
                      "action": EMERGENCY, "critical": True})
    elif low is not None:
        flags.append({"key": "spo2", "label": f"Oxygen saturation {low:.0f} % for ≥{SPO2_SUSTAINED_MIN} min "
                      "(pulse oximeter, last 24 h)", "action": EMERGENCY, "critical": True})
    hb, _ = rec.lab("hb", as_of, 2)
    if hb is not None and hb_base and hb_base - hb >= 2:
        flags.append({"key": "hb_fall", "label": f"Hb {hb:g} g/dL, ≥2 below baseline {hb_base:g}",
                      "action": "Same-day medical review (possible aplastic crisis or splenic sequestration).",
                      "critical": False})
    pain = float(F.get(t, "pain", 0)) if t is not None else 0.0
    if pain >= 8:
        flags.append({"key": "severe_pain", "label": f"Severe pain {pain:.0f}/10",
                      "action": "Follow the personal pain plan and contact the care team today; go to hospital if "
                                "pain is not controlled at home.", "critical": False})
    return flags


# ---------------------------------------------------------------------------------------------------------------
# Assessment
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class Result:
    probability: float
    score: float
    level: str
    factors: list[dict]
    red_flags: list[dict]
    model_version: str


def assess_records(rec: F.Records, as_of: Optional[date] = None, now: Optional[datetime] = None) -> Result:
    """Score one patient from all their records as of a date (default today)."""
    as_of = as_of or date.today()
    fs = F.build(rec, as_of)
    p = probability(fs.vector())
    level = level_for(p)
    flags = red_flags(rec, as_of, now)
    if any(f["critical"] for f in flags):
        level = "critical"
    elif flags and level in ("low", "moderate"):
        level = "high"
    return Result(round(p, 4), round(p * 100, 1), level, explain(fs, rec.patient),
                  [{k: v for k, v in f.items() if k != "critical"} for f in flags], model()["version"])


def assess(profile: Profile, days: Sequence[Day], as_of: Optional[date] = None) -> Result:
    """Check-ins only (no devices / labs / imaging): kept for simple callers and tests."""
    return assess_records(F.Records.from_rows(profile, checkins=days), as_of)


def card() -> dict:
    m = model()
    imp = m.get("importance", {})
    groups: dict[str, list[str]] = {}
    for k in KEYS:
        groups.setdefault(F.GROUP[k], []).append(LABELS[k])
    algo = m.get("algorithm", "")
    return {
        "version": m["version"], "trained_at": m["trained_at"],
        "algorithm": f"{algo} with {'isotonic' if getattr(m['model'], 'method', '') == 'isotonic' else 'sigmoid'} "
                     "calibration on separate patients; impact = risk now minus risk with that factor at its normal "
                     "value",
        "training_rows": m["training_rows"], "positive_rate": m["positive_rate"], "auc": m["auc"],
        "auprc": m["auprc"], "brier": m["brier"], "thresholds": THRESHOLDS,
        "features": [{"key": k, "label": LABELS[k], "weight": float(imp.get(k, 0.0)), "description": desc,
                      "group": grp} for k, _, desc, _, grp, _ in F.FEATURES],
        "calibration": m.get("calibration", []),
        "operating_points": [{k: o[k] for k in ("level", "threshold", "sensitivity", "specificity", "ppv",
                                                 "alerts_per_100_weeks")} for o in m.get("operating_points", [])],
        "comparison": [{k: c[k] for k in ("algorithm", "auroc", "auprc", "brier")} for c in m.get("comparison", [])],
        "cohort": {k: m.get("cohort", {}).get(k) for k in ("patients", "patient_days", "events")} | {"source": "synthetic"},
        "feature_groups": [{"group": g, "features": f} for g, f in groups.items()],
        "lead_time_days": m.get("lead_time_days"),
        "temporal": {k: m["temporal"][k] for k in ("auroc", "auprc", "brier", "period")} if m.get("temporal") else None,
        "data_note": "Trained on a synthetic cohort generated by a literature-calibrated simulator of people with sickle "
                     "cell disease in Ghana (genotype, age, Hb, HbF, WBC, hydroxyurea and adherence, imaging history; "
                     "daily seasons, fluids, sleep, stress, alcohol, exertion, menses and infections; wearable, pulse "
                     "oximeter, smart bottle and thermometer data; labs and imaging). Label: a healthcare-utilisation "
                     "VOC starting within the next 7 days. Metrics are from held-out simulated patients"
                     + (" (quick start-up model: run `python -m app.train` for the full one)" if m.get("quick") else "")
                     + "; they are not real-world accuracy.",
        "limitations": LIMITATIONS,
    }
