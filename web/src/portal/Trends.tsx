// My trends: risk over time, how I've been (from check-ins) and vitals from my devices.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Watch } from "lucide-react";
import { cx } from "../components/ui";
import { useAsync } from "../lib/util";
import { cToF, fmtTemp, fmtTempShort } from "../lib/temp";
import { portal, type DayAgg, type Metric, type Vitals } from "./api";
import { Card, DEFAULT_CUTS, H1, LEVEL_SHORT, LEVEL_VAR, LineChart, Loading, Oops, SectionTitle, dayLabel, usePortal } from "./kit";

const RANGES = [14, 30, 60] as const;

const METRICS: { key: Metric; label: string; unit: string; digits: number; temp?: boolean; total?: boolean; scale?: number; color: string; note: string }[] = [
  { key: "heart_rate", label: "Resting heart rate", unit: "bpm", digits: 0, color: "var(--acc)", note: "A higher heart rate than usual can be an early sign of illness or pain." },
  { key: "spo2", label: "Oxygen (SpO2)", unit: "%", digits: 0, color: "var(--info)", note: "Usually 95 % or more. Under 92 % needs emergency care." },
  { key: "body_temp_c", label: "Temperature", unit: "°C", digits: 1, temp: true, color: "var(--lv-high)", note: `${fmtTemp(38.5)} or more is a fever: go to hospital.` },
  { key: "skin_temp_c", label: "Skin temperature", unit: "°C", digits: 1, temp: true, color: "var(--lv-high)", note: "Measured by your wearable; changes can follow fever or cold." },
  { key: "fluid_ml", label: "Water drunk", unit: "L", digits: 1, total: true, scale: 0.001, color: "var(--info)", note: "From your smart bottle. Aim for the amount your team suggested." },
  { key: "sleep_minutes", label: "Sleep", unit: "h", digits: 1, total: true, scale: 1 / 60, color: "var(--teal)", note: "7–9 hours a night helps your body cope." },
  { key: "steps", label: "Steps", unit: "", digits: 0, total: true, color: "var(--teal)", note: "Gentle activity is good; pace yourself." },
  { key: "hrv_rmssd", label: "Heart rate variability", unit: "ms", digits: 0, color: "var(--acc)", note: "Lower than usual can be a sign of stress or illness." },
  { key: "resp_rate", label: "Breathing rate", unit: "/min", digits: 0, color: "var(--info)", note: "Fast breathing can be a warning sign." },
];

export default function Trends() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const cuts = usePortal().me?.thresholds ?? DEFAULT_CUTS;
  const hist = useAsync(() => portal.riskHistory(days), [days]);
  const checks = useAsync(() => portal.checkins(days), [days]);
  const vit = useAsync(() => portal.vitals(Math.min(days, 30)), [days]);

  return (
    <div className="fade-in">
      <H1 sub="How things have changed over time.">My trends</H1>
      <div className="inline-flex rounded-full bg-hi p-1" role="tablist" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r} role="tab" aria-selected={days === r} onClick={() => setDays(r)}
            className={cx("pt-tap h-10 px-4 rounded-full text-[14px] font-medium transition", days === r ? "bg-solid shadow text-fg" : "text-muted")}>
            {r} days
          </button>
        ))}
      </div>

      <SectionTitle>Chance of a crisis</SectionTitle>
      {hist.error ? <Oops message={hist.error} retry={() => hist.reload()} /> : !hist.data ? <Loading rows={0} /> : hist.data.length === 0 ? (
        <Card className="p-5 text-[15px] text-muted">No readings yet. Do a check-in to start your trend.</Card>
      ) : (
        <Card className="p-4">
          {(() => {
            const pts = hist.data;
            const lastP = pts[pts.length - 1];
            const maxScore = Math.max(...pts.map((p) => p.score));
            return (
              <>
                <div className="flex items-baseline justify-between">
                  <p className="text-[15px]"><span className="font-semibold" style={{ color: LEVEL_VAR[lastP.level] }}>{LEVEL_SHORT[lastP.level]}</span> <span className="text-muted">right now</span></p>
                  <p className="text-[13px] text-faint">{pts.filter((p) => p.level === "low").length} of {pts.length} days low</p>
                </div>
                <div className="mt-3">
                  <LineChart ariaLabel="Risk score by day" color="var(--acc)" min={0} max={Math.max(cuts.critical + 5, Math.ceil(maxScore / 10) * 10)}
                    points={pts.map((p) => ({ x: p.date, y: p.score, label: `${LEVEL_SHORT[p.level]} · ${Math.round(p.score)}/100` }))}
                    bands={[{ from: 0, to: cuts.moderate, color: "var(--lv-low)" }, { from: cuts.moderate, to: cuts.high, color: "var(--lv-mod)" }, { from: cuts.high, to: cuts.critical, color: "var(--lv-high)" }, { from: cuts.critical, to: 100, color: "var(--lv-crit)" }]} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                  {(["low", "moderate", "high", "critical"] as const).map((l) => (
                    <span key={l} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: LEVEL_VAR[l], opacity: 0.55 }} />{LEVEL_SHORT[l]}</span>
                  ))}
                </div>
              </>
            );
          })()}
        </Card>
      )}

      <SectionTitle>How you've been</SectionTitle>
      {checks.error ? <Oops message={checks.error} /> : !checks.data ? <Loading rows={0} /> : checks.data.length === 0 ? (
        <Card className="p-5 text-[15px] text-muted">No check-ins yet.</Card>
      ) : (
        <div className="grid gap-3">
          {(() => {
            const rows = [...checks.data].reverse();
            return (
              <>
                <Card className="p-4">
                  <p className="font-medium">Pain <span className="text-faint font-normal text-[13px]">(0–10)</span></p>
                  <div className="mt-2"><LineChart ariaLabel="Pain by day" color="var(--lv-high)" min={0} max={10} height={140}
                    points={rows.map((c) => ({ x: c.date, y: c.pain, label: `Pain ${c.pain}/10` }))} /></div>
                </Card>
                <Card className="p-4">
                  <p className="font-medium">Water <span className="text-faint font-normal text-[13px]">(litres a day)</span></p>
                  <div className="mt-2"><LineChart ariaLabel="Water by day" color="var(--info)" min={0} height={140} baseline={2.5} format={(v) => v.toFixed(1)}
                    points={rows.map((c) => ({ x: c.date, y: c.hydration_litres, label: `${c.hydration_litres.toFixed(1)} L` }))} /></div>
                  <p className="text-[12.5px] text-faint mt-1">Dashed line: 2.5 L, a common goal. Your care team may suggest a different amount.</p>
                </Card>
              </>
            );
          })()}
        </div>
      )}

      <SectionTitle action={<Link to="/portal/devices" className="text-[14px] text-acc font-medium">My devices</Link>}>From your devices</SectionTitle>
      {vit.error ? <Oops message={vit.error} /> : !vit.data ? <Loading rows={0} /> : <VitalsGrid v={vit.data} />}
    </div>
  );
}

function VitalsGrid({ v }: { v: Vitals }) {
  const shown = METRICS.filter((m) => (v.metrics[m.key]?.length ?? 0) > 0);
  if (!shown.length) {
    return (
      <Card className="p-5 flex gap-4 items-start">
        <span className="size-11 rounded-2xl bg-hi grid place-items-center shrink-0 text-muted"><Watch className="size-5" /></span>
        <div><p className="font-medium">No device readings yet</p><p className="text-[14px] text-muted mt-0.5">When your care team links a wearable, pulse oximeter or smart bottle, your readings will show here.</p></div>
      </Card>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {v.alerts.map((a) => (
        <div key={a.metric} role="alert" className="sm:col-span-2 rounded-2xl p-3.5 bg-bad/10 border border-bad/35 text-[14.5px]">{a.message}</div>
      ))}
      {shown.map((m) => {
        const series = v.metrics[m.key]!;
        // the staff vitals function gives a resting heart rate per day; it's what "your usual" compares against
        const val = (p: DayAgg) => (m.total ? (p.total ?? p.mean) : m.key === "heart_rate" ? (p.resting ?? p.mean) : p.mean) * (m.scale ?? 1);
        const latest = v.latest[m.key];
        const lastVal = m.total || m.key === "heart_rate" ? val(series[series.length - 1]) : (latest?.value ?? series[series.length - 1].mean) * (m.scale ?? 1);
        const base = v.baselines[m.key];
        const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: m.digits, minimumFractionDigits: m.digits });
        return (
          <Card key={m.key} className="p-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-medium text-[15px]">{m.label}</p>
              <p className="text-[12px] text-faint">{m.total || m.key === "heart_rate" ? "today" : latest ? `latest ${new Date(latest.ts).toDateString() === new Date().toDateString() ? new Date(latest.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : dayLabel(latest.ts)}` : ""}</p>
            </div>
            {m.temp ? (
              <p className="text-[26px] font-semibold num leading-tight mt-0.5">{fmt(lastVal)} <span className="text-[14px] text-muted font-normal">°C</span>
                <span className="text-[15px] text-muted font-normal"> ({cToF(lastVal).toFixed(1)} °F)</span></p>
            ) : (
              <p className="text-[26px] font-semibold num leading-tight mt-0.5">{fmt(lastVal)} <span className="text-[14px] text-muted font-normal">{m.unit}</span></p>
            )}
            <div className="mt-1">
              <LineChart ariaLabel={`${m.label} by day`} color={m.color} height={110} area={false}
                baseline={base !== undefined ? base * (m.scale ?? 1) : undefined} format={(n) => fmt(n)}
                points={series.map((p) => ({ x: p.date, y: val(p), label: m.temp ? fmtTempShort(val(p)) : `${fmt(val(p))} ${m.unit}` }))} />
            </div>
            <p className="text-[12.5px] text-muted mt-1.5">{m.note}</p>
          </Card>
        );
      })}
    </div>
  );
}
