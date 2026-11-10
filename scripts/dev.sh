#!/usr/bin/env bash
# Local development on this Mac.
#   dev.sh up      Postgres + Qdrant (docker), API :8210, MCP :8211 and web :5310 (Vite in node:22 docker)
#   dev.sh down    stop the docker services (data kept in volumes sg-dev_dev-db / sg-dev_dev-qdrant)
#   dev.sh test    API tests (no OpenAI key needed)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="$ROOT/api"
DC=(docker compose -f "$ROOT/scripts/docker-compose.yml")
case "${1:-up}" in
  up)
    "${DC[@]}" up -d --wait db qdrant
    [ -f "$API/.env" ] || { echo "Create api/.env first (see api/.env.example)"; exit 1; }
    trap 'kill 0' EXIT
    (cd "$API" && uv run uvicorn app.main:app --port 8210 --reload) &
    (cd "$API" && uv run python -m app.mcp_server) &
    docker run --rm --name sg-dev-web -p 5310:5310 -v "$ROOT/web:/app" -v sg-dev-web-node-modules:/app/node_modules \
      -w /app -e API_PROXY_TARGET=http://host.docker.internal:8210 node:22-alpine \
      sh -c "npm install --no-audit --no-fund && npm run dev -- --host 0.0.0.0 --port 5310" &
    echo "SickleGuard: http://localhost:5310  (API docs http://localhost:8210/api/docs)"
    wait ;;
  down) "${DC[@]}" down; docker rm -f sg-dev-web >/dev/null 2>&1 || true; echo "✓ stopped (data kept)" ;;
  test) cd "$API" && uv run python -m pytest -q ;;
  *) sed -n '2,6p' "$0" ;;
esac
