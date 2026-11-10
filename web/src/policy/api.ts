// Typed client for the policy endpoints (docs/API.md "Policy dashboard"). Aggregates only; "<5" means suppressed.
import { BASE, authHeaders, errorFrom, onUnauthorized, req } from "../lib/api";

export type Count = number | "<5" | null;

export interface Delta { previous: number | null; change_pct: number | null }
export interface Overview {
  as_of: string; patients: Count; regions: number; facilities: number;
  crises_12m: number | null; admissions_12m: number | null; bed_days_12m: number | null; avg_los: number | null; avg_los_imputed?: boolean;
  admission_rate: number | null; hu_coverage: number | null; high_risk_now: Count; assessed_now: number | null;
  avg_risk_now: number | null; expected_crises_7d: number | null; crises_30d: number | null;
  est_cost_ghs_12m: number | null; cost_per_bed_day_ghs: number; ed_visit_cost_ghs: number; suppressed: boolean;
  period: { current: [string, string]; previous: [string, string] };
  deltas: Partial<Record<"crises_12m" | "admissions_12m" | "bed_days_12m" | "avg_los" | "est_cost_ghs_12m" | "crises_30d", Delta>>;
}
export interface RegionRow {
  region: string; population: number | null; patients: Count; per_100k: number | null;
  crises_12m: number | null; crises_per_100k: number | null; admissions_12m: number | null;
  admissions_per_100k: number | null; bed_days_12m: number | null; avg_los: number | null;
  crises_per_patient: number | null; hu_coverage: number | null; avg_risk: number | null; high_risk_now: number | null;
  est_cost_ghs_12m: number | null; suppressed: boolean;
}
export interface FacilityRow extends Omit<RegionRow, "region" | "population" | "per_100k" | "crises_per_100k" | "admissions_per_100k"> {
  facility: string; region: string | null; pooled?: boolean;
}
export interface TrendRow {
  month: string; crises: Count; admissions: number | null; bed_days: number | null; avg_risk: number | null;
  patients_with_crisis: Count; patients_assessed: Count; suppressed: boolean; risk_suppressed: boolean;
}
export interface ForecastWeek {
  week_start: string; expected_crises: number | null; low: number | null; high: number | null;
  expected_admissions: number | null; expected_bed_days: number | null; season_index: number; harmattan: boolean;
  suppressed: boolean;
}
export interface Forecast {
  weeks: ForecastWeek[]; admission_rate: number; avg_los: number; seasonality: Record<string, number>;
  interval: string; patients: Count;
}
export interface Driver {
  factor: string; label: string; share_of_risk: number; risk_points: number; patients_affected: number | null;
  share_of_patients: number | null; modifiable: boolean; lever: string | null; suppressed: boolean;
}
export interface Drivers { drivers: Driver[]; assessed: Count; modifiable_share: number; suppressed: boolean }
export interface Assumption { label: string; value: string; source: string }
export interface Scenario {
  key: string; label: string; description: string; crises_avoided: number; admissions_avoided: number;
  bed_days_saved: number; cost_saved_ghs: number; programme_cost_ghs: number; net_saving_ghs: number;
  people_reached: number; assumptions: Assumption[]; evidence: "high" | "moderate" | "low";
  model: {
    target_crises: number; target_admissions: number; target_patients: number; effect_crises: number;
    effect_admissions: number; effect_los_days: number; programme_cost_per_person_ghs: number; baseline_coverage: number;
  };
  slider: { param: "coverage" | "reach"; label: string; min: number; max: number; default: number; current?: number };
}
export interface Interventions {
  baseline: null | {
    patients: number; crises_per_year: number; admissions_per_year: number; admission_rate: number; avg_los: number;
    hu_coverage: number; cost_per_bed_day_ghs: number; ed_visit_cost_ghs: number;
  };
  scenarios: Scenario[]; suppressed: boolean; formula?: string;
}
export interface Meta {
  min_group: number; population_source: string; population_total: number; model_version: string;
  model_auc: number | null; current_window_days: number; default_los: number; default_cost_per_bed_day_ghs: number;
  default_ed_visit_cost_ghs: number; season_prior: Record<string, number>; research_file: boolean;
  effects: Record<string, { crises?: number; admissions?: number; los_days?: number; evidence: string; source: string }>;
  programme_cost_ghs: Record<string, number>;
  research: { label: string; value: string; source: string; confidence?: string | null }[];
  as_of: string;
}

const q = (o: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : "";
};

export const policy = {
  overview: (cost: number) => req<Overview>("GET", `/policy/overview${q({ cost_per_bed_day: cost })}`),
  regions: (cost: number) => req<RegionRow[]>("GET", `/policy/regions${q({ cost_per_bed_day: cost })}`),
  facilities: (cost: number) => req<FacilityRow[]>("GET", `/policy/facilities${q({ cost_per_bed_day: cost })}`),
  trends: (months = 24, region?: string) => req<TrendRow[]>("GET", `/policy/trends${q({ months, region })}`),
  forecast: (weeks = 8, region?: string) => req<Forecast>("GET", `/policy/forecast${q({ weeks, region, detail: "true" })}`),
  drivers: () => req<Drivers>("GET", "/policy/drivers?detail=true"),
  interventions: (cost: number) =>
    req<Interventions>("GET", `/policy/interventions${q({ cost_per_bed_day: cost, detail: "true" })}`),
  meta: () => req<Meta>("GET", "/policy/meta"),
};

/** Fetches the CSV with the bearer token and saves it as a file. */
export async function downloadCsv(cost: number) {
  const res = await fetch(`${BASE}/policy/export.csv${q({ cost_per_bed_day: cost })}`, { headers: authHeaders() });
  if (res.status === 401) { onUnauthorized(); return; }
  if (!res.ok) throw await errorFrom(res);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "sickleguard-regions.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- client-side scenario recompute (same formula as api/app/analytics.py _estimate) ----
export function estimate(s: Scenario, value: number, b: NonNullable<Interventions["baseline"]>, costBedDay: number, edVisit: number) {
  const m = s.model;
  const cov0 = m.baseline_coverage;
  const frac = s.slider.param === "coverage" ? (cov0 < 1 ? Math.max(0, (value - cov0) / (1 - cov0)) : 0) : Math.max(0, Math.min(1, value));
  const crises = m.target_crises * frac * m.effect_crises;
  const adm = crises * b.admission_rate + m.target_admissions * frac * m.effect_admissions;
  const bed = adm * b.avg_los + Math.max(0, m.target_admissions * frac - adm) * m.effect_los_days;
  const saved = bed * costBedDay + Math.max(0, crises - adm) * edVisit;
  const prog = m.target_patients * frac * m.programme_cost_per_person_ghs;
  return { crises, adm, bed, saved, prog, net: saved - prog, reached: m.target_patients * frac };
}
