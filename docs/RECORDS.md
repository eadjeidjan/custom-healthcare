# Records: IoT devices, labs, imaging

The "records" work stream adds the data that sits next to daily check-ins: readings from devices, lab results and
imaging. All endpoints are under `/api/v1` and are **staff only** (`admin` or `clinician`), except
`POST /ingest/readings`, which a device calls with its own key. The contract is in `docs/API.md` (v1.1); this page
covers the rules behind it.

Code: `api/app/devices.py`, `api/app/labs.py`, `api/app/imaging.py`, `api/app/routers/records.py`,
web `web/src/records/*` (tabs on the patient page). Tests: `api/tests/test_records.py`.

## Devices and readings

| Kind | Metrics |
| --- | --- |
| `wearable` | heart_rate, hrv_rmssd, skin_temp_c, steps, sleep_minutes, resp_rate |
| `pulse_oximeter` | spo2, heart_rate |
| `smart_bottle` | fluid_ml |
| `thermometer` | body_temp_c |

- **Registration** `POST /patients/{id}/devices` returns `api_key` once (`sgd_<device id>_<secret>`). The database
  keeps only `bcrypt(sha256(key))` in `token_hash` (bcrypt reads at most 72 bytes, so it hashes the key's SHA-256).
  Seed scripts can use `devices.new_key(device_id)` and `devices.hash_key(key)`. `POST /devices/{id}/rotate-key`
  issues a new key, and the old one stops working.
- **Ingest** `POST /ingest/readings`, header `X-Device-Key`, body `{readings: [{metric, value, ts?}], battery?}`.
  At most 1000 readings per request (422 above that). Each reading is checked on its own, and bad ones are rejected
  while the rest are stored: `{accepted, rejected, errors[]}`. A reading is rejected when the metric is unknown, the
  value is outside its plausible range, or `ts` is more than 7 days old or more than 5 minutes in the future. The
  device's `last_seen` and `battery` are updated. A retired device gets 403, and an unknown key gets 401.

  | Metric | Unit | Plausible range | Daily value |
  | --- | --- | --- | --- |
  | heart_rate | bpm | 25–250 | mean (and resting) |
  | hrv_rmssd | ms | 1–300 | mean |
  | spo2 | % | 50–100 | mean |
  | skin_temp_c / body_temp_c | °C | 20–43 / 32–43.5 | mean |
  | resp_rate | /min | 4–60 | mean |
  | steps | steps | 0–50 000 | **sum** |
  | sleep_minutes | min | 0–1440 | **sum** |
  | fluid_ml | mL | 0–5000 | **sum** |

  `steps`, `fluid_ml` and `sleep_minutes` are **increments** (one drink, steps since the last push, one night). The
  daily value is their sum, so never send running totals.
- **Status**: `active` / `retired` are stored. The API reports `offline` when the device hasn't been seen for 6 hours.
- **Vitals** `GET /patients/{id}/vitals?days=14` (1–90): daily `{date, mean, min, max, n, value}` per metric.
  For the sum metrics (steps, sleep, fluids), `mean`, `value`, `total` and `sum` all hold the **daily sum**, matching
  `app.features.daily_aggregates`; `min`/`max` stay per reading. Heart rate also has `resting` (the mean of the lowest
  quarter of that day's readings). Other fields:
  - `baselines`: the median daily value over the 14 full days before today, needing at least 3 days. For heart rate
    this is the median *resting* rate.
  - `baseline_bands`: the interquartile range of those days, drawn as the shaded band on the charts.
  - `latest`: the newest reading per metric.
  - `alerts`: the rules below.
- **Units**: temperatures are stored and returned in °C. Alert messages and record-summary values show °C and °F
  (`app.units.temp`); the web shows both everywhere.
- **Device alerts** (they prompt a check and don't make a diagnosis):

  | Rule | Severity |
  | --- | --- |
  | SpO₂ < 92 % for ≥ 15 min in the last 24 h. A reading counts until the next one, for at most 60 min. | severe |
  | Body temperature ≥ 38.5 °C in the last 24 h | severe |
  | Resting heart rate over the last 24 h (a night included) ≥ 120 % of the 14-day resting baseline | moderate |
  | Fluid intake yesterday < 1.5 L (smart bottle) | moderate |
  | HRV today ≤ 70 % of baseline | moderate |

- **Raw readings** `GET /patients/{id}/readings?metric=&hours=48`, capped at 14 days and 20 000 points.

### Live sample feed
No real devices are connected yet, so `devices.run_feed()` adds readings every 60 s for each **simulated**,
non-retired device of a **featured** patient. New values follow the patient's own data:

- point metrics do a random walk toward the patient's **hour-of-day profile** over the last 7 days plus the **recent
  trend** (24 h mean minus 7-day mean, capped at ±15). Nights stay lower than days, a deteriorating patient keeps
  deteriorating, and metrics recorded only at certain hours (sleep HRV and respiratory rate) are only added at those
  hours;
- heart rate, SpO₂ and steps: every minute; HRV, skin temperature and respiratory rate: every 5 minutes;
  thermometer: every 4 hours, at hours the patient usually measures;
- steps follow an activity curve scaled to the last 3 full days' daily total; drinks every 50–110 minutes between
  06:00 and 23:00, sized from the daily total; sleep once each morning.

Battery slowly drains and recharges.

The router's `lifespan` (FastAPI merges a router's lifespan into the app's when it is included) starts and stops the
feed. It is on when `SIMULATE_DEVICES` is true. When the variable is unset, it defaults to on in development with
Postgres, and off in production and in tests (SQLite).

## Labs

Catalogue (adult reference ranges; Hb and creatinine are sex-specific):

| Code | Name | Unit | Reference |
| --- | --- | --- | --- |
| hb | Haemoglobin | g/dL | F 12–15.5, M 13–17 |
| wbc | White cell count | ×10⁹/L | 4–11 |
| anc | Neutrophils (ANC) | ×10⁹/L | 2–7.5 |
| plt | Platelets | ×10⁹/L | 150–400 |
| retic | Reticulocytes | % | 0.5–2.5 |
| ldh | LDH | U/L | 140–280 |
| bili | Bilirubin (total) | µmol/L | 3–21 |
| hbf | HbF | % | 0–2 |
| crp | CRP | mg/L | 0–5 |
| creat | Creatinine | µmol/L | F 45–90, M 60–110 |
| ferritin | Ferritin | µg/L | 15–300 |

`flag` is `low` or `high` against these ranges. Many people with sickle cell disease live outside adult ranges
(Hb 6–9 g/dL, high reticulocytes and LDH), so the record summary also compares Hb with the patient's own
`hb_baseline` and flags a fall of 2 g/dL or more.

- **Units** are converted to the catalogue unit:
  - Hb: g/L, mmol/L
  - bilirubin and creatinine: mg/dL
  - CRP: mg/dL
  - retic and HbF: fraction
  - LDH: µkat/L
  - counts: 10\*3/uL, K/uL

  Any other unit is an error. Values outside a plausible range are rejected as entry errors.
- **Manual** `POST /patients/{id}/labs` `{code, value, unit?, taken_at?}`. `code` may be our code, a name alias or a
  LOINC code.
- **Import** `POST /patients/{id}/labs/import` (≤ 5 MB):
  - **CSV** `taken_at,code,value[,unit]`, with or without a header row; `#` lines are comments.
  - **FHIR R4** Bundle, or a single Observation. Observations are mapped by `code.coding` with the LOINC system.
    The value comes from `valueQuantity`, and the time from `effectiveDateTime`, then `effectivePeriod.start`, then
    `issued`. Observations with status entered-in-error, cancelled or registered are skipped, as are unknown codes
    and non-Observation resources.

  Duplicates (same code, time and value) are skipped. The result is `{imported, skipped, errors}`.
- **LOINC map**:

  | Code | LOINC |
  | --- | --- |
  | hb | 718-7, 20509-6, 30313-1, 59260-0, 30350-3 |
  | wbc | 6690-2, 26464-8, 804-5 |
  | anc | 751-8, 753-4, 26499-4 |
  | plt | 777-3, 26515-7, 778-1 |
  | retic | 4679-7, 17849-1, 31111-8 |
  | ldh | 2532-0, 14804-9, 14805-6 |
  | bili | 1975-2, 14631-6, 42719-5 |
  | hbf | 4576-5 |
  | crp | 1988-5, 30522-7, 76485-2 |
  | creat | 2160-0, 14682-9, 38483-4 |
  | ferritin | 2276-4, 24373-3, 20567-4 |

- `DELETE /labs/{id}` removes a result entered by mistake.

## Imaging

- **Upload** `POST /patients/{id}/imaging` (multipart):
  - fields: `modality`, `study_date` (not in the future), `body_part`, `indication`, `report`, `impression`,
    `tcd_velocity`, `second_look` (default true) and an optional `file`;
  - the file must be JPEG, PNG or PDF, recognised by its **magic bytes**, and no larger than 15 MB;
  - a wrong type gets 415 and a file that is too large gets 413;
  - the file is stored as `data_dir/imaging/<patient id>/<study id>.<ext>`, with the path relative to
    `data_dir/imaging`.
- **Findings** from the report and impression:
  - With an OpenAI key, `llm.chat_model().with_structured_output(...)` maps the text to codes and ignores negated
    findings. Without a key, keyword rules run per clause and ignore matches that come after "no", "without",
    "negative for", and similar.
  - Severity comes from the code, not from the model:

    | Severity | Codes |
    | --- | --- |
    | severe | acs_infiltrate, stroke, tcd_abnormal |
    | moderate | tcd_conditional, silent_infarct, avn_hip, avn_shoulder, splenomegaly, cardiomegaly |
    | info | gallstones, normal, other |

  - The response has `findings_method: "ai" | "rules"`.
- **TCD** uses the STOP thresholds on TAMMV: < 170 cm/s normal, 170–199 conditional, ≥ 200 abnormal. The value comes
  from `tcd_velocity`, or from "NNN cm/s" in the report of a `tcd` study.
- **AI second look** runs on uploaded images (not PDFs). OpenAI vision (gpt-4.1-mini) receives the image as a data
  URL in a LangChain content part. The model first states what the image is from the pixels alone, and is told the
  stated modality and indication are not evidence. If the image is not a readable medical image, it returns no
  findings. The response carries `ai_summary`, `ai_findings` and `ai_label` = *"AI second look, not a radiology
  report; the radiologist's report is authoritative."* Any dose is removed from the text. `POST
  /imaging/{id}/second-look` runs it again.
- **File** `GET /imaging/{id}/file` needs the bearer token. The web fetches it and shows it through an object URL. A
  stored path outside `data_dir/imaging` is never served (404). Responses carry `nosniff` and `no-store`.
  `DELETE /imaging/{id}` removes the study and its file.

## Record summary (feeds the prediction)
`GET /patients/{id}/record-summary` → `{labs_latest, imaging_flags, devices, devices_online, vitals_alerts,
risk_inputs, generated_at}`.

- `imaging_flags`: the newest abnormal finding per code, worst first, with `study_date`. A newer normal TCD
  supersedes an older abnormal one.
- `risk_inputs`: a flat list `{source, key, label, value (display), number, flag, at}` with these keys:

  | Source | Keys |
  | --- | --- |
  | device | spo2_latest, resting_hr, temp_max_48h, fluid_yesterday, steps_yesterday, sleep_last, hrv_today |
  | lab | each code (Hb with its delta from baseline) |
  | imaging | finding codes |
  | checkin | pain, hydration, days_since_checkin |

`app.routers.records.record_summary(session, patient)` can be called directly by the risk pipeline.

## MCP tools
`get_vitals`, `get_labs`, `get_imaging_findings` and `get_record_summary` are on the MCP server and in the assistant's
in-process tool list.

## Web
On the patient page, the tabs are:

- **Overview**: as before, plus a "From the record" panel.
- **Vitals & devices**: live charts every 60 s with the baseline band, device alerts, a 48 h detail view, device cards,
  and an add-device dialog that shows the key once with a curl example.
- **Labs**: the latest value per test with a trend line, the table, add, and CSV/FHIR import.
- **Imaging**: timeline, findings, TCD bar, report, an image or PDF viewer, and the AI second look with its disclaimer.
- **Check-ins**: 30-day trends and history.

The red-flag banner stays above the tabs. The selected tab is in `?tab=`.
