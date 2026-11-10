// Typed client for docs/API.md: adds the token, turns errors into plain messages, sends 401s back to login.
import type {
  Alert, AlertFilter, Assessment, CheckIn, CheckInInput, Crisis, CrisisInput, Dashboard, Doc, Health, ModelCard,
  Patient, PatientCreate, PatientRow, RiskLevel, Source, ThreadDetail, ThreadSummary, ToolInfo, User,
} from "../types";

export const BASE = "/api/v1";
const TOKEN_KEY = "sg_token";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function onUnauthorized() {
  setToken(null);
  if (!location.pathname.startsWith("/login")) location.assign("/login");
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = getToken();
  return t ? { ...extra, Authorization: `Bearer ${t}` } : extra;
}

export async function errorFrom(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") msg = body.detail;
    else if (Array.isArray(body?.detail)) msg = body.detail.map((d: { msg?: string; loc?: unknown[] }) =>
      [d.loc?.slice(-1)[0], d.msg].filter(Boolean).join(": ")).join("; ");
  } catch { /* not json */ }
  if (res.status === 502 || res.status === 503 || res.status === 504) msg = "The SickleGuard server is not reachable right now.";
  return new ApiError(res.status, msg);
}

export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: authHeaders(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Network error: could not reach the server.");
  }
  if (res.status === 401 && path !== "/auth/login") { onUnauthorized(); throw new ApiError(401, "Signed out"); }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T,>(p: string) => req<T>("GET", p);
const post = <T,>(p: string, b?: unknown) => req<T>("POST", p, b ?? {});
const patch = <T,>(p: string, b: unknown) => req<T>("PATCH", p, b);
const del = <T,>(p: string) => req<T>("DELETE", p);

function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

export const api = {
  login: (email: string, password: string) => post<{ token: string; user: User }>("/auth/login", { email, password }),
  me: () => get<User>("/me"),
  health: () => get<Health>("/health"),
  dashboard: () => get<Dashboard>("/dashboard"),

  patients: (q?: string, level?: RiskLevel | "") => get<PatientRow[]>(`/patients${qs({ q, level })}`),
  patient: (id: string) => get<Patient>(`/patients/${id}`),
  createPatient: (p: PatientCreate) => post<Patient>("/patients", p),
  updatePatient: (id: string, p: Partial<PatientCreate>) => patch<Patient>(`/patients/${id}`, p),

  checkins: (id: string, days = 30) => get<CheckIn[]>(`/patients/${id}/checkins${qs({ days })}`),
  addCheckin: (id: string, c: CheckInInput) => post<{ checkin: CheckIn; assessment: Assessment }>(`/patients/${id}/checkins`, c),
  crises: (id: string) => get<Crisis[]>(`/patients/${id}/crises`),
  addCrisis: (id: string, c: CrisisInput) => post<Crisis>(`/patients/${id}/crises`, c),
  assessments: (id: string, days = 60) => get<Assessment[]>(`/patients/${id}/assessments${qs({ days })}`),
  assess: (id: string) => post<Assessment>(`/patients/${id}/assess`),

  alerts: (status: AlertFilter = "open") => get<Alert[]>(`/alerts${qs({ status })}`),
  ackAlert: (id: string, note?: string) => post<Alert>(`/alerts/${id}/ack`, note ? { note } : {}),

  threads: () => get<ThreadSummary[]>("/assistant/threads"),
  thread: (id: string) => get<ThreadDetail>(`/assistant/threads/${id}`),
  tools: () => get<ToolInfo[]>("/assistant/tools"),

  docs: () => get<Doc[]>("/knowledge"),
  uploadDoc: (file: File) => { const f = new FormData(); f.append("file", file); return post<Doc>("/knowledge", f); },
  deleteDoc: (id: string) => del<{ ok: true }>(`/knowledge/${id}`),
  searchKnowledge: (q: string, k = 5) => get<Source[]>(`/knowledge/search${qs({ q, k })}`),

  model: () => get<ModelCard>("/model"),
};
