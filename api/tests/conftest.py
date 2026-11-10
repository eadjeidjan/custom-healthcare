import os

os.environ.update(DATABASE_URL="sqlite+aiosqlite:///:memory:", QDRANT_URL=":memory:", OPENAI_API_KEY="",
                  ADMIN_PASSWORD="test-pass-123", JWT_SECRET="test-secret-0123456789abcdef0123456789", MCP_TOKEN="", SEED_DEMO="true",
                  MCP_URL="http://127.0.0.1:9/mcp")

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402


@pytest.fixture(scope="session")
async def client():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app import db
    db._engine = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool,
                                     connect_args={"check_same_thread": False})
    db._maker = async_sessionmaker(db._engine, expire_on_commit=False)
    from app.main import app, load_knowledge
    async with app.router.lifespan_context(app):
        await load_knowledge()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/api/v1/auth/login", json={"email": "admin@sickleguard.local", "password": "test-pass-123"})
            c.headers["Authorization"] = f"Bearer {r.json()['token']}"
            yield c
