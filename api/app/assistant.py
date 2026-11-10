"""The care assistant: a LangChain agent (LangGraph runtime, conversation memory in the checkpointer) whose tools come
from SickleGuard's MCP server. If the MCP server is down, the same tools run in-process so the assistant keeps working.
Guardrails check the question first and the answer last."""
import json
import logging
import re
import time
from contextlib import AsyncExitStack
from typing import Any, AsyncIterator, Optional

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool

from app import llm, mcp_server
from app.config import get_settings

log = logging.getLogger("app.assistant")

SYSTEM = (
    "You are SickleGuard's care assistant for sickle cell disease (SCD) care teams. You help predict and prevent "
    "vaso-occlusive crises (VOC).\n"
    "- Use the tools for facts: list_patients / get_patient / get_recent_checkins for data, predict_voc_risk for the "
    "7-day risk (never invent scores), search_guidelines for clinical guidance, list_open_alerts, notify_care_team.\n"
    "- When you use guidance, cite it by title in brackets, e.g. [Red flags and emergency care].\n"
    "- Red flags (fever ≥38.5 °C / 101.3 °F, chest pain or breathing trouble, stroke signs, SpO2 <92 %, severe uncontrolled "
    "pain, sudden pallor/large spleen) always mean emergency care: say so first.\n"
    "- Never give medicine doses or start/stop medicines; refer to the haematology team's plan.\n"
    "- Always give body temperatures in both °C and °F, e.g. 38.5 °C (101.3 °F).\n"
    "- You support clinicians; you don't diagnose. Be concise: short paragraphs, bullet lists, bold key numbers.")

INJECTION = re.compile(r"(ignore (all |any )?(previous|prior|above) (instructions|rules)|system prompt|you are now "
                       r"(dan|an unrestricted)|jailbreak|developer mode|disregard (your|the) (rules|instructions))",
                       re.I)
EMERGENCY = re.compile(r"(can'?t breathe|chest pain|stroke|seizure|unconscious|fitting|slurred speech|"
                       r"face (is )?droop|priapism|fever of (39|40|41))", re.I)
DOSE = re.compile(r"\b\d+(\.\d+)?\s?(mg|mcg|µg)(/kg)?\b", re.I)

_TTL = 60
_cache: tuple[float, list[BaseTool], str] = (0.0, [], "")
_override: Optional[list[BaseTool]] = None


def use_tools(tools: Optional[list[BaseTool]]) -> None:
    global _override, _cache
    _override, _cache = tools, (0.0, [], "")


def local_tools() -> list[BaseTool]:
    fns = [mcp_server.list_patients, mcp_server.get_patient, mcp_server.get_recent_checkins,
           mcp_server.predict_voc_risk, mcp_server.search_guidelines, mcp_server.list_open_alerts,
           mcp_server.notify_care_team, mcp_server.get_vitals, mcp_server.get_labs,
           mcp_server.get_imaging_findings, mcp_server.get_record_summary]
    return [StructuredTool.from_function(coroutine=f, name=f.__name__, description=f.__doc__) for f in fns]


async def tools() -> tuple[list[BaseTool], str]:
    """(tools, 'mcp' | 'local')."""
    global _cache
    if _override is not None:
        return list(_override), "local"
    at, cached, src = _cache
    if cached and time.monotonic() - at < _TTL:
        return cached, src
    s = get_settings()
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
        conn: dict[str, Any] = {"transport": "streamable_http", "url": s.mcp_url}
        if s.mcp_token:
            conn["headers"] = {"Authorization": f"Bearer {s.mcp_token}"}
        found = await MultiServerMCPClient({"sickleguard": conn}).get_tools()
        _cache = (time.monotonic(), found, "mcp")
    except Exception as e:  # noqa: BLE001
        log.info("MCP server not reachable (%s); using in-process tools", type(e).__name__)
        _cache = (time.monotonic() - _TTL + 15, local_tools(), "local")
    return _cache[1], _cache[2]


# ---------- checkpointer (conversation memory) ----------

class _RT:
    saver = None
    stack: Optional[AsyncExitStack] = None


rt = _RT()


async def start() -> None:
    s = get_settings()
    if not s.uses_postgres:
        from langgraph.checkpoint.memory import InMemorySaver
        rt.saver = InMemorySaver()
        return
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    rt.stack = AsyncExitStack()
    rt.saver = await rt.stack.enter_async_context(AsyncPostgresSaver.from_conn_string(s.psycopg_url))
    await rt.saver.setup()


async def stop() -> None:
    if rt.stack:
        await rt.stack.aclose()
    rt.saver, rt.stack = None, None


async def agent():
    found, _ = await tools()
    return create_agent(llm.chat_model(), found, system_prompt=SYSTEM, checkpointer=rt.saver)


def check_input(message: str) -> Optional[str]:
    if INJECTION.search(message):
        return "I can't change my instructions. Ask me about patients, crisis risk or sickle cell guidance."
    if len(message) > 4000:
        return "Please keep questions under 4,000 characters."
    return None


def _sources(content: Any) -> list[dict]:
    try:
        data = json.loads(content) if isinstance(content, str) else content
    except (TypeError, ValueError):
        return []
    if isinstance(data, list) and data and isinstance(data[0], dict) and data[0].get("type") == "text":
        out = []
        for part in data:
            out += _sources(part.get("text", ""))
        return out
    if isinstance(data, list):
        return [{"title": d.get("title", ""), "snippet": d.get("snippet", "")[:600], "score": d.get("score", 0)}
                for d in data if isinstance(d, dict) and "snippet" in d]
    return []


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


async def stream(message: str, thread_id: str, patient: Optional[dict] = None) -> AsyncIterator[dict]:
    """Events as in docs/API.md (without the first 'thread' and last 'done')."""
    blocked = check_input(message)
    if blocked:
        yield {"type": "blocked", "message": blocked}
        return
    prompt = message
    if patient:
        prompt = f"(Context: the clinician has patient {patient['name']}, MRN {patient['mrn']}, open.)\n{message}"
    if EMERGENCY.search(message):
        prompt += ("\n(Safety: this mentions possible emergency symptoms. Start with clear emergency-care advice.)")
    a = await agent()
    answer, sources = "", []
    async for mode, data in a.astream({"messages": [HumanMessage(prompt)]},
                                      {"configurable": {"thread_id": thread_id}, "recursion_limit": 30},
                                      stream_mode=["messages", "updates"]):
        if mode == "messages":
            chunk, meta = data
            if isinstance(chunk, AIMessageChunk) and meta.get("langgraph_node") == "model":
                text = _text(chunk.content)
                if text:
                    answer += text
                    yield {"type": "token", "text": text}
        elif mode == "updates":
            for node, update in data.items():
                for m in (update or {}).get("messages", []) if isinstance(update, dict) else []:
                    if isinstance(m, AIMessage) and m.tool_calls:
                        for c in m.tool_calls:
                            yield {"type": "tool", "name": c["name"], "args": c["args"]}
                    elif isinstance(m, ToolMessage):
                        body = _text(m.content)
                        yield {"type": "tool_result", "name": m.name, "preview": body[:300]}
                        if m.name == "search_guidelines":
                            sources += _sources(m.content)
    if DOSE.search(answer):
        yield {"type": "token", "text": "\n\n> Safety note: medicine doses must come from the patient's haematology "
                                        "team plan, not from this assistant."}
    if sources:
        seen, uniq = set(), []
        for src in sources:
            if src["title"] + src["snippet"][:50] not in seen:
                seen.add(src["title"] + src["snippet"][:50])
                uniq.append(src)
        yield {"type": "sources", "items": uniq[:6]}


async def history(thread_id: str) -> list[dict]:
    if rt.saver is None:
        return []
    cp = await rt.saver.aget_tuple({"configurable": {"thread_id": thread_id}})
    if cp is None:
        return []
    out: list[dict] = []
    for m in cp.checkpoint["channel_values"].get("messages", []):
        if isinstance(m, HumanMessage):
            text = _text(m.content)
            if text.startswith("(Context:"):
                text = text.split("\n", 1)[-1]
            out.append({"role": "user", "content": text.split("\n(Safety:")[0]})
        elif isinstance(m, AIMessage):
            if m.tool_calls and out and out[-1]["role"] == "assistant" and not out[-1]["content"]:
                out[-1]["tools"] += [c["name"] for c in m.tool_calls]
            elif m.tool_calls:
                out.append({"role": "assistant", "content": _text(m.content), "tools": [c["name"] for c in m.tool_calls]})
            elif out and out[-1]["role"] == "assistant" and not out[-1]["content"]:
                out[-1]["content"] = _text(m.content)
            else:
                out.append({"role": "assistant", "content": _text(m.content), "tools": []})
    return out
