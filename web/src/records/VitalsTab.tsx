// Vitals & devices: live 14-day charts per metric with the patient's baseline, device alerts, device management.
import { useEffect, useMemo, useState } from "react";
import {
  AlertOctagon, AlertTriangle, Battery, BatteryFull, BatteryLow, BatteryMedium, Cpu, KeyRound, Plus, Power, RefreshCw, Wifi, WifiOff,
} from "lucide-react";
import { useAsync, when } from "../lib/util";
import { useToast } from "../lib/toast";
import { Badge, Button, Empty, ErrorNote, Field, Input, Modal, Panel, Seg, Skeleton, cx } from "../components/ui";
import { records } from "./api";
import type { DayAgg, Device, DeviceKind, DeviceWithKey, Metric, Vitals } from "./types";
import { KINDS, KIND_ORDER, METRICS, METRIC_ORDER, cToF, deltaWithUnit, display, fmtMetric, isTemp, withUnit } from "./meta";
import { DetailChart, VitalArea, type DayPoint } from "./charts";
import { CopyButton, LiveDot } from "./ui";

const REFRESH_MS = 60_000;

function dayValue(m: Metric, d: DayAgg): number {
  if (METRICS[m].daily === "sum") return d.total ?? d.mean;   // summed per day by the API
  if (m === "heart_rate" && d.resting != null) return d.resting;
  return d.mean;
}

export function VitalsTab({ patientId, onChanged }: { patientId: string; onChanged?: () => void }) {
  const [days, setDays] = useState<"7" | "14" | "30">("14");
  const vitals = useAsync(() => records.vitals(patientId, Number(days)), [patientId, days]);
  const devices = useAsync(() => records.devices(patientId), [patientId]);
  const [updated, setUpdated] = useState<Date>(new Date());
  const [detail, setDetail] = useState<Metric | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => { if (vitals.data) setUpdated(new Date()); }, [vitals.data]);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      void vitals.reload(true); void devices.reload(true);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [vitals.reload, devices.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = vitals.data;
  const shown = useMemo(() => METRIC_ORDER.filter((m) => v && (v.metrics[m]?.length || v.latest[m])), [v]);
  const liveDevices = (devices.data ?? []).filter((d) => d.status !== "retired");

  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <LiveDot label={<>Live · updated {updated.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</>} />
          <span className="text-[11px] text-faint hidden sm:inline">refreshes every minute</span>
        </div>
        <div className="flex items-center gap-2">
          <Seg value={days} onChange={setDays} options={[{ value: "7", label: "7 d" }, { value: "14", label: "14 d" }, { value: "30", label: "30 d" }]} />
          <Button size="sm" variant="teal" onClick={() => setAdding(true)}><Plus className="size-3.5" />Add device</Button>
        </div>
      </div>

      {vitals.error && <ErrorNote>{vitals.error}</ErrorNote>}

      {v && v.alerts.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2">
          {v.alerts.map((a, i) => {
            const severe = a.severity !== "moderate";
            const I = severe ? AlertOctagon : AlertTriangle;
            return (
              <div key={i} role="alert" className={cx("flex items-start gap-3 rounded-xl border px-3.5 py-2.5 text-sm fade-in",
                severe ? "border-bad/40 bg-bad/10" : "border-warn/35 bg-warn/[0.08]")}>
                <I className={cx("size-4 mt-0.5 shrink-0", severe ? "text-bad" : "text-warn")} />
                <div className="min-w-0">
                  <div className={cx("text-[11px] uppercase tracking-wider font-semibold", severe ? "text-bad" : "text-warn")}>
                    Device alert · {METRICS[a.metric]?.short ?? a.metric}
                  </div>
                  <div className="text-fg/90 mt-0.5">{a.message}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {vitals.loading && !v ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-52 rounded-2xl" />)}</div>
      ) : v && shown.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((m) => <MetricCard key={m} metric={m} v={v} days={Number(days)} onOpen={() => setDetail(m)} />)}
        </div>
      ) : v ? (
        <Panel>
          <Empty icon={<Cpu className="size-5" />} title="No device data yet">
            Link a wearable, pulse oximeter, smart bottle or thermometer. Readings appear here as soon as the device sends them.
          </Empty>
        </Panel>
      ) : null}

      <Panel title="Devices" icon={<Cpu className="size-4 text-teal" />}
        sub={devices.data ? `${liveDevices.length} linked · ${liveDevices.filter((d) => d.status === "active").length} online` : undefined}
        actions={<Button size="sm" onClick={() => setAdding(true)}><Plus className="size-3.5" />Add device</Button>}>
        <div className="p-4">
          {devices.error && <ErrorNote>{devices.error}</ErrorNote>}
          {devices.loading && !devices.data ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>
          ) : devices.data?.length ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {devices.data.map((d) => (
                <DeviceCard key={d.id} d={d} onChange={(nd) => { devices.setData((xs) => (xs ?? []).map((x) => (x.id === nd.id ? nd : x))); onChanged?.(); }} />
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted py-6 text-center">No devices linked to this patient.</div>
          )}
        </div>
      </Panel>

      <Modal open={detail != null} onClose={() => setDetail(null)} wide
        title={detail ? `${METRICS[detail].label}${isTemp(detail) ? " (°C / °F)" : ""} · recent readings` : ""}>
        {detail && <ReadingsDetail patientId={patientId} metric={detail} baseline={v?.baselines[detail]} />}
      </Modal>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a device" wide>
        {adding && <AddDevice patientId={patientId} onDone={() => setAdding(false)}
          onCreated={(d) => { devices.setData((xs) => [...(xs ?? []), d]); onChanged?.(); }} />}
      </Modal>
    </div>
  );
}

function MetricCard({ metric, v, days, onOpen }: { metric: Metric; v: Vitals; days: number; onOpen: () => void }) {
  const meta = METRICS[metric];
  const I = meta.icon;
  const rows = v.metrics[metric] ?? [];
  const pts: DayPoint[] = rows.map((d) => {
    const val = display(metric, dayValue(metric, d))!;
    const range = meta.daily === "mean" && metric !== "heart_rate";
    return { date: d.date, value: val, n: d.n, lo: range ? display(metric, d.min)! : undefined, hi: range ? display(metric, d.max)! : undefined };
  });
  const latest = v.latest[metric];
  const todayRow = rows.length && rows[rows.length - 1].date === new Date().toLocaleDateString("en-CA") ? rows[rows.length - 1] : null;
  const big = meta.daily === "sum" ? (todayRow ? dayValue(metric, todayRow) : null) : latest?.value ?? null;
  const base = v.baselines[metric];
  const band = v.baseline_bands?.[metric];
  const dispBand: [number, number] | null = band ? [display(metric, band[0])!, display(metric, band[1])!] : null;
  const fmt = (x: number) => isTemp(metric) ? withUnit(metric, x) : `${x.toLocaleString(undefined, { maximumFractionDigits: meta.digits, minimumFractionDigits: meta.digits })} ${meta.unit}`;
  const warn = big != null && meta.daily === "mean" && ((meta.warn?.below != null && big < meta.warn.below) || (meta.warn?.above != null && big > meta.warn.above));
  const alert = v.alerts.some((a) => a.metric === metric);
  const delta = base != null && big != null && meta.daily === "mean" ? (metric === "heart_rate" && todayRow?.resting != null ? todayRow.resting : big) - base : null;
  return (
    <button type="button" onClick={onOpen}
      className={cx("glass rounded-2xl p-4 text-left transition hover:border-linehi group cursor-pointer min-w-0",
        (warn || alert) && "border-bad/45 shadow-[0_0_0_1px_rgba(244,63,94,.25),0_10px_30px_-14px_rgba(244,63,94,.5)]")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="grid place-items-center size-8 rounded-lg border border-line shrink-0" style={{ background: `color-mix(in srgb, ${meta.color} 14%, transparent)` }}>
            <I className="size-4" style={{ color: meta.color }} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{meta.label}</div>
            <div className="text-[11px] text-faint truncate">
              {meta.daily === "sum" ? "today so far" : latest ? `latest · ${when(latest.ts)}` : "no reading yet"}
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={cx("num text-2xl font-semibold leading-none tracking-tight", warn && "text-bad")}>
            {big == null ? "—" : fmtMetric(metric, big)}<span className="text-xs font-normal text-faint ml-1">{meta.unit}</span>
          </div>
          {isTemp(metric) && big != null && (
            <div className={cx("num text-sm font-medium mt-0.5", warn ? "text-bad/80" : "text-muted")}>{cToF(big).toFixed(1)}<span className="text-[11px] font-normal text-faint ml-1">°F</span></div>
          )}
          {delta != null && Math.abs(delta) >= (meta.digits ? 0.1 : 1) && (
            <div className={cx("num text-[11px] mt-1", Math.abs(delta) / Math.max(1, Math.abs(base!)) > 0.1 ? "text-warn" : "text-faint")}>
              {delta > 0 ? "▲" : "▼"} {deltaWithUnit(metric, delta)} vs baseline
            </div>
          )}
        </div>
      </div>
      <div className="mt-3">
        <VitalArea points={pts} days={days} color={meta.color} band={dispBand} baseline={base != null ? display(metric, base) : null}
          fmt={fmt} floor={meta.floor} ceil={meta.ceil}
          warnBelow={meta.daily === "mean" ? meta.warn?.below : undefined} warnAbove={meta.daily === "mean" ? meta.warn?.above : undefined} />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-faint mt-1">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: meta.color }} />
          {base != null ? <>baseline <span className="num text-muted">{withUnit(metric, base)}</span></> : "baseline after 3 days of data"}
        </span>
        <span className="opacity-0 group-hover:opacity-100 transition text-teal">48 h detail →</span>
      </div>
    </button>
  );
}

function ReadingsDetail({ patientId, metric, baseline }: { patientId: string; metric: Metric; baseline?: number }) {
  const [hours, setHours] = useState<"12" | "48" | "168">("48");
  const r = useAsync(() => records.readings(patientId, metric, Number(hours)), [patientId, metric, hours]);
  const meta = METRICS[metric];
  const pts = (r.data ?? []).map((p) => ({ ts: p.ts, value: display(metric, p.value)! }));
  const vals = pts.map((p) => p.value);
  const fmt = (x: number) => isTemp(metric) ? withUnit(metric, x) : x.toLocaleString(undefined, { maximumFractionDigits: meta.digits, minimumFractionDigits: meta.digits });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Seg value={hours} onChange={setHours} options={[{ value: "12", label: "12 h" }, { value: "48", label: "48 h" }, { value: "168", label: "7 days" }]} />
        {vals.length > 0 && (
          <div className="flex gap-4 text-xs text-muted num">
            <span>min <b className="text-fg">{fmt(Math.min(...vals))}</b></span>
            <span>max <b className="text-fg">{fmt(Math.max(...vals))}</b></span>
            {meta.daily === "mean" && <span>mean <b className="text-fg">{fmt(vals.reduce((a, b) => a + b, 0) / vals.length)}</b></span>}
            {baseline != null && <span>baseline <b className="text-fg">{isTemp(metric) ? withUnit(metric, baseline) : fmtMetric(metric, baseline)}</b></span>}
            <span>{vals.length.toLocaleString()} readings</span>
          </div>
        )}
      </div>
      {r.error && <ErrorNote>{r.error}</ErrorNote>}
      {r.loading && !r.data ? <Skeleton className="h-60" /> : (
        <DetailChart points={pts} color={meta.color} fmt={fmt} floor={meta.floor} ceil={meta.ceil}
          warnBelow={meta.daily === "mean" ? meta.warn?.below : undefined} warnAbove={meta.daily === "mean" ? meta.warn?.above : undefined} />
      )}
      {meta.daily === "sum" && <p className="text-[11px] text-faint">Each point is one recorded amount (a drink, a minute of steps, a night of sleep); the daily chart shows their total.</p>}
    </div>
  );
}

function BatteryIcon({ level }: { level: number | null }) {
  if (level == null) return <Battery className="size-4 text-faint" />;
  if (level <= 15) return <BatteryLow className="size-4 text-bad" />;
  if (level <= 50) return <BatteryMedium className="size-4 text-warn" />;
  return <BatteryFull className="size-4 text-teal" />;
}

function DeviceCard({ d, onChange }: { d: Device; onChange: (d: Device) => void }) {
  const toast = useToast();
  const k = KINDS[d.kind] ?? KINDS.wearable;
  const I = k.icon;
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<DeviceWithKey | null>(null);
  const status = d.status;
  async function setStatus(s: "active" | "retired") {
    if (s === "retired" && !confirm(`Retire "${d.label}"? It will stop accepting readings.`)) return;
    setBusy(true);
    try { onChange(await records.patchDevice(d.id, { status: s })); toast.ok(s === "retired" ? "Device retired" : "Device reactivated"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function rotate() {
    if (!confirm("Create a new API key? The current key stops working immediately.")) return;
    setBusy(true);
    try { const r = await records.rotateKey(d.id); setKey(r); onChange(r); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className={cx("rounded-xl border border-line bg-hi/30 p-3.5 flex flex-col gap-3 min-w-0", status === "retired" && "opacity-60")}>
      <div className="flex items-start gap-3">
        <div className={cx("relative grid place-items-center size-10 rounded-xl border shrink-0",
          status === "active" ? "border-teal/30 bg-teal/10 text-teal" : "border-line bg-hi text-faint")}>
          <I className="size-5" />
          {status === "active" && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-teal border-2 border-[var(--panel-solid)] pulse-dot" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate" title={d.label}>{d.label}</div>
          <div className="text-[11px] text-faint truncate">{k.label}{d.vendor ? ` · ${d.vendor}` : ""}{d.serial ? ` · ${d.serial}` : ""}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {status === "active" ? <Badge tone="teal"><Wifi className="size-3" />Online</Badge>
          : status === "offline" ? <Badge tone="warn"><WifiOff className="size-3" />Offline</Badge>
          : <Badge tone="muted"><Power className="size-3" />Retired</Badge>}
        {d.simulated && <Badge tone="info" title="Sample device generating realistic readings for the demo">simulated</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-muted"><BatteryIcon level={d.battery} /><span className="num">{d.battery != null ? `${d.battery}%` : "—"}</span></div>
        <div className="text-muted text-right truncate" title={d.last_seen ?? undefined}>{d.last_seen ? when(d.last_seen) : "never seen"}</div>
      </div>
      <div className="flex gap-1.5 mt-auto">
        {status !== "retired" ? (
          <>
            <Button size="sm" variant="ghost" className="flex-1 !px-2" onClick={rotate} disabled={busy}><KeyRound className="size-3.5" />New key</Button>
            <Button size="sm" variant="ghost" className="flex-1 !px-2 hover:!text-bad" onClick={() => setStatus("retired")} disabled={busy}><Power className="size-3.5" />Retire</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => setStatus("active")} disabled={busy}><RefreshCw className="size-3.5" />Reactivate</Button>
        )}
      </div>
      <Modal open={key != null} onClose={() => setKey(null)} title={`New API key · ${d.label}`} wide>
        {key && <KeyReveal device={key} onDone={() => setKey(null)} />}
      </Modal>
    </div>
  );
}

function AddDevice({ patientId, onCreated, onDone }: { patientId: string; onCreated: (d: Device) => void; onDone: () => void }) {
  const [kind, setKind] = useState<DeviceKind>("pulse_oximeter");
  const [label, setLabel] = useState("");
  const [vendor, setVendor] = useState("");
  const [serial, setSerial] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<DeviceWithKey | null>(null);
  if (created) return <KeyReveal device={created} onDone={onDone} />;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const d = await records.addDevice(patientId, { kind, label: label || undefined, vendor: vendor || undefined, serial: serial || undefined });
      setCreated(d); onCreated(d);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {KIND_ORDER.map((k) => {
          const m = KINDS[k], I = m.icon, on = k === kind;
          return (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={cx("flex items-start gap-3 rounded-xl border p-3 text-left transition cursor-pointer",
                on ? "border-teal/60 bg-teal/[0.07] ring-2 ring-teal/15" : "border-line hover:border-linehi hover:bg-hi/40")}>
              <I className={cx("size-5 mt-0.5 shrink-0", on ? "text-teal" : "text-faint")} />
              <div className="min-w-0">
                <div className="text-sm font-medium">{m.label}</div>
                <div className="text-[11px] text-faint leading-snug">{m.blurb}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={KINDS[kind].label} maxLength={120} /></Field>
        <Field label="Vendor"><Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Masimo" maxLength={120} /></Field>
        <Field label="Serial"><Input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="optional" maxLength={80} /></Field>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="teal" loading={busy}><Plus className="size-4" />Add device</Button>
      </div>
    </form>
  );
}

function KeyReveal({ device, onDone }: { device: DeviceWithKey; onDone: () => void }) {
  const metric = KINDS[device.kind]?.example ?? "heart_rate";
  const sample = { spo2: 96, heart_rate: 78, fluid_ml: 250, body_temp_c: 36.8 }[metric as string] ?? 1;
  const curl = [
    `curl -X POST ${location.origin}/api/v1/ingest/readings \\`,
    `  -H "X-Device-Key: ${device.api_key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"readings": [{"metric": "${metric}", "value": ${sample}}], "battery": 90}'`,
  ].join("\n");
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-warn/35 bg-warn/[0.08] px-3 py-2.5 text-sm">
        <KeyRound className="size-4 text-warn mt-0.5 shrink-0" />
        <div><b>Copy this key now.</b> It is shown only once; SickleGuard stores only a hash. If it is lost, create a new key from the device card.</div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-medium text-muted uppercase tracking-wider">API key · {device.label}</div>
          <CopyButton text={device.api_key} label="Copy key" />
        </div>
        <code className="block rounded-xl border border-line bg-[var(--code-bg)] px-3 py-2.5 font-mono text-[12.5px] break-all select-all">{device.api_key}</code>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-medium text-muted uppercase tracking-wider">Send a reading</div>
          <CopyButton text={curl} label="Copy curl" />
        </div>
        <pre className="rounded-xl border border-line bg-[var(--code-bg)] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed overflow-x-auto">{curl}</pre>
        <p className="text-[11px] text-faint mt-1.5">
          Up to 1000 readings per request; optional <code className="font-mono">ts</code> (ISO time, up to 7 days back). Metrics: {(device.metrics ?? []).map((m) => METRICS[m]?.short ?? m).join(", ") || "see API docs"}.
          Values outside plausible ranges are rejected.
        </p>
      </div>
      <div className="flex justify-end"><Button variant="teal" onClick={onDone}>Done</Button></div>
    </div>
  );
}
