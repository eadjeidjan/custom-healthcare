"""SickleGuard API. Run with `uvicorn app.main:app --port 8210`."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from app import assistant, db, rag, risk, seed
from app.config import VERSION, get_settings
from app.routers import ai, core, patients, policy, portal, records
from app.security import hash_password

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")


async def ensure_admin() -> None:
    s = get_settings()
    async with db.open_session() as session:
        if await session.scalar(select(func.count()).select_from(db.User)):
            return
        if not s.admin_password:
            log.warning("No users yet and ADMIN_PASSWORD is empty: set it to create the first administrator.")
            return
        session.add(db.User(email=s.admin_email.lower(), name="Administrator",
                            password_hash=hash_password(s.admin_password), role="admin"))
        await session.commit()


async def load_knowledge() -> None:
    try:
        n = await rag.load_folder()
        if not n and await rag.vectors_missing():   # key added after a keyword-only start: build the vectors now
            n = await rag.load_folder(reindex_vectors=True)
        if n:
            log.info("Indexed %d guidance documents", n)
    except Exception as e:  # noqa: BLE001
        log.warning("Guidance indexing failed: %s", e)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.create_tables()
    await ensure_admin()
    risk.model()
    if get_settings().seed_demo and await seed.seed():
        log.info("Seeded demo patients")
    await assistant.start()
    task = asyncio.create_task(load_knowledge())
    yield
    task.cancel()
    await assistant.stop()
    await db.dispose()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="SickleGuard API", version=VERSION, lifespan=lifespan,
                  description="Vaso-occlusive crisis early warning for sickle cell disease.",
                  docs_url=None if s.is_production else "/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in s.cors_origins.split(",") if o.strip()],
                       allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
    for r in (core.router, patients.router, ai.router, records.router, portal.router, policy.router):
        app.include_router(r, prefix="/api/v1")
    return app


app = create_app()
