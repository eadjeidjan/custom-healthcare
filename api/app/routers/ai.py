"""Care assistant (SSE chat) and the knowledge base."""
import json
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app import assistant, llm, rag
from app.db import Document, Patient, Thread, User, get_session, now, open_session
from app.security import admin_user, staff_user

router = APIRouter()


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    thread_id: Optional[str] = None
    patient_id: Optional[str] = None


@router.post("/assistant/chat")
async def chat(body: ChatIn, user: User = Depends(staff_user), session: AsyncSession = Depends(get_session)):
    thread = await session.get(Thread, body.thread_id) if body.thread_id else None
    if thread is not None and thread.user_id != user.id:
        raise HTTPException(404, "No such conversation.")
    if thread is None:
        thread = Thread(user_id=user.id, patient_id=body.patient_id, title=body.message.strip()[:80])
        session.add(thread)
    if body.patient_id:
        thread.patient_id = body.patient_id
    thread.updated_at = now()
    await session.commit()
    thread_id, patient_id = thread.id, thread.patient_id
    patient = None
    if patient_id:
        p = await session.get(Patient, patient_id)
        patient = {"name": p.name, "mrn": p.mrn} if p else None

    async def events():
        yield {"data": json.dumps({"type": "thread", "thread_id": thread_id})}
        try:
            if not llm.configured():
                yield {"data": json.dumps({"type": "error", "message": "The assistant needs an OpenAI key: set "
                                                                       "OPENAI_API_KEY in api/.env and restart."})}
            else:
                async for ev in assistant.stream(body.message, thread_id, patient):
                    yield {"data": json.dumps(ev, default=str)}
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            friendly = ("OpenAI refused the key: check OPENAI_API_KEY." if "401" in msg or "api_key" in msg.lower()
                        else "Something went wrong while answering. Please try again.")
            yield {"data": json.dumps({"type": "error", "message": friendly})}
        async with open_session() as s:
            t = await s.get(Thread, thread_id)
            if t:
                t.updated_at = now()
                await s.commit()
        yield {"data": json.dumps({"type": "done"})}

    return EventSourceResponse(events(), ping=15)


@router.get("/assistant/threads")
async def threads(user: User = Depends(staff_user), session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(Thread).where(Thread.user_id == user.id)
                                 .order_by(Thread.updated_at.desc()).limit(50))
    return [{"id": t.id, "title": t.title, "patient_id": t.patient_id, "updated_at": t.updated_at} for t in rows]


@router.get("/assistant/threads/{tid}")
async def thread(tid: str, user: User = Depends(staff_user), session: AsyncSession = Depends(get_session)):
    t = await session.get(Thread, tid)
    if t is None or t.user_id != user.id:
        raise HTTPException(404, "No such conversation.")
    return {"id": t.id, "title": t.title, "patient_id": t.patient_id, "messages": await assistant.history(t.id)}


@router.get("/assistant/tools")
async def tool_list(_: User = Depends(staff_user)):
    found, src = await assistant.tools()
    return [{"name": t.name, "description": (t.description or "").split("\n")[0], "source": src} for t in found]


def doc_out(d: Document) -> dict:
    return {"id": d.id, "title": d.title, "filename": d.filename, "chunks": d.chunks, "status": d.status,
            "error": d.error, "created_at": d.created_at}


@router.get("/knowledge")
async def documents(_: User = Depends(staff_user), session: AsyncSession = Depends(get_session)):
    return [doc_out(d) for d in await session.scalars(select(Document).order_by(Document.title))]


@router.get("/knowledge/search")
async def search(q: str, k: int = 5, _: User = Depends(staff_user)):
    if not q.strip():
        return []
    return await rag.search(q, k)


async def _index(doc_id: str, title: str, text: str) -> None:
    try:
        await rag.index_text(doc_id, title, text)
    except Exception as e:  # noqa: BLE001
        async with open_session() as s:
            d = await s.get(Document, doc_id)
            if d:
                d.status, d.error = "failed", f"{type(e).__name__}: {e}"[:500]
                await s.commit()


@router.post("/knowledge")
async def upload(background: BackgroundTasks, file: UploadFile = File(...), _: User = Depends(admin_user),
                 session: AsyncSession = Depends(get_session)):
    name = (file.filename or "document.txt").replace("/", "_")[:200]
    if not name.lower().endswith((".md", ".txt", ".pdf")):
        raise HTTPException(422, "Upload a .md, .txt or .pdf file.")
    data = await file.read()
    if len(data) > 10_000_000:
        raise HTTPException(413, "Files up to 10 MB.")
    text = rag.read_file(name, data)
    if len(text.strip()) < 50:
        raise HTTPException(422, "No readable text found in the file.")
    if await session.scalar(select(Document).where(Document.filename == name)):
        raise HTTPException(409, "A document with this file name already exists. Delete it first.")
    d = Document(title=rag.title_of(text, name), filename=name)
    session.add(d)
    await session.commit()
    background.add_task(_index, d.id, d.title, text)
    return doc_out(d)


@router.delete("/knowledge/{doc_id}")
async def delete_doc(doc_id: str, _: User = Depends(admin_user), session: AsyncSession = Depends(get_session)):
    d = await session.get(Document, doc_id)
    if d is None:
        raise HTTPException(404, "No such document.")
    await rag.remove(doc_id)
    await session.delete(d)
    await session.commit()
    return {"ok": True}
