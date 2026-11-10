// Types matching docs/API.md (SickleGuard API v1).

export type Role = "admin" | "clinician";
export interface User { id: string; email: string; name: string; role: Role }

export interface Health {
  ok: boolean; version: string; openai: boolean; qdrant: boolean; mcp: boolean;
  model: { version: string; auc: number };
}

export type RiskLevel = "low" | "moderate" | "high" | "critical";
export type Sex = "F" | "M";
export type Genotype = "HbSS" | "HbSC" | "HbSβ0" | "HbSβ+";
export const GENOTYPES: Genotype[] = ["HbSS", "HbSC", "HbSβ0", "HbSβ+"];
export const LEVELS: RiskLevel[] = ["low", "moderate", "high", "critical"];

export interface RiskSnapshot { score: number; level: RiskLevel; at: string }

export interface PatientRow {
  id: string; mrn: string; name: string; age: number; sex: Sex; genotype: Genotype;
  on_hydroxyurea: boolean; crises_12m: number; risk: RiskSnapshot | null;
  last_checkin: string | null; red_flags: string[];
}

export interface Patient extends PatientRow {
  date_of_birth: string; phone: string; hb_baseline: number; hbf_percent: number | null;
  care_team: string; notes: string; created_at: string;
}

export interface PatientCreate {
  mrn: string; name: string; date_of_birth: string; sex: Sex; genotype: Genotype; on_hydroxyurea: boolean;
  hb_baseline: number; hbf_percent?: number | null; phone?: string; care_team?: string; notes?: string; crises_12m?: number;
}

export interface Dashboard {
  patients: number;
  levels: Record<RiskLevel, number>;
  open_alerts: number;
  checkins_today: number;
  crises_30d: number;
  watchlist: PatientRow[];
  trend: { date: string; avg_score: number; high: number }[];
}

export interface CheckIn {
  id: string; patient_id: string; date: string;
  pain: number; hydration_litres: number; sleep_hours: number; stress: number; temperature_c: number;
  spo2: number | null;
  cold_exposure: boolean; infection_symptoms: boolean; chest_symptoms: boolean; neuro_symptoms: boolean;
  menstruating: boolean | null; alcohol: boolean; strenuous_activity: boolean; hydroxyurea_taken: boolean | null;
  hb: number | null; wbc: number | null; retic_percent: number | null; ldh: number | null;
  notes: string; created_at: string;
}
export type CheckInInput = Omit<CheckIn, "id" | "patient_id" | "created_at" | "date"> & { date?: string };

export type Severity = "mild" | "moderate" | "severe";
export interface Crisis { id: string; patient_id: string; date: string; severity: Severity; hospitalised: boolean; notes: string }
export interface CrisisInput { date: string; severity: Severity; hospitalised: boolean; notes?: string }

export interface Factor { key: string; label: string; value: string; impact: number; direction: "up" | "down" }
export interface RedFlag { key: string; label: string; action: string }
export type Urgency = "now" | "today" | "this week";
export interface PlanItem { action: string; why: string; who: "patient" | "care team"; urgency: Urgency }
export interface Source { title: string; snippet: string; score: number }

export interface Assessment {
  id: string; patient_id: string; created_at: string; kind: "checkin" | "ai";
  score: number; level: RiskLevel; probability: number;
  factors: Factor[]; red_flags: RedFlag[]; summary: string | null; plan: PlanItem[]; sources: Source[];
  model_version: string; disclaimer: string;
}

export interface Alert {
  id: string; patient_id: string; patient_name: string; created_at: string; level: RiskLevel; score: number;
  reason: string; status: "open" | "acknowledged"; acknowledged_by: string | null; acknowledged_at: string | null;
}
export type AlertFilter = "open" | "acknowledged" | "all";

export interface ThreadSummary { id: string; title: string; patient_id: string | null; updated_at: string }
export interface ThreadMessage { role: "user" | "assistant"; content: string; tools?: string[] }
export interface ThreadDetail { id: string; title: string; patient_id: string | null; messages: ThreadMessage[] }
export interface ToolInfo { name: string; description: string; source: "mcp" | "local" }

export type ChatEvent =
  | { type: "thread"; thread_id: string }
  | { type: "token"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; preview: string }
  | { type: "sources"; items: Source[] }
  | { type: "blocked"; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface Doc {
  id: string; title: string; filename: string; chunks: number; status: "indexed" | "pending" | "failed";
  error: string | null; created_at: string;
}

export interface ModelCard {
  version: string; trained_at: string; algorithm: string; training_rows: number; positive_rate: number;
  auc: number; brier: number; thresholds: { moderate: number; high: number; critical: number };
  features: { key: string; label: string; weight: number; description: string }[];
  data_note: string; limitations: string[];
}
