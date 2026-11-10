// Portal API client + types (docs/API.md "Patient portal"). The server always uses the signed-in patient's own
// record: no patient id is ever sent from here.
import { req } from "../lib/api";
import { streamPost } from "../lib/sse";
import type { Assessment, ChatEvent, CheckIn, CheckInInput, Patient, PlanItem, RiskLevel } from "../types";

export type DeviceKind = "wearable" | "pulse_oximeter" | "smart_bottle" | "thermometer";
export interface Device {
  id: string; patient_id: string; kind: DeviceKind; label: string; vendor: string; serial: string;
  status: "active" | "offline" | "retired"; simulated: boolean; battery: number | null; last_seen: string | null;
  created_at: string; metrics?: string[];
}

export interface PortalMe {
  patient: Omit<Patient, "notes"> & { region?: string; district?: string; facility?: string };
  risk: Assessment | null;
  streak_days: number;
  checked_in_today: boolean;
  next_steps: PlanItem[];
  devices: Device[];
  care_team: string;
  thresholds?: { moderate: number; high: number; critical: number };
  emergency: { phone: string; ambulance: string; care_team_phone: string; message: string };
}

export interface CheckinResult {
  checkin: CheckIn; assessment: Assessment;
  previous: { score: number; level: RiskLevel; created_at: string } | null;
  next_steps: PlanItem[]; streak_days: number;
}

export interface RiskPoint { date: string; score: number; level: RiskLevel }

export type Metric = "heart_rate" | "hrv_rmssd" | "spo2" | "skin_temp_c" | "body_temp_c" | "steps" | "sleep_minutes"
  | "fluid_ml" | "resp_rate";
export interface DayAgg { date: string; mean: number; min: number; max: number; n: number; total?: number; resting?: number }
export interface Vitals {
  metrics: Partial<Record<Metric, DayAgg[]>>;
  latest: Partial<Record<Metric, { value: number; ts: string }>>;
  baselines: Partial<Record<Metric, number>>;
  alerts: { metric: Metric; message: string }[];
}

export interface Lab {
  id: string; taken_at: string; code: string; name: string; value: number; unit: string;
  ref_low: number | null; ref_high: number | null; source: string; flag: "low" | "high" | null;
  about?: string; meaning?: string;
}
export interface ImagingReport {
  id: string; study_date: string; modality: string; modality_label?: string; body_part: string; indication: string;
  report: string; impression: string;
}
export interface LearnCard { title: string; summary: string; doc_title: string; section?: string; icon?: string }

export const portal = {
  me: () => req<PortalMe>("GET", "/portal/me"),
  checkins: (days = 30) => req<CheckIn[]>("GET", `/portal/checkins?days=${days}`),
  checkin: (c: Partial<CheckInInput>) => req<CheckinResult>("POST", "/portal/checkins", c),
  riskHistory: (days = 60) => req<RiskPoint[]>("GET", `/portal/risk-history?days=${days}`),
  vitals: (days = 14) => req<Vitals>("GET", `/portal/vitals?days=${days}`),
  devices: () => req<Device[]>("GET", "/portal/devices"),
  records: () => req<{ labs: Lab[]; imaging: ImagingReport[] }>("GET", "/portal/records"),
  learn: () => req<LearnCard[]>("GET", "/portal/learn"),
  askHistory: () => req<{ role: "user" | "assistant"; content: string }[]>("GET", "/portal/ask/history"),
  ask: (message: string, onEvent: (e: ChatEvent) => void, opts: { fresh?: boolean; signal?: AbortSignal } = {}) =>
    streamPost("/portal/ask", { message, new_conversation: !!opts.fresh }, onEvent, opts.signal),
};
