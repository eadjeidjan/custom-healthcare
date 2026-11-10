# SickleGuard API (v1)

SickleGuard predicts the risk of a vaso-occlusive crisis (VOC) in the next 7 days for people with sickle cell
disease, explains why, and suggests prevention steps. It is decision support for a care team, not a diagnosis.

Base path `/api/v1`. JSON everywhere. Every route except `/health` and `/auth/login` needs
`Authorization: Bearer <token>`. Errors: `{"detail": "message"}` with 400/401/403/404/409/422.
Dates are ISO strings (`2026-11-10` for days, `2026-11-10T08:15:00Z` for times).

## Auth
- `POST /auth/login` `{email, password}` → `{token, user: User}`
- `GET /me` → `User`

`User = {id, email, name, role: "admin" | "clinician"}`

## Health
- `GET /health` → `{ok: true, version: "1.0.0", openai: bool, qdrant: bool, mcp: bool, model: {version, auc}}`

## Dashboard
- `GET /dashboard` →
```json
{
  "patients": 12,
  "levels": {"low": 5, "moderate": 4, "high": 2, "critical": 1},
  "open_alerts": 3,
  "checkins_today": 7,
  "crises_30d": 2,
  "watchlist": [PatientRow],          // highest risk first, up to 8
  "trend": [{"date": "2026-10-12", "avg_score": 22.5, "high": 2}]   // last 30 days, cohort
}
```

## Patients
`RiskLevel = "low" | "moderate" | "high" | "critical"`

`PatientRow = {id, mrn, name, age, sex: "F"|"M", genotype: "HbSS"|"HbSC"|"HbSβ0"|"HbSβ+",
  on_hydroxyurea: bool, crises_12m: int, risk: {score: number, level: RiskLevel, at: string} | null,
  last_checkin: string | null, red_flags: string[]}`

`Patient = PatientRow + {date_of_birth, phone, hb_baseline: number, hbf_percent: number | null,
  care_team: string, notes: string, created_at}`

- `GET /patients?q=&level=` → `PatientRow[]` (sorted by risk score, highest first)
- `POST /patients` `{mrn, name, date_of_birth, sex, genotype, on_hydroxyurea, hb_baseline, hbf_percent?, phone?, care_team?, notes?, crises_12m?}` → `Patient`
- `GET /patients/{id}` → `Patient`
- `PATCH /patients/{id}` (any of the POST fields) → `Patient`

### Daily check-ins
`CheckIn = {id, patient_id, date, pain: 0-10, hydration_litres, sleep_hours, stress: 0-10,
  temperature_c, spo2 | null, cold_exposure: bool, infection_symptoms: bool, chest_symptoms: bool,
  neuro_symptoms: bool, menstruating: bool | null, alcohol: bool, strenuous_activity: bool,
  hydroxyurea_taken: bool | null, hb | null, wbc | null, retic_percent | null, ldh | null, notes, created_at}`

- `GET /patients/{id}/checkins?days=30` → `CheckIn[]` (newest first)
- `POST /patients/{id}/checkins` (CheckIn fields without id/patient_id/created_at; `date` defaults to today;
  one per day: posting the same date replaces it) → `{checkin: CheckIn, assessment: Assessment}`
  (a quick model-only assessment is made on every check-in)

### Crisis events (what actually happened; used to check the model)
`Crisis = {id, patient_id, date, severity: "mild"|"moderate"|"severe", hospitalised: bool, notes}`
- `GET /patients/{id}/crises` → `Crisis[]`
- `POST /patients/{id}/crises` `{date, severity, hospitalised, notes?}` → `Crisis`

### Risk assessments
```
Assessment = {
  id, patient_id, created_at, kind: "checkin" | "ai",
  score: number,                 // 0-100 = model probability of a VOC within 7 days x 100
  level: RiskLevel,              // red flags force "critical"
  probability: number,           // 0-1
  factors: [{key, label, value: string, impact: number, direction: "up" | "down"}],  // biggest first; impact in score points
  red_flags: [{key, label, action}],    // e.g. fever >= 38.5 °C -> "Go to the emergency department now"
  summary: string | null,        // AI explanation (kind "ai" only; null when no OpenAI key)
  plan: [{action, why, who: "patient" | "care team", urgency: "now" | "today" | "this week"}],
  sources: [{title, snippet, score}],   // guideline passages used (RAG)
  model_version: string,
  disclaimer: string
}
```
- `GET /patients/{id}/assessments?days=60` → `Assessment[]` (newest first; for the trend chart)
- `POST /patients/{id}/assess` → `Assessment` (full LangGraph pipeline: data → model → guidelines (RAG) → AI plan →
  safety check; takes 5–20 s with OpenAI; without a key it still returns a rule-based plan, summary null)

## Alerts
`Alert = {id, patient_id, patient_name, created_at, level: RiskLevel, score, reason, status: "open" | "acknowledged",
  acknowledged_by: string | null, acknowledged_at: string | null}`
- `GET /alerts?status=open|acknowledged|all` → `Alert[]` (newest first)
- `POST /alerts/{id}/ack` `{note?}` → `Alert`

## Care assistant (AI agent, LangGraph + MCP tools + RAG)
- `POST /assistant/chat` `{message, thread_id?: string, patient_id?: string}` → **Server-Sent Events** (POST, read the
  stream with fetch). Each event is `data: <json>`:
  - `{"type": "thread", "thread_id": "..."}` first
  - `{"type": "token", "text": "..."}` answer text as it is written (markdown)
  - `{"type": "tool", "name": "predict_voc_risk", "args": {...}}` when the agent calls a tool
  - `{"type": "tool_result", "name": "...", "preview": "first 300 chars"}`
  - `{"type": "sources", "items": [{title, snippet, score}]}`
  - `{"type": "blocked", "message": "..."}` guardrail stopped the question (then done)
  - `{"type": "error", "message": "..."}`
  - `{"type": "done"}` last
- `GET /assistant/threads` → `[{id, title, patient_id, updated_at}]`
- `GET /assistant/threads/{id}` → `{id, title, patient_id, messages: [{role: "user"|"assistant", content, tools?: string[]}]}`
- `GET /assistant/tools` → `[{name, description, source: "mcp" | "local"}]`

## Knowledge (RAG over sickle cell guidance)
`Doc = {id, title, filename, chunks: int, status: "indexed" | "pending" | "failed", error: string | null, created_at}`
- `GET /knowledge` → `Doc[]`
- `POST /knowledge` multipart `file` (.md, .txt, .pdf) → `Doc` (admin)
- `DELETE /knowledge/{id}` → `{ok: true}` (admin)
- `GET /knowledge/search?q=...&k=5` → `[{title, snippet, score}]`

## Model card
- `GET /model` → `{version, trained_at, algorithm, training_rows, positive_rate, auc, brier, thresholds:
  {moderate, high, critical}, features: [{key, label, weight, description}], data_note, limitations: string[]}`
