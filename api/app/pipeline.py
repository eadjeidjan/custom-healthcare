"""The full risk assessment as a LangGraph graph:

    score (data + model + red-flag rules) → retrieve (RAG over guidance) → advise (OpenAI, structured plan)
    → safety (red flags first, no doses, fallbacks) → save (assessment + alert)

Without an OpenAI key `advise` uses the rule-based plan, so the pipeline always returns an assessment."""
import logging
import re
from typing import Literal, Optional, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from app import care, llm, rag, risk
from app.db import Patient, open_session

log = logging.getLogger("app.pipeline")


class PlanItem(BaseModel):
    action: str = Field(description="One concrete prevention step, imperative, max 20 words")
    why: str = Field(description="Why, tied to this patient's factors or the guidance, max 25 words")
    who: Literal["patient", "care team"]
    urgency: Literal["now", "today", "this week"]


class Advice(BaseModel):
    summary: str = Field(description="3-5 sentences for the care team: the risk level, the main drivers, and what "
                                     "matters most now. Cite guidance as [1], [2].")
    plan: list[PlanItem] = Field(description="3-7 steps, most urgent first")


class State(TypedDict, total=False):
    patient_id: str
    patient: dict
    result: risk.Result
    hits: list[dict]
    summary: Optional[str]
    plan: list[dict]
    assessment: dict
    error: str


SYSTEM = (
    "You are SickleGuard, a clinical decision-support assistant for sickle cell disease care teams. You explain a "
    "patient's 7-day vaso-occlusive crisis (VOC) risk from a model and suggest practical prevention steps. Base advice "
    "on the numbered guidance passages and the patient's own factors; cite passages like [1]. Never give medicine "
    "doses or change prescriptions: say 'per the haematology team's plan' instead. If there are red flags, the first "
    "step must be the red flag action. Be concise, specific and kind; write for clinicians.")

DOSE = re.compile(r"\b\d+(\.\d+)?\s?(mg|mcg|µg|g|ml|mL|units?)(/kg)?\b", re.I)


def _describe(p: dict, r: risk.Result) -> str:
    lines = [f"Patient: {p['name']}, {p['age']} y, {p['sex']}, genotype {p['genotype']}, "
             f"hydroxyurea {'yes' if p['on_hydroxyurea'] else 'no'}, crises in 12 months {p['crises_12m']}, "
             f"baseline Hb {p['hb_baseline']} g/dL, HbF {p['hbf_percent'] if p['hbf_percent'] is not None else 'unknown'} %.",
             f"Model: 7-day VOC risk {r.score:.0f}/100 ({r.level}).",
             "Factors (score points; + raises risk): " + "; ".join(
                 f"{f['label']} = {f['value']} ({f['impact']:+.0f})" for f in r.factors) or "none"]
    if r.red_flags:
        lines.append("RED FLAGS: " + "; ".join(f"{f['label']} → {f['action']}" for f in r.red_flags))
    return "\n".join(lines)


async def score(state: State) -> State:
    async with open_session() as s:
        p = await s.get(Patient, state["patient_id"])
        if p is None:
            return {"error": "No such patient."}
        result = await care.score_patient(s, p)
        return {"patient": await care.patient_out(s, p), "result": result}


async def retrieve(state: State) -> State:
    r = state["result"]
    topics = [f["label"] for f in r.factors if f["direction"] == "up"][:4] + [f["label"] for f in r.red_flags][:2]
    query = "sickle cell vaso-occlusive crisis prevention " + ", ".join(topics or ["daily self-care"])
    return {"hits": await rag.search(query, 5)}


async def advise(state: State) -> State:
    r = state["result"]
    if not llm.configured():
        return {"summary": None, "plan": care.rule_plan(r)}
    try:
        model = llm.chat_model().with_structured_output(Advice)
        advice: Advice = await model.ainvoke([
            SystemMessage(SYSTEM),
            HumanMessage(f"{_describe(state['patient'], r)}\n\nGuidance passages:\n{rag.context_block(state['hits'])}"
                         "\n\nWrite the summary and prevention plan."),
        ])
        return {"summary": advice.summary, "plan": [i.model_dump() for i in advice.plan]}
    except Exception as e:  # noqa: BLE001 - the care team still gets the rule-based plan
        log.warning("AI advice failed: %s", e)
        return {"summary": None, "plan": care.rule_plan(r)}


async def safety(state: State) -> State:
    r = state["result"]
    plan = [i for i in state.get("plan") or [] if i.get("action")]
    for i in plan:
        i["action"] = DOSE.sub("[dose per haematology plan]", i["action"])
        i["why"] = DOSE.sub("[dose per haematology plan]", i.get("why", ""))
    flags = [{"action": f["action"], "why": f["label"], "who": "patient", "urgency": "now"} for f in r.red_flags]
    flagged = {f["action"] for f in flags}
    plan = flags + [i for i in plan if i["action"] not in flagged]
    summary = state.get("summary")
    if summary:
        summary = DOSE.sub("[dose per haematology plan]", summary)
        if r.red_flags and "emergency" not in summary.lower():
            summary = "**Red flag: " + "; ".join(f["label"] for f in r.red_flags) + ". " + r.red_flags[0]["action"] + \
                      "**\n\n" + summary
    return {"plan": plan[:8] or care.rule_plan(r), "summary": summary}


async def save(state: State) -> State:
    async with open_session() as s:
        p = await s.get(Patient, state["patient_id"])
        a = await care.save_assessment(s, p, state["result"], "ai", summary=state.get("summary"),
                                       plan=state["plan"], sources=state.get("hits", []))
        return {"assessment": care.assessment_out(a)}


def build():
    g = StateGraph(State)
    for name, fn in (("score", score), ("retrieve", retrieve), ("advise", advise), ("safety", safety),
                     ("save", save)):
        g.add_node(name, fn)
    g.add_edge(START, "score")
    g.add_conditional_edges("score", lambda s: END if s.get("error") else "retrieve")
    g.add_edge("retrieve", "advise")
    g.add_edge("advise", "safety")
    g.add_edge("safety", "save")
    g.add_edge("save", END)
    return g.compile()


graph = build()


async def run(patient_id: str) -> State:
    return await graph.ainvoke({"patient_id": patient_id})
