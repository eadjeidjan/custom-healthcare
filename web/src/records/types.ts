// Types for the records work stream (docs/API.md v1.1: IoT devices and readings, medical records).

export type DeviceKind = "wearable" | "pulse_oximeter" | "smart_bottle" | "thermometer";
export type DeviceStatus = "active" | "offline" | "retired";
export type Metric = "heart_rate" | "hrv_rmssd" | "spo2" | "skin_temp_c" | "body_temp_c" | "steps" | "sleep_minutes" | "fluid_ml" | "resp_rate";

export interface Device {
  id: string; patient_id: string; kind: DeviceKind; label: string; vendor: string; serial: string;
  status: DeviceStatus; simulated: boolean; battery: number | null; last_seen: string | null; created_at: string;
  metrics?: Metric[];
}
export interface DeviceWithKey extends Device { api_key: string }

export interface DayAgg { date: string; mean: number; min: number; max: number; n: number; value?: number; total?: number; sum?: number; resting?: number }
export interface VitalsAlert { metric: Metric; message: string; severity?: "severe" | "moderate"; value?: number }
export interface Vitals {
  metrics: Partial<Record<Metric, DayAgg[]>>;
  latest: Partial<Record<Metric, { value: number; ts: string }>>;
  baselines: Partial<Record<Metric, number>>;
  baseline_bands?: Partial<Record<Metric, [number, number]>>;
  alerts: VitalsAlert[];
}
export interface RawReading { ts: string; value: number }

export type LabFlag = "low" | "high" | null;
export interface Lab {
  id: string; patient_id: string; taken_at: string; code: string; name: string; value: number; unit: string;
  ref_low: number | null; ref_high: number | null; source: string; flag: LabFlag;
}
export interface LabInput { code: string; value: number; unit?: string; taken_at?: string }
export interface ImportResult { imported: number; skipped: number; errors: string[] }
export interface LabInfo { code: string; name: string; unit: string; ref_low: number | null; ref_high: number | null; note: string; loinc: string[] }

export type Severity = "info" | "moderate" | "severe";
export interface Finding { code: string; label: string; severity: Severity; study_date?: string; modality?: Modality }
export type Modality = "xray" | "mri" | "ct" | "ultrasound" | "tcd";
export interface Imaging {
  id: string; patient_id: string; study_date: string; modality: Modality; body_part: string; indication: string;
  report: string; impression: string; findings: Finding[]; tcd_velocity: number | null; ai_summary: string | null;
  ai_findings: Finding[]; ai_label?: string | null; file_url: string | null; file_name?: string | null;
  content_type: string | null; source: string; created_at: string; findings_method?: "ai" | "rules";
}

export interface RiskInput {
  source: "device" | "lab" | "imaging" | "checkin"; key?: string; label: string; value: string;
  number?: number | null; flag?: string | null; at?: string | null;
}
export interface RecordSummary {
  labs_latest: Record<string, Lab>; imaging_flags: Finding[]; devices: number; devices_online?: number;
  vitals_alerts?: VitalsAlert[]; risk_inputs: RiskInput[];
}

export interface Catalogue {
  metrics: Record<Metric, { label: string; unit: string; min: number; max: number; daily: "mean" | "sum" }>;
  device_kinds: Record<DeviceKind, { label: string; metrics: Metric[] }>;
  labs: LabInfo[];
  findings: Record<string, { label: string; severity: Severity }>;
  ingest: { max_batch: number; max_age_days: number };
}
