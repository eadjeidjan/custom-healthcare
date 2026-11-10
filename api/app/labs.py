"""Lab results: code catalogue with adult reference ranges, unit conversion, flags, and CSV / FHIR R4 import."""
import csv
import io
import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import LabResult, Patient, now


@dataclass(frozen=True)
class LabInfo:
    name: str
    unit: str
    ref_low: Optional[float]
    ref_high: Optional[float]
    lo: float            # plausible range: outside it the value is rejected as an entry error
    hi: float
    note: str = ""


# Adult reference ranges (typical laboratory values). Many people with sickle cell disease live outside them
# (e.g. Hb 6–9 g/dL, high reticulocytes and LDH), so the flag says "outside the reference range", nothing more;
# compare with the patient's own baseline.
CATALOGUE: dict[str, LabInfo] = {
    "hb": LabInfo("Haemoglobin", "g/dL", 12.0, 16.0, 1, 25, "Women 12–15.5, men 13–17 g/dL"),
    "wbc": LabInfo("White cell count", "×10⁹/L", 4.0, 11.0, 0.1, 200),
    "anc": LabInfo("Neutrophils (ANC)", "×10⁹/L", 2.0, 7.5, 0, 100, "Monitored on hydroxyurea"),
    "plt": LabInfo("Platelets", "×10⁹/L", 150, 400, 1, 3000),
    "retic": LabInfo("Reticulocytes", "%", 0.5, 2.5, 0, 60),
    "ldh": LabInfo("Lactate dehydrogenase (LDH)", "U/L", 140, 280, 10, 20000, "Haemolysis marker"),
    "bili": LabInfo("Bilirubin (total)", "µmol/L", 3, 21, 1, 1500, "Haemolysis marker"),
    "hbf": LabInfo("Fetal haemoglobin (HbF)", "%", 0, 2, 0, 100, "Higher HbF protects against crises"),
    "crp": LabInfo("C-reactive protein (CRP)", "mg/L", 0, 5, 0, 700, "Inflammation / infection"),
    "creat": LabInfo("Creatinine", "µmol/L", 45, 110, 5, 3000, "Kidney function"),
    "ferritin": LabInfo("Ferritin", "µg/L", 15, 300, 1, 50000, "Iron overload after transfusions"),
}
SEX_RANGES = {("hb", "F"): (12.0, 15.5), ("hb", "M"): (13.0, 17.0), ("creat", "F"): (45, 90), ("creat", "M"): (60, 110)}

# LOINC → our code (FHIR import and CSV rows that use LOINC codes)
LOINC: dict[str, str] = {
    "718-7": "hb", "20509-6": "hb", "30313-1": "hb", "59260-0": "hb", "30350-3": "hb",
    "6690-2": "wbc", "26464-8": "wbc", "804-5": "wbc",
    "751-8": "anc", "753-4": "anc", "26499-4": "anc",
    "777-3": "plt", "26515-7": "plt", "778-1": "plt",
    "4679-7": "retic", "17849-1": "retic", "31111-8": "retic",
    "2532-0": "ldh", "14804-9": "ldh", "14805-6": "ldh",
    "1975-2": "bili", "14631-6": "bili", "42719-5": "bili",
    "4576-5": "hbf",
    "1988-5": "crp", "30522-7": "crp", "76485-2": "crp",
    "2160-0": "creat", "14682-9": "creat", "38483-4": "creat",
    "2276-4": "ferritin", "24373-3": "ferritin", "20567-4": "ferritin",
}
ALIASES = {
    "haemoglobin": "hb", "hemoglobin": "hb", "hgb": "hb", "white cells": "wbc", "white cell count": "wbc",
    "leukocytes": "wbc", "neutrophils": "anc", "platelets": "plt", "platelet": "plt", "reticulocytes": "retic",
    "reticulocyte": "retic", "retic_percent": "retic", "lactate dehydrogenase": "ldh", "bilirubin": "bili",
    "total bilirubin": "bili", "hb_f": "hbf", "fetal haemoglobin": "hbf", "c-reactive protein": "crp",
    "creatinine": "creat", "cr": "creat",
}

# factor to the catalogue unit, by (code, normalised unit)
_UNIT_NORM = str.maketrans({"µ": "u", "μ": "u", "×": "x", "⁹": "9", "³": "3", " ": ""})
FACTORS = {("hb", "g/l"): 0.1, ("hb", "mmol/l"): 1.611, ("bili", "mg/dl"): 17.1, ("creat", "mg/dl"): 88.4,
           ("crp", "mg/dl"): 10.0, ("retic", "fraction"): 100.0, ("hbf", "fraction"): 100.0,
           ("plt", "10*3/mm3"): 1.0, ("wbc", "10*3/mm3"): 1.0, ("anc", "10*3/mm3"): 1.0, ("ldh", "ukat/l"): 60.0}
_CANON = {"hb": {"g/dl"}, "wbc": {"x109/l", "10*9/l", "10^9/l", "10e9/l", "10*3/ul", "10^3/ul", "k/ul", "thou/ul"},
          "anc": {"x109/l", "10*9/l", "10^9/l", "10e9/l", "10*3/ul", "10^3/ul", "k/ul", "thou/ul"},
          "plt": {"x109/l", "10*9/l", "10^9/l", "10e9/l", "10*3/ul", "10^3/ul", "k/ul", "thou/ul"},
          "retic": {"%"}, "hbf": {"%"}, "ldh": {"u/l", "iu/l"}, "bili": {"umol/l"}, "crp": {"mg/l"},
          "creat": {"umol/l"}, "ferritin": {"ug/l", "ng/ml"}}


class LabError(ValueError):
    pass


def resolve_code(raw: str) -> Optional[str]:
    c = (raw or "").strip().lower()
    if c in CATALOGUE:
        return c
    if c in LOINC:
        return LOINC[c]
    return ALIASES.get(c)


def to_catalogue_unit(code: str, value: float, unit: Optional[str]) -> float:
    """Convert a value given in `unit` to the catalogue unit (no unit = already in it)."""
    if not unit or not unit.strip():
        return value
    u = unit.strip().lower().translate(_UNIT_NORM)
    if u in _CANON.get(code, set()) or u == CATALOGUE[code].unit.lower().translate(_UNIT_NORM):
        return value
    f = FACTORS.get((code, u))
    if f is None:
        raise LabError(f"{code}: unit '{unit}' is not supported (use {CATALOGUE[code].unit})")
    return value * f


def ref_range(code: str, sex: Optional[str] = None) -> tuple[Optional[float], Optional[float]]:
    if sex and (code, sex) in SEX_RANGES:
        return SEX_RANGES[(code, sex)]
    info = CATALOGUE[code]
    return info.ref_low, info.ref_high


def flag(value: float, low: Optional[float], high: Optional[float]) -> Optional[str]:
    if low is not None and value < low:
        return "low"
    if high is not None and value > high:
        return "high"
    return None


def lab_out(r: LabResult) -> dict:
    taken = r.taken_at.replace(tzinfo=timezone.utc) if r.taken_at.tzinfo is None else r.taken_at
    return {"id": r.id, "patient_id": r.patient_id, "taken_at": taken, "code": r.code, "name": r.name,
            "value": r.value, "unit": r.unit, "ref_low": r.ref_low, "ref_high": r.ref_high, "source": r.source,
            "flag": flag(r.value, r.ref_low, r.ref_high)}


def parse_when(raw) -> datetime:
    if isinstance(raw, datetime):
        dt = raw
    elif isinstance(raw, date):
        dt = datetime.combine(raw, time(8, 0))
    else:
        s = str(raw or "").strip()
        if not s:
            raise LabError("missing date")
        try:
            dt = datetime.combine(date.fromisoformat(s), time(8, 0)) if len(s) == 10 else \
                datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            raise LabError(f"date '{s}' is not ISO (YYYY-MM-DD or YYYY-MM-DDTHH:MM)") from None
    dt = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    if dt > now():
        raise LabError(f"date {dt.date()} is in the future")
    if dt.year < 1950:
        raise LabError(f"date {dt.date()} is too old")
    return dt


def make(patient: Patient, code: str, value: float, unit: Optional[str], taken_at: datetime,
         source: str) -> LabResult:
    raw_code = code
    code = resolve_code(code)
    if code is None:
        raise LabError(f"unknown lab code '{raw_code}' (use one of {', '.join(CATALOGUE)})")
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise LabError(f"{code}: value '{value}' is not a number") from None
    value = to_catalogue_unit(code, value, unit)
    info = CATALOGUE[code]
    if not info.lo <= value <= info.hi:
        raise LabError(f"{code}: {value:g} {info.unit} is outside the plausible range {info.lo:g}–{info.hi:g}")
    lo, hi = ref_range(code, patient.sex)
    return LabResult(patient_id=patient.id, taken_at=taken_at, code=code, name=info.name, value=round(value, 3),
                     unit=info.unit, ref_low=lo, ref_high=hi, source=source)


async def list_labs(s: AsyncSession, patient_id: str, days: int = 365) -> list[LabResult]:
    since = now() - timedelta(days=days)
    return list((await s.scalars(select(LabResult).where(LabResult.patient_id == patient_id,
                                                         LabResult.taken_at >= since)
                                 .order_by(LabResult.taken_at.desc()))).all())


async def latest_by_code(s: AsyncSession, patient_id: str, days: int = 3650) -> dict[str, LabResult]:
    out: dict[str, LabResult] = {}
    for r in await list_labs(s, patient_id, days):
        out.setdefault(r.code, r)
    return out


# ---------- import ----------

def _rows_csv(text: str) -> list[tuple[str, dict]]:
    rows = list(csv.reader(io.StringIO(text)))
    out = []
    start = 0
    if rows and any(c.strip().lower() in ("code", "taken_at", "value") for c in rows[0]):
        header = [c.strip().lower() for c in rows[0]]
        start = 1
        idx = {k: header.index(k) for k in ("taken_at", "code", "value", "unit") if k in header}
        if not {"taken_at", "code", "value"} <= idx.keys():
            raise LabError("CSV header needs taken_at, code and value columns")
    else:
        idx = {"taken_at": 0, "code": 1, "value": 2, "unit": 3}
    for n, row in enumerate(rows[start:], start=start + 1):
        if not row or all(not c.strip() for c in row) or row[0].lstrip().startswith("#"):
            continue
        get = lambda k: row[idx[k]].strip() if k in idx and idx[k] < len(row) else ""  # noqa: E731
        out.append((f"line {n}", {"taken_at": get("taken_at"), "code": get("code"), "value": get("value"),
                                  "unit": get("unit") or None}))
    return out


def _naive(dt: datetime) -> datetime:
    return (dt.astimezone(timezone.utc) if dt.tzinfo else dt).replace(tzinfo=None)


SKIP_STATUS = {"entered-in-error", "cancelled", "registered"}


def _rows_fhir(doc: dict) -> tuple[list[tuple[str, dict]], int, list[str]]:
    """Observations → rows; returns (rows, skipped, errors)."""
    if doc.get("resourceType") == "Observation":
        resources = [doc]
    elif doc.get("resourceType") == "Bundle":
        resources = [e.get("resource") or {} for e in doc.get("entry") or []]
    else:
        raise LabError("JSON must be a FHIR R4 Bundle (or a single Observation)")
    rows, skipped, errors = [], 0, []
    for i, res in enumerate(resources):
        where = f"entry {i}" + (f" ({res.get('id')})" if res.get("id") else "")
        if res.get("resourceType") != "Observation":
            skipped += 1
            continue
        if res.get("status") in SKIP_STATUS:
            skipped += 1
            continue
        codings = (res.get("code") or {}).get("coding") or []
        code = next((LOINC[c["code"]] for c in codings
                     if "loinc" in str(c.get("system", "")).lower() and c.get("code") in LOINC), None)
        if code is None:
            skipped += 1      # not one of our labs (vital signs, other tests…)
            continue
        q = res.get("valueQuantity")
        if not q or q.get("value") is None:
            errors.append(f"{where}: {code} has no valueQuantity")
            continue
        when = res.get("effectiveDateTime") or (res.get("effectivePeriod") or {}).get("start") or res.get("issued")
        rows.append((where, {"taken_at": when, "code": code, "value": q.get("value"),
                             "unit": q.get("unit") or q.get("code")}))
    return rows, skipped, errors


async def import_file(s: AsyncSession, patient: Patient, filename: str, data: bytes) -> dict:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise LabError("The file must be UTF-8 text (CSV or FHIR JSON)") from None
    skipped, errors = 0, []
    if filename.lower().endswith(".json") or text.lstrip().startswith("{"):
        try:
            doc = json.loads(text)
        except json.JSONDecodeError as e:
            raise LabError(f"Not valid JSON: {e.msg} (line {e.lineno})") from None
        if not isinstance(doc, dict):
            raise LabError("JSON must be a FHIR R4 Bundle (or a single Observation)")
        rows, skipped, errors = _rows_fhir(doc)
        source = "fhir"
    else:
        rows = _rows_csv(text)
        source = "import"
    existing = {(r.code, _naive(r.taken_at), round(r.value, 3))
                for r in await list_labs(s, patient.id, days=36500)}
    imported = 0
    for where, row in rows:
        try:
            lab = make(patient, row["code"], row["value"], row["unit"], parse_when(row["taken_at"]), source)
        except LabError as e:
            errors.append(f"{where}: {e}")
            continue
        key = (lab.code, _naive(lab.taken_at), lab.value)
        if key in existing:
            skipped += 1
            continue
        existing.add(key)
        s.add(lab)
        imported += 1
    await s.commit()
    if len(errors) > 50:
        errors = errors[:50] + [f"… and {len(errors) - 50} more"]
    return {"imported": imported, "skipped": skipped, "errors": errors}


def catalogue_out() -> list[dict]:
    return [{"code": c, "name": i.name, "unit": i.unit, "ref_low": i.ref_low, "ref_high": i.ref_high, "note": i.note,
             "loinc": [k for k, v in LOINC.items() if v == c]} for c, i in CATALOGUE.items()]

