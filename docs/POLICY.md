# Policy dashboard: data, methods and privacy

The policy dashboard (`/policy`, role `policy`; admins can open it too) gives ministries, regional health directorates
and programme managers a population view of sickle cell disease (SCD) in the SickleGuard registry: vaso-occlusive
crises (VOC), hospital use, current risk, what drives it and what interventions might achieve.

> **Synthetic data.** The registry used in development and demos is simulated. Counts, rates and costs are not real
> Ghana statistics. The risk model is trained on synthetic data and must be validated on real outcomes before use.

Code: `api/app/analytics.py` (all calculations), `api/app/routers/policy.py` (endpoints), `web/src/policy/` (UI),
`api/tests/test_policy.py` (roles, privacy floor, no identifiers, CSV).

## Privacy floor
- Only aggregates are returned. No names, MRNs, internal ids, dates of birth, phone numbers or free text (patient notes,
  crisis notes) ever leave `analytics.py`; its snapshot never loads those columns.
- **Any group built from fewer than 5 patients is suppressed** (`MIN_GROUP = 5`): counts become `"<5"`, rates and
  averages `null`, and the row carries `suppressed: true`.
  - Regions with 1–4 patients: suppressed. Regions with 0 patients: `patients: 0`, other fields `null`.
  - Facilities with fewer than 5 patients are **pooled and not named** ("Other facilities"); the pool is itself
    suppressed if it has fewer than 5 patients.
  - Months whose crises come from 1–4 distinct patients: crises `"<5"`, admissions/bed-days `null`. Monthly average
    risk is hidden when fewer than 5 patients were assessed that month.
  - Risk factors present in fewer than 5 patients are pooled ("Other modifiable factors", "Other factors").
  - If the whole registry has fewer than 5 patients, the overview, forecast and scenarios are suppressed.
- Tests create 8 patients in one region and 3 in another and check that the small region, the small facilities and
  every patient name, last name, MRN, id, date of birth, phone and note are absent from all policy responses and the CSV.

## Endpoints (base `/api/v1/policy`, role policy or admin; clinician and patient get 403)
| Endpoint | Returns |
| --- | --- |
| `GET /overview?cost_per_bed_day=&ed_visit_cost=` | national KPIs + `deltas` vs the previous 12 months |
| `GET /regions?cost_per_bed_day=` | 16 regions: patients, `per_100k`, crises, `crises_per_100k`, admissions, bed-days, LOS, hydroxyurea coverage, average risk, high risk now, cost, `suppressed` |
| `GET /facilities` | facilities with ≥5 patients, plus a pooled row |
| `GET /trends?months=12&region=` | monthly crises, admissions, bed-days, average risk |
| `GET /forecast?weeks=8&region=&detail=` | weekly expected crises with a 90 % band, admissions, bed-days (`detail=true` adds seasonality and rates) |
| `GET /seasonality` | monthly index used by the forecast |
| `GET /drivers?detail=` | share of modelled risk by factor, modifiable flag, programme lever |
| `GET /interventions?cost_per_bed_day=&ed_visit_cost=&hu_target=0.6&detail=` | five scenarios with assumptions (`detail=true` adds the baseline and formula) |
| `GET /meta` | privacy floor, population source, model version, effect sizes, research context |
| `GET /export.csv` | regional table + national row as CSV (suppressed cells `<5`/blank) |

## Methods
**Periods.** "12 months" = the 365 days to today; deltas compare with the 365 days before that. Hydroxyurea
coverage and current risk have no history in the data model, so they have no delta.

**Current risk.** A patient's latest assessment counts as current if it is ≤30 days old. Patients without one use their
baseline 7-day probability `1 − exp(−rate × 7/365)`, where `rate` is the larger of crises recorded in the last 12 months
and the patient's `crises_12m` field.

**Length of stay and cost.** Bed-days = sum of `los_days` of admitted crises; when missing, the mean recorded LOS, else
**3 days**, the national median for SCD admissions (Narh et al., BMJ Open 2021;11:e048407, DHIMS-II 2012–2017,
n = 22,680). Estimated cost = bed-days × cost per bed-day + non-admitted crises × cost per emergency visit. Defaults
**GHS 600 per bed-day** and **GHS 250 per non-admitted crisis** are illustrative placeholders: the research review
found no published Ghana cost per VOC bed-day (insurer claims in Marfo et al., BMC Health Serv Res 2023 report much
lower, tariff-based costs). Both are query parameters and editable in the UI.

**Per 100k.** Count ÷ region population × 100,000 using the **Ghana 2021 Population and Housing Census** (GSS, General
Report Vol 3A; sum 30,832,019). Read from `docs/research/sim_params.json` (`ghana_policy.regions.list`) when present,
otherwise the same figures built into `analytics.CENSUS_2021`. The registry only contains patients known to SickleGuard
facilities, so these rates are not prevalence.

**Seasonality.** For each calendar month: `index = (crises_m + K·prior_m) / (months_observed_m × mean_per_month + K)`
with K = 50 pseudo-crises and only months since the first recorded crisis counted as observed; normalised to mean 1.
The prior puts the Harmattan (cold, dry, dusty Dec–Feb) high: Dec 1.20, Jan 1.25, Feb 1.15, Mar/Nov 1.0, others
0.92–0.95. The size of the Harmattan effect in Ghana is not well quantified (sim_params.json: weather effects are
low/medium confidence, mostly European data), so with real data the registry's own seasonality takes over.

**Forecast (8 weeks).** For week h, each patient contributes
`p = clip((base + (p_now − base) × 0.5^(weeks ahead)) × S(week) / S(now))`: the current 7-day probability fades back
to the patient's own baseline with a one-week half-life, scaled by the season index. Expected crises = Σp. The 90 %
band is `mean ± 1.645·sd` with `sd² = Σp(1−p) + (r·mean)²`, `r = 0.10 + 0.025·h` (event chance plus model/season
uncertainty that grows with the horizon). Expected admissions = crises × registry admission rate (≥10 crises, else 45 %);
bed-days = admissions × average LOS.

**Risk drivers.** Each assessment's `factors` carry `impact` in score points (risk now minus risk with that factor at
its normal value, `app/risk.py`). Positive impacts are summed over current assessments; `share_of_risk` = factor sum ÷
total. Modifiable: low fluid intake, cold exposure, infection symptoms, raised temperature, low oxygen, missed
hydroxyurea, short sleep, stress, alcohol, strenuous activity. Not modifiable here: pain, pain trend, genotype, HbF,
prior crises, labs. These describe the model, not proven causation.

## Intervention scenarios
For each scenario: `fraction` = reach (slider), or for hydroxyurea `(target − current) / (1 − current)` of patients not
yet on it.
```
crises_avoided     = target_crises × fraction × effect_crises
admissions_avoided = crises_avoided × admission_rate + target_admissions × fraction × effect_admissions
bed_days_saved     = admissions_avoided × avg_los + (target_admissions × fraction − admissions_avoided) × effect_los_days
cost_saved         = bed_days_saved × cost_per_bed_day + (crises_avoided − admissions_avoided) × ed_visit_cost
programme_cost     = target_patients × fraction × cost_per_person;  net = cost_saved − programme_cost
```
The API returns each scenario's inputs (`model`, `slider`, `assumptions`); the web page recomputes with the same
formula as sliders move. Scenarios overlap and are not additive.

| Scenario | Crises it can reach | Effect | Evidence | Source |
| --- | --- | --- | --- | --- |
| Raise hydroxyurea coverage (default 60 %) | yearly crises in patients not on hydroxyurea | −44 % crises (rate ratio 0.56) | high | Charache et al., NEJM 1995;332:1317 (MSH: median 2.5 vs 4.5 crises/yr), via sim_params.json; Tshilolo et al., NEJM 2019;380:121 (REACH, sub-Saharan Africa: VOC 98.3 → 44.6 per 100 patient-years) |
| Hydration programme | crises × share of risk from low fluid intake | −30 % of that | low | Assumption; hydration is guideline advice (NHLBI Expert Panel, Yawn et al., JAMA 2014;312:1033) without a programme trial |
| Cold-season outreach (Harmattan) | crises × seasonal Dec–Feb excess (or cold share) | −25 % of that | low | Assumption; excess from registry seasonality |
| Hydroxyurea adherence support | crises × share of risk from missed hydroxyurea | −40 % of that | moderate | Assumption anchored on hydroxyurea efficacy (MSH, REACH) |
| Faster emergency analgesia | admissions | −10 % admissions, −0.5 day LOS | low | NHLBI Expert Panel 2014 target (analgesia within 60 min); effect sizes are assumptions |

Programme costs per person reached per year (GHS 2,400 hydroxyurea incl. monitoring, 60 hydration, 120 outreach,
180 adherence, 40 analgesia protocol) are illustrative placeholders, editable on each card.

## Context figures (Data & methods page)
When `docs/research/sim_params.json` exists, `/meta.research` shows SCD births per year (official 15,000–18,000 vs
model 5,474: sources conflict), newborn screening coverage, national hydroxyurea uptake (placeholder) and NHIS
coverage, each with its source and confidence from the research review (`docs/research/DATA_SOURCES.md`).

## Model version
`/meta` reports the risk model version and AUC from `app/risk.card()` (AUC on synthetic hold-out data), shown on the
Data & methods page.
