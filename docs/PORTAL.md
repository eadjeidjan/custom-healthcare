# SickleGuard patient portal

The portal is the patient's own SickleGuard: a mobile-first web app where a person with sickle cell disease does a
daily check-in, sees their 7-day crisis outlook in plain words, follows their trends and device readings, reads their
results, learns self-care and asks questions. It **supports the care team, it doesn't replace it**.

Sign in with a `patient` account (`User.patient_id` links it to one patient record). `App.tsx` sends patients to
`/portal/*`; they can't open staff pages and staff can't open the portal.

## Privacy model
- Every portal route depends on `patient_user` and works on `user.patient_id` only. No route takes a patient id from
  the client (a `?patient_id=` is ignored; tests prove it).
- Patients get 403 on all staff routes (`/patients`, `/dashboard`, `/alerts`, …); staff get 403 on `/portal/*`.
- Hidden from patients: clinician `notes`, structured imaging `findings`, the AI "second look" (`ai_summary`,
  `ai_findings`), imaging files, device API keys.
- The portal assistant has **no tools** that can reach other patients: its only data is a summary of the signed-in
  patient built on the server, plus guidance passages.

## API (`api/app/routers/portal.py`, base `/api/v1`)
Implements the "Patient portal" part of `docs/API.md`, with these extra fields:

| Route | Returns |
| --- | --- |
| `GET /portal/me` | `{patient (no notes; + region/district/facility), risk: Assessment\|null, streak_days, checked_in_today, next_steps: PlanItem[], devices, care_team, emergency: {phone: "112", ambulance: "193", care_team_phone, message}}` |
| `GET /portal/checkins?days=30` | `CheckIn[]` newest first |
| `POST /portal/checkins` | same body as staff check-ins → `{checkin, assessment, previous: {score, level, created_at}\|null, next_steps, streak_days}` |
| `GET /portal/risk-history?days=60` | `[{date, score, level}]`, one point per day (that day's latest assessment) |
| `GET /portal/vitals?days=14` | same shape as staff vitals: `{metrics: {metric: [{date, mean, min, max, n, total?}]}, latest, baselines, alerts}` |
| `GET /portal/devices` | `Device[]` (no keys) |
| `GET /portal/records` | `{labs: Lab[] latest per code (+ about, meaning), imaging: [{id, study_date, modality, modality_label, body_part, indication, report, impression}]}` |
| `GET /portal/learn` | `[{title, summary, doc_title, section, icon}]` |
| `POST /portal/ask` `{message, new_conversation?}` | SSE, same events as `/assistant/chat` |
| `GET /portal/ask/history` | `[{role, content}]` (this session's memory) |

**Check-ins** call the staff `add_checkin` function, so scoring, the saved assessment and **staff alerts** are exactly
the same as when a clinician records a check-in (a fever check-in → `critical` + an open alert on the staff side).

**Next steps** are rewritten for patients (`PATIENT_STEPS`): red flag → "Get emergency care now: call 112…" first,
then "Do today's check-in" if not done, then one step per factor raising the risk, topped up with everyday basics
(water, warmth, medicines). Three items, plus the emergency item when there is a red flag.

**Vitals** are aggregated per day in SQL (`func.date(ts)`; works on Postgres and SQLite). Counts (`steps`,
`sleep_minutes`, `fluid_ml`) also get a daily `total`. Baseline = median of the days before the last three. The records
work stream may add a richer staff vitals function in `api/app/devices.py`; `vitals_for()` can switch to it then.

**Learn cards** are hand-written plain-language summaries (reading age about 12), each tied to one section of a
guidance document in `api/knowledge/` (`CARDS` in `portal.py`). The file title and section are checked at load and
cached; a test fails if a card points at a section that no longer exists.

## Patient-safe assistant (`api/app/portal_assistant.py`)
A single grounded OpenAI call per question (no agent, no tools):
1. **Input guardrail**: `assistant.check_input` (prompt injection, length) → `blocked` event with a friendly message.
2. **Emergency first**: if the question has red-flag words (fever, 38.5+ °C, chest pain, can't breathe, stroke signs,
   seizure, priapism/erection, severe/unbearable pain, 8–10/10 pain, swollen tummy, sudden headache…), a fixed
   "call 112 / 193 or go to the emergency department" block is streamed **before** the model says anything.
3. **RAG**: `rag.search(question, 4)` over the guidance (shown as a `search_guidance` tool event and as `sources`).
4. **Prompt**: plain language for a 12-year-old reader, under ~150 words, cite guide titles, never doses or medicine
   changes, never "you don't need a doctor", encourage contacting the care team, only this patient; data and passages
   are marked as information, not instructions. Context = age, genotype, hydroxyurea, latest risk + top factors + red
   flags, last 5 check-ins, latest labs (no clinician notes).
5. **Output checks**: a dose pattern (`mg`, `mcg`, `mg/kg`) or a "no need for a doctor / nothing to worry about"
   phrase appends a safety note.
6. **Memory**: last 6 turns per patient, in process (cleared on restart, "New chat" clears it).

Without an OpenAI key it still streams the emergency block (when relevant), a friendly "assistant offline" message and
the guidance sources.

## Web (`web/src/portal/`)
| File | What |
| --- | --- |
| `PortalApp.tsx` | Layout: sticky top bar with the always-visible red **Emergency** button, bottom tab bar on mobile (Home, Check in, Trends, Ask, More), side nav on desktop; theme |
| `Home.tsx` | Greeting, the gentle half-circle risk dial with plain words ("Low chance of a crisis this week"), what's raising/lowering it, check-in call to action, streak, "Today, try to" (tick off; remembered for the day), warning-signs card, shortcuts |
| `CheckIn.tsx` | Five steps, all pre-filled: pain (emoji + big slider), temperature/oxygen (steppers, "not today" allowed), water cups + sleep, stress (emoji), symptom toggles (+ hydroxyurea yes/not yet, period for women). Inline "call 112" alert as soon as a red-flag answer is given. Result: dial, change since last time, why (factors), what to do now |
| `Trends.tsx` | Risk over 14/30/60 days with soft level bands, pain and water from check-ins, device vitals as small multiples with "your usual" line; tap/hover read-outs |
| `Devices.tsx` | Status, battery, last sync, "Sample device" badge for simulated devices |
| `Records.tsx` | Latest labs with a range bar and a plain-language explanation; imaging summary (impression) + full report on demand |
| `Learn.tsx` | Warning-sign cards and everyday-care cards |
| `Ask.tsx` | Streaming chat with suggestions, sources, "New chat" |
| `More.tsx` | Profile, links, theme, sign out |
| `kit.tsx`, `api.ts`, `portal.css` | Shared pieces (dial, chart, emergency sheet), typed client, theme variables |

**Theme.** Patients get a warm **light** theme by default: it reads better on a phone in daylight, at lower screen
brightness and for older eyes, and feels calmer than a dark "control room". It stays in the SickleGuard family: a dark
navy brand band (hero card) with crimson accents and the same logo; dark mode (the staff palette) is one tap away and
remembered (`sg_portal_theme`). Colors are overridden only inside `.portal`, so the staff app is untouched.

**Temperatures** are stored and sent in °C but always shown in °C and °F (`app.units.temp`, `lib/temp.ts`). In the
check-in the patient picks °C or °F (remembered in `sg_temp_unit`), sees the other unit live, and the value is converted
to °C before it is sent. The assistant is told to give temperatures in both units, and its red-flag check also
recognises Fahrenheit fevers (101–119 °F).

**Emergency numbers (Ghana).** 112 is the national emergency number (police, fire, ambulance); 193 is the National
Ambulance Service's direct line and is still widely listed, so both are shown, 112 first. "Call my care team" uses a
phone number found in the patient's `care_team` field (e.g. "Haematology A (+233 30 …)"); without one the sheet shows
the team name and says to use the number on the clinic card. Review these with the clinical team before launch.

## Tests
`api/tests/test_portal.py`: own data only (me, check-ins, risk history, latest labs, imaging without findings/AI,
vitals; a `?patient_id=` of someone else is ignored), patient → 403 on staff routes, staff/clinician → 403 on portal
routes, unlinked patient → 403, fever check-in → critical + staff alert, learn cards point at real sections, assistant
guardrail / emergency-first / offline mode, and with a fake model: only own data in the prompt, dose and
"no doctor" safety notes, memory.
