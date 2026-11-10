// Records API (devices, vitals, labs, imaging). Uses the shared `req` so auth and errors behave like the rest.
import { ApiError, BASE, authHeaders, errorFrom, onUnauthorized, req } from "../lib/api";
import type {
  Catalogue, Device, DeviceKind, DeviceStatus, DeviceWithKey, ImportResult, Imaging, Lab, LabInput, Metric, RawReading,
  RecordSummary, Vitals,
} from "./types";

const enc = encodeURIComponent;

export const records = {
  catalogue: () => req<Catalogue>("GET", "/records/catalogue"),
  summary: (pid: string) => req<RecordSummary>("GET", `/patients/${enc(pid)}/record-summary`),

  devices: (pid: string) => req<Device[]>("GET", `/patients/${enc(pid)}/devices`),
  addDevice: (pid: string, d: { kind: DeviceKind; label?: string; vendor?: string; serial?: string }) =>
    req<DeviceWithKey>("POST", `/patients/${enc(pid)}/devices`, d),
  patchDevice: (id: string, d: { status?: DeviceStatus; label?: string }) => req<Device>("PATCH", `/devices/${enc(id)}`, d),
  rotateKey: (id: string) => req<DeviceWithKey>("POST", `/devices/${enc(id)}/rotate-key`, {}),
  vitals: (pid: string, days = 14) => req<Vitals>("GET", `/patients/${enc(pid)}/vitals?days=${days}`),
  readings: (pid: string, metric: Metric, hours = 48) =>
    req<RawReading[]>("GET", `/patients/${enc(pid)}/readings?metric=${metric}&hours=${hours}`),

  labs: (pid: string, days = 365) => req<Lab[]>("GET", `/patients/${enc(pid)}/labs?days=${days}`),
  addLab: (pid: string, l: LabInput) => req<Lab>("POST", `/patients/${enc(pid)}/labs`, l),
  deleteLab: (id: string) => req<{ ok: true }>("DELETE", `/labs/${enc(id)}`),
  importLabs: (pid: string, file: File) => {
    const f = new FormData(); f.append("file", file);
    return req<ImportResult>("POST", `/patients/${enc(pid)}/labs/import`, f);
  },

  imaging: (pid: string) => req<Imaging[]>("GET", `/patients/${enc(pid)}/imaging`),
  addImaging: (pid: string, form: FormData) => req<Imaging>("POST", `/patients/${enc(pid)}/imaging`, form),
  secondLook: (id: string) => req<Imaging>("POST", `/imaging/${enc(id)}/second-look`, {}),
  deleteImaging: (id: string) => req<{ ok: true }>("DELETE", `/imaging/${enc(id)}`),
};

/** Fetches a protected file (bearer token) and returns an object URL; revoke it when done. */
export async function fileObjectUrl(fileUrl: string): Promise<string> {
  const path = fileUrl.startsWith(BASE) ? fileUrl : BASE + fileUrl;
  let res: Response;
  try { res = await fetch(path, { headers: authHeaders() }); }
  catch { throw new ApiError(0, "Network error: could not reach the server."); }
  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, "Signed out"); }
  if (!res.ok) throw await errorFrom(res);
  return URL.createObjectURL(await res.blob());
}
