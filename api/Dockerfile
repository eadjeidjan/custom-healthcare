# SickleGuard API and MCP server (one image, two processes: see deploy/docker-compose.yml).
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

FROM python:3.12-slim
COPY --from=uv /uv /uvx /usr/local/bin/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv PATH="/opt/venv/bin:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
# /app/data (uploaded files) is a volume in production: created here owned by the app user, so a new named volume
# starts with that ownership and the app can write to it.
RUN uv sync --frozen --no-dev && mkdir -p models data && chown -R app:app /app
USER app
# The risk model ships inside the image (models/ is not in git): trained here, so each image tag has its own model.
RUN python -m app.train --no-report
EXPOSE 8210 8211
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8210/api/v1/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8210", "--proxy-headers", "--forwarded-allow-ips", "*"]
