"""Imaging studies: storage of the uploaded file, structured findings from the radiologist's report (OpenAI structured
output, keyword rules without a key), TCD STOP thresholds, and an OpenAI vision "second look" at uploaded images that
is never presented as a diagnosis."""
import base64
import logging
import re
from datetime import date
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import llm
from app.config import get_settings
from app.db import ImagingStudy

log = logging.getLogger("app.imaging")

MODALITIES = ("xray", "mri", "ct", "ultrasound", "tcd")
MAX_BYTES = 15 * 1024 * 1024
AI_LABEL = "AI second look, not a radiology report; the radiologist's report is authoritative."

# file types we accept, recognised by their first bytes (the declared content type is not trusted)
FILE_TYPES = {"jpg": ("image/jpeg", b"\xff\xd8\xff"), "png": ("image/png", b"\x89PNG\r\n\x1a\n"),
              "pdf": ("application/pdf", b"%PDF-")}

# finding code -> (label, severity). Severity is ours, not the model's, so it is consistent.
CODES: dict[str, tuple[str, str]] = {
    "acs_infiltrate": ("New pulmonary infiltrate (possible acute chest syndrome)", "severe"),
    "stroke": ("Acute infarct / stroke", "severe"),
    "tcd_abnormal": ("TCD abnormal (≥ 200 cm/s)", "severe"),
    "tcd_conditional": ("TCD conditional (170–199 cm/s)", "moderate"),
    "silent_infarct": ("Silent cerebral infarct", "moderate"),
    "avn_hip": ("Avascular necrosis of the femoral head", "moderate"),
    "avn_shoulder": ("Avascular necrosis of the humeral head", "moderate"),
    "splenomegaly": ("Splenomegaly", "moderate"),
    "cardiomegaly": ("Cardiomegaly", "moderate"),
    "gallstones": ("Gallstones (cholelithiasis)", "info"),
    "normal": ("No acute abnormality", "info"),
    "other": ("Other finding", "info"),
}
SEVERITY_RANK = {"severe": 0, "moderate": 1, "info": 2}
FindingCode = Literal["acs_infiltrate", "stroke", "tcd_abnormal", "tcd_conditional", "silent_infarct", "avn_hip",
                      "avn_shoulder", "splenomegaly", "cardiomegaly", "gallstones", "normal", "other"]


class StoreError(ValueError):
    pass


# ---------- files ----------

def root() -> Path:
    return (Path(get_settings().data_dir) / "imaging").resolve()


def sniff(data: bytes) -> Optional[str]:
    for ext, (_, magic) in FILE_TYPES.items():
        if data.startswith(magic):
            return ext
    return None


def check_upload(filename: str, data: bytes) -> str:
    """The extension to store under; raises StoreError for anything that is not a real jpg/png/pdf ≤ 15 MB."""
    if not data:
        raise StoreError("The file is empty.")
    if len(data) > MAX_BYTES:
        raise StoreError("The file is larger than 15 MB.")
    ext = sniff(data)
    if ext is None:
        raise StoreError("Only JPEG, PNG or PDF files can be uploaded (export DICOM as PNG).")
    named = Path(filename or "").suffix.lower().lstrip(".")
    named = "jpg" if named == "jpeg" else named
    if named and named in FILE_TYPES and named != ext:
        raise StoreError(f"The file says .{named} but its content is {ext.upper()}.")
    return ext


def save_file(patient_id: str, study_id: str, ext: str, data: bytes) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", patient_id) or not re.fullmatch(r"[0-9a-f]{32}", study_id):
        raise StoreError("Bad identifier.")
    folder = root() / patient_id
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{study_id}.{ext}"
    path.write_bytes(data)
    return path


def stored_path(study: ImagingStudy) -> Optional[Path]:
    """The study's file, only if it exists and lies inside data_dir/imaging."""
    if not study.file_path:
        return None
    p = Path(study.file_path)
    p = (p if p.is_absolute() else Path(get_settings().data_dir) / "imaging" / p).resolve()
    if not p.is_relative_to(root()) or not p.is_file():
        return None
    return p


def relative(path: Path) -> str:
    return str(path.resolve().relative_to(root()))


# ---------- findings ----------

def finding(code: str, label: Optional[str] = None, severity: Optional[str] = None) -> dict:
    default_label, sev = CODES.get(code, CODES["other"])
    return {"code": code if code in CODES else "other", "label": (label or default_label).strip()[:200],
            "severity": sev if code in CODES and code != "other" else (severity or "info")}


def tcd_finding(velocity: Optional[float]) -> Optional[dict]:
    """STOP thresholds on the time-averaged mean maximum velocity (TAMMV)."""
    if velocity is None:
        return None
    if velocity >= 200:
        return finding("tcd_abnormal", f"TCD abnormal: TAMMV {velocity:g} cm/s (≥ 200)")
    if velocity >= 170:
        return finding("tcd_conditional", f"TCD conditional: TAMMV {velocity:g} cm/s (170–199)")
    return finding("normal", f"TCD normal: TAMMV {velocity:g} cm/s (< 170)")


def sort_findings(fs: list[dict]) -> list[dict]:
    seen, out = set(), []
    for f in sorted(fs, key=lambda f: SEVERITY_RANK.get(f["severity"], 3)):
        if f["code"] in seen and f["code"] != "other":
            continue
        seen.add(f["code"])
        out.append(f)
    if len(out) > 1:
        out = [f for f in out if f["code"] != "normal"] or out
    return out


RULES: list[tuple[str, re.Pattern]] = [
    ("acs_infiltrate", re.compile(r"infiltrat|consolidat|airspace (opacit|disease)|acute chest syndrome|"
                                  r"(new|patchy|basal|lobe) opacit", re.I)),
    ("stroke", re.compile(r"acute (ischa?emic )?infarct|\bstroke\b|restricted diffusion|haemorrhag|hemorrhag", re.I)),
    ("silent_infarct", re.compile(r"silent (cerebral )?infarct|white matter hyperintens|lacunar|"
                                  r"chronic (small )?infarct", re.I)),
    ("avn_hip", re.compile(r"(avascular necrosis|osteonecrosis|\bavn\b)[^.]*?(hip|femoral head)|"
                           r"(hip|femoral head)[^.]*?(avascular necrosis|osteonecrosis|\bavn\b)", re.I)),
    ("avn_shoulder", re.compile(r"(avascular necrosis|osteonecrosis|\bavn\b)[^.]*?(shoulder|humeral head)|"
                                r"(shoulder|humeral head)[^.]*?(avascular necrosis|osteonecrosis|\bavn\b)", re.I)),
    ("splenomegaly", re.compile(r"splenomegaly|enlarged spleen|spleen is enlarged|splenic sequestration", re.I)),
    ("cardiomegaly", re.compile(r"cardiomegaly|enlarged cardiac silhouette|cardiac silhouette is enlarged", re.I)),
    ("gallstones", re.compile(r"gall ?stones?|cholelithiasis", re.I)),
]
NEGATION = re.compile(r"\b(no|not|without|negative for|free of|resolved|resolution of|rule out|r/o|"
                      r"no evidence of|no sign of)\b[^.;]*$", re.I)
NORMAL = re.compile(r"\b(normal|unremarkable|no acute|clear lungs|lungs are clear)\b", re.I)
VELOCITY = re.compile(r"(\d{2,3}(?:\.\d)?)\s*cm\s*/\s*s", re.I)


def keyword_findings(text: str) -> list[dict]:
    """Rules for when there is no OpenAI key. A match is ignored when a negation precedes it in the same clause."""
    found: list[dict] = []
    for clause in re.split(r"[.;\n]+", text or ""):
        for code, rx in RULES:
            m = rx.search(clause)
            if m and not NEGATION.search(clause[:m.start()]):
                found.append(finding(code))
    if not found and NORMAL.search(text or ""):
        found.append(finding("normal"))
    return found


def velocity_in(text: str) -> Optional[float]:
    vs = [float(v) for v in VELOCITY.findall(text or "") if 30 <= float(v) <= 400]
    return max(vs) if vs else None


class _Finding(BaseModel):
    code: FindingCode = Field(description="The closest code; 'other' when none fits")
    label: str = Field(description="Short finding in the report's words, max 12 words")


class _Extracted(BaseModel):
    findings: list[_Finding] = Field(description="Abnormal findings stated in the report (not ruled-out ones); "
                                                 "[normal] when the report says there is no abnormality")


EXTRACT_PROMPT = ("You turn a radiology report of a person with sickle cell disease into structured findings. "
                  "Only include findings the report states as present; ignore negated or ruled-out findings. "
                  "Codes: acs_infiltrate (new pulmonary infiltrate/consolidation), stroke (acute infarct or "
                  "haemorrhage), silent_infarct (silent/chronic small infarcts, white matter lesions), avn_hip, "
                  "avn_shoulder (avascular necrosis), splenomegaly, cardiomegaly, gallstones, tcd_conditional / "
                  "tcd_abnormal (transcranial Doppler), normal, other. Do not add advice or doses.")


async def extract_findings(modality: str, body_part: str, report: str, impression: str,
                           tcd_velocity: Optional[float]) -> tuple[list[dict], str]:
    """(findings, method) with method 'ai' | 'rules'."""
    text = "\n".join(t for t in (report, impression) if t and t.strip())
    found: list[dict] = []
    method = "rules"
    if text and llm.configured():
        try:
            chain = llm.chat_model(temperature=0).with_structured_output(_Extracted)
            out = await chain.ainvoke([("system", EXTRACT_PROMPT),
                                       ("human", f"Modality: {modality}; body part: {body_part or '-'}\n\n"
                                                 f"Report:\n{text[:8000]}")])
            found = [finding(f.code, f.label) for f in out.findings]
            method = "ai"
        except Exception as e:  # noqa: BLE001
            log.warning("Findings extraction fell back to rules: %s", e)
            found = []
    if method == "rules":
        found = keyword_findings(text)
    v = tcd_velocity if tcd_velocity is not None else (velocity_in(text) if modality == "tcd" else None)
    tf = tcd_finding(v) if modality == "tcd" or tcd_velocity is not None else None
    if tf:
        found = [f for f in found if not f["code"].startswith("tcd_")] + [tf]
    return sort_findings(found), method


# ---------- AI second look (vision) ----------

class _SecondLook(BaseModel):
    image_type: str = Field(description="What the image actually is, from its pixels alone (e.g. 'frontal chest "
                                        "radiograph', 'MRI brain axial slice', 'photo of a document', 'colour "
                                        "gradient', 'not a medical image')")
    is_medical_image: bool = Field(description="True only if this is clearly a real medical image")
    readable: bool = Field(description="True if quality is good enough to comment on")
    summary: str = Field(description="2-4 plain sentences on what is visible, hedged ('may', 'appears'); "
                                     "if not a readable medical image, say so")
    findings: list[_Finding] = Field(description="Possible findings visible in the pixels; [] if none or if the "
                                                 "image is not a readable medical image")


VISION_PROMPT = ("You give a cautious second look at an image uploaded to the record of a person with sickle cell "
                 "disease, to help a clinician check the radiologist's report. You are not a radiologist and must not "
                 "diagnose. First decide from the pixels alone what the image is; the stated modality and indication "
                 "may be wrong and must never be used as evidence of a finding. If it is not clearly a medical image, "
                 "or too poor to read, say so and return no findings. Otherwise describe only what is visible, with "
                 "uncertainty, and list possible findings worth the radiologist's attention. Never give treatment or "
                 "doses. Finding codes: acs_infiltrate, stroke, silent_infarct, avn_hip, avn_shoulder, splenomegaly, "
                 "cardiomegaly, gallstones, normal, other.")
DOSE = re.compile(r"\b\d+(\.\d+)?\s?(mg|mcg|µg|units?|iu)(/kg)?\b", re.I)


async def second_look(path: Path, content_type: str, modality: str, body_part: str,
                      indication: str) -> Optional[tuple[str, list[dict]]]:
    """(summary, findings) or None when there is no key, the file is not an image, or the call fails."""
    if not llm.configured() or not content_type.startswith("image/"):
        return None
    data = base64.b64encode(path.read_bytes()).decode()
    try:
        chain = llm.chat_model(temperature=0).with_structured_output(_SecondLook)
        msg = [{"type": "text", "text": f"Modality: {modality}; body part: {body_part or '-'}; "
                                        f"indication: {indication or '-'}"},
               {"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{data}", "detail": "high"}}]
        from langchain_core.messages import HumanMessage, SystemMessage
        out = await chain.ainvoke([SystemMessage(VISION_PROMPT), HumanMessage(content=msg)])
    except Exception as e:  # noqa: BLE001
        log.warning("AI second look failed: %s", e)
        return None
    summary = DOSE.sub("[dose per care plan]", out.summary.strip())[:2000]
    if not (out.is_medical_image and out.readable):
        return f"Not read: the image looks like {out.image_type.strip() or 'something else'}. {summary}"[:2000], []
    return summary, sort_findings([finding(f.code, f.label) for f in out.findings])


def imaging_out(i: ImagingStudy) -> dict:
    has_file = bool(i.file_path)
    return {"id": i.id, "patient_id": i.patient_id, "study_date": i.study_date, "modality": i.modality,
            "body_part": i.body_part, "indication": i.indication, "report": i.report, "impression": i.impression,
            "findings": i.findings or [], "tcd_velocity": i.tcd_velocity, "ai_summary": i.ai_summary,
            "ai_findings": i.ai_findings or [], "ai_label": AI_LABEL if (i.ai_summary or i.ai_findings) else None,
            "file_url": f"/api/v1/imaging/{i.id}/file" if has_file else None, "file_name": i.file_name or None,
            "content_type": i.content_type or None, "source": i.source, "created_at": i.created_at}


async def list_studies(s: AsyncSession, patient_id: str) -> list[ImagingStudy]:
    return list((await s.scalars(select(ImagingStudy).where(ImagingStudy.patient_id == patient_id)
                                 .order_by(ImagingStudy.study_date.desc(), ImagingStudy.created_at.desc()))).all())


def active_flags(studies: list[ImagingStudy], since: Optional[date] = None) -> list[dict]:
    """Most recent abnormal finding per code (what the prediction should know about), worst first."""
    seen: dict[str, dict] = {}
    for st in studies:   # newest first
        if since and st.study_date < since:
            continue
        for f in st.findings or []:
            if f.get("code") in ("normal",) or f.get("code") in seen:
                continue
            # a newer normal TCD supersedes an older abnormal one
            if f.get("code", "").startswith("tcd_") and any(k.startswith("tcd") for k in seen):
                continue
            seen[f["code"]] = {**f, "study_date": st.study_date.isoformat(), "modality": st.modality,
                               "study_id": st.id}
        if st.modality == "tcd" and "tcd" not in seen and not any(k.startswith("tcd_") for k in seen):
            seen["tcd"] = {}   # marker: the newest TCD was normal
    return sorted([v for k, v in seen.items() if v], key=lambda f: SEVERITY_RANK.get(f["severity"], 3))
