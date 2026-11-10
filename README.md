# SickleGuard — VOC early warning (v1)

SickleGuard predicts the risk of a **vaso-occlusive crisis (VOC)** in the next 7 days for people with sickle cell
disease, explains what is driving it, and suggests prevention steps, so a care team can act before a crisis.

> Decision support only, not a diagnosis. The risk model is trained on **synthetic data** and must be retrained and
> validated on real outcomes before any clinical use. Red flags always mean: seek emergency care.

## What it does
- **Daily check-ins** (pain, fluids, sleep, stress, temperature, SpO2, cold, infection, chest/stroke symptoms,
  menstruation, alcohol, exertion, hydroxyurea taken, optional Hb/WBC/reticulocytes/LDH) → instant **7-day risk score**
  (0–100, low/moderate/high/critical) with the **factors** behind it in score points.
- **Red-flag rules** (fever ≥38.5 °C, chest symptoms, stroke signs, SpO2 <92 %, severe pain, Hb fall ≥2 g/dL) always
  override the model.
- **AI assessment** (LangGraph pipeline): score → retrieve guidance (RAG) → OpenAI writes a summary and prevention plan
  with citations → safety step (red flags first, no medicine doses) → save + alert.
- **Care assistant**: a LangChain agent with conversation memory whose tools come from SickleGuard's **MCP server**
  (patients, check-ins, risk model, guidance search, alerts, care-team messages); streams answers with tool calls and
  sources; guardrails on input and output.
- **Alerts** when a patient reaches high/critical, **dashboard** with watchlist and cohort trend, **knowledge base**
  (upload guidance, search it), **model card** (AUC, weights, limitations).

## Stack
| Part | Technology |
| --- | --- |
| LLM + embeddings | OpenAI (gpt-4.1-mini, text-embedding-3-small) via LangChain |
| Orchestration | LangGraph (assessment graph; agent runtime + Postgres checkpointer) |
| Vector DB / RAG | Qdrant (meaning search) + keyword fallback in Postgres |
| Tools | MCP server (FastMCP, streamable HTTP) + langchain-mcp-adapters |
| Risk model | scikit-learn logistic regression, explainable per factor |
| API | FastAPI, SQLAlchemy 2 (async), Postgres 17 |
| Web | React 18, Vite, TypeScript, Tailwind 4 |
| Deploy | Docker Compose, nginx, Caddy (HTTPS) |

```
web (React) ──/api──▶ FastAPI ──▶ risk model (scikit-learn) + red-flag rules
                         │──▶ LangGraph assessment: score → RAG (Qdrant) → OpenAI plan → safety → save/alert
                         └──▶ care assistant (LangChain agent) ──MCP──▶ MCP server ──▶ Postgres / model / Qdrant
```

## Run locally (Mac)
1. `cp api/.env.example api/.env` and fill it (or keep the generated one); put your key in `OPENAI_API_KEY=`.
2. `scripts/dev.sh up` → http://localhost:5310 (API docs http://localhost:8210/api/docs).
3. Sign in as `ADMIN_EMAIL` with `ADMIN_PASSWORD` from `api/.env`. 12 fictional demo patients are created on first start.

Ports: web 5310, API 8210, MCP 8211, Postgres 5470, Qdrant 6350. Tests: `scripts/dev.sh test` (no key needed).
Without an OpenAI key everything works except the AI summary and the assistant (keyword search, rule-based plans).

## Deploy (server)
```
git clone <repo> && cd <repo>
scripts/sg init      # deploy/.env with random secrets; asks for the OpenAI key (hidden)
scripts/sg up        # build + start: db, qdrant, api, mcp, web on 127.0.0.1:8310
scripts/sg edge      # optional HTTPS via Caddy for DOMAIN in deploy/.env
scripts/sg status | logs | backup | update | test | down
```

## Layout
`api/app` — `risk.py` (features, model, explanations, red flags), `pipeline.py` (LangGraph assessment),
`assistant.py` (agent + guardrails), `mcp_server.py`, `rag.py`, `care.py`, `seed.py`, `routers/`.
`api/knowledge` — sickle cell guidance indexed for RAG. `web/` — the app. `deploy/`, `scripts/` — running it.
API contract: `docs/API.md`.
