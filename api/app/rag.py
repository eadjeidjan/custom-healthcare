"""RAG over the sickle cell guidance: documents are split into passages, embedded with OpenAI and stored in Qdrant
(vector DB). Search finds passages by meaning; without an OpenAI key or Qdrant it falls back to keyword scoring over
the same passages kept in Postgres, so the app still answers with sources."""
import asyncio
import logging
import math
import re
from collections import Counter
from pathlib import Path
from typing import Optional

from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
from sqlalchemy import delete, select

from app import llm
from app.config import get_settings
from app.db import Chunk, Document, open_session

log = logging.getLogger("app.rag")
KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent / "knowledge"

_client = None
_ready = False


def client():
    global _client
    if _client is None:
        from qdrant_client import AsyncQdrantClient
        s = get_settings()
        _client = (AsyncQdrantClient(location=":memory:") if s.qdrant_url == ":memory:"
                   else AsyncQdrantClient(url=s.qdrant_url, api_key=s.qdrant_api_key or None, timeout=10))
    return _client


def use_client(c) -> None:
    global _client, _ready
    _client, _ready = c, False


async def qdrant_ok() -> bool:
    try:
        await asyncio.wait_for(client().get_collections(), 3)
        return True
    except Exception:  # noqa: BLE001
        return False


async def _ensure_collection() -> None:
    global _ready
    if _ready:
        return
    from qdrant_client import models
    s = get_settings()
    if not await client().collection_exists(s.collection):
        await client().create_collection(s.collection, vectors_config=models.VectorParams(
            size=s.embed_dims, distance=models.Distance.COSINE))
    _ready = True


def split(text: str, title: str) -> list[str]:
    sections = MarkdownHeaderTextSplitter([("#", "h1"), ("##", "h2")], strip_headers=False).split_text(text)
    splitter = RecursiveCharacterTextSplitter(chunk_size=1100, chunk_overlap=150)
    out = []
    for sec in sections:
        for piece in splitter.split_text(sec.page_content):
            heading = sec.metadata.get("h2")
            prefix = f"{title} — {heading}\n" if heading and heading not in piece[:120] else f"{title}\n"
            out.append(prefix + piece.strip())
    return [c for c in out if len(c) > 80]


def title_of(text: str, filename: str) -> str:
    m = re.search(r"^#\s+(.+)$", text, re.M)
    return m.group(1).strip() if m else Path(filename).stem.replace("-", " ").capitalize()


def read_file(name: str, data: bytes) -> str:
    if name.lower().endswith(".pdf"):
        import io

        from pypdf import PdfReader
        return "\n\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages)
    return data.decode("utf-8", errors="replace")


async def index_text(doc_id: str, title: str, text: str) -> int:
    """Store passages in Postgres (keyword fallback) and, when possible, in Qdrant (meaning)."""
    pieces = split(text, title)
    async with open_session() as s:
        await s.execute(delete(Chunk).where(Chunk.document_id == doc_id))
        rows = [Chunk(document_id=doc_id, title=title, text=t, position=i) for i, t in enumerate(pieces)]
        s.add_all(rows)
        doc = await s.get(Document, doc_id)
        doc.chunks, doc.status, doc.error = len(rows), "indexed", None
        await s.commit()
        ids = [r.id for r in rows]
    if llm.embeddings_ready():
        try:
            from qdrant_client import models
            await _ensure_collection()
            vectors = await llm.embeddings().aembed_documents(pieces)
            await client().delete(get_settings().collection, points_selector=models.FilterSelector(
                filter=models.Filter(must=[models.FieldCondition(key="doc_id",
                                                                 match=models.MatchValue(value=doc_id))])))
            await client().upsert(get_settings().collection, points=[
                models.PointStruct(id=_uuid(cid), vector=v, payload={"doc_id": doc_id, "title": title, "text": t})
                for cid, v, t in zip(ids, vectors, pieces)])
        except Exception as e:  # noqa: BLE001
            log.warning("Vector indexing failed for %s: %s (keyword search still works)", title, e)
            async with open_session() as s:
                doc = await s.get(Document, doc_id)
                doc.error = f"Vector index unavailable: {type(e).__name__}. Keyword search works."
                await s.commit()
    return len(pieces)


def _uuid(hex32: str) -> str:
    return f"{hex32[:8]}-{hex32[8:12]}-{hex32[12:16]}-{hex32[16:20]}-{hex32[20:32]}"


async def remove(doc_id: str) -> None:
    try:
        from qdrant_client import models
        await client().delete(get_settings().collection, points_selector=models.FilterSelector(
            filter=models.Filter(must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=doc_id))])))
    except Exception:  # noqa: BLE001
        pass


async def load_folder(folder: Path = KNOWLEDGE_DIR, reindex_vectors: bool = False) -> int:
    """Index the bundled guidance once (new files only; `reindex_vectors` redoes Qdrant, e.g. after adding a key)."""
    if not folder.exists():
        return 0
    n = 0
    for path in sorted(folder.glob("*.md")):
        text = path.read_text()
        async with open_session() as s:
            doc = await s.scalar(select(Document).where(Document.filename == path.name))
            if doc is not None and not reindex_vectors:
                continue
            if doc is None:
                doc = Document(title=title_of(text, path.name), filename=path.name)
                s.add(doc)
                await s.commit()
            doc_id, title = doc.id, doc.title
        await index_text(doc_id, title, text)
        n += 1
    return n


async def vectors_missing() -> bool:
    if not llm.embeddings_ready():
        return False
    try:
        await _ensure_collection()
        info = await client().count(get_settings().collection)
        return info.count == 0
    except Exception:  # noqa: BLE001
        return False


_WORD = re.compile(r"[a-zA-Z0-9]+")
_STOP = set("the a an and or of to in for on with is are be by as at it this that from was what how when which "
            "who do does can i my your their should".split())


def _tokens(text: str) -> list[str]:
    return [w for w in (m.lower() for m in _WORD.findall(text)) if w not in _STOP and len(w) > 1]


async def _keyword_search(query: str, k: int) -> list[dict]:
    async with open_session() as s:
        rows = (await s.execute(select(Chunk.title, Chunk.text))).all()
    if not rows:
        return []
    docs = [Counter(_tokens(t)) for _, t in rows]
    q = set(_tokens(query))
    n = len(docs)
    df = {w: sum(1 for d in docs if w in d) for w in q}
    avg = sum(sum(d.values()) for d in docs) / n
    scored = []
    for (title, text), d in zip(rows, docs):
        length = sum(d.values()) or 1
        score = sum(math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5)) * d[w] * 2.2 / (d[w] + 1.2 * (0.25 + 0.75 * length / avg))
                    for w in q if d.get(w))
        if score > 0:
            scored.append((score, title, text))
    scored.sort(reverse=True)
    top = scored[0][0] if scored else 1
    return [{"title": t, "snippet": x, "score": round(sc / top, 3)} for sc, t, x in scored[:k]]


async def search(query: str, k: int = 5) -> list[dict]:
    """[{title, snippet, score}] best first."""
    k = max(1, min(k, 10))
    if llm.embeddings_ready():
        try:
            await _ensure_collection()
            vec = await llm.embeddings().aembed_query(query)
            res = await client().query_points(get_settings().collection, query=vec, limit=k, with_payload=True)
            hits = [{"title": p.payload["title"], "snippet": p.payload["text"], "score": round(p.score, 3)}
                    for p in res.points]
            if hits:
                return hits
        except Exception as e:  # noqa: BLE001
            log.warning("Vector search failed (%s); using keywords", type(e).__name__)
    return await _keyword_search(query, k)


def context_block(hits: list[dict], limit: Optional[int] = None) -> str:
    return "\n\n".join(f"[{i}] {h['title']}\n{h['snippet']}" for i, h in enumerate(hits[:limit] if limit else hits, 1))
