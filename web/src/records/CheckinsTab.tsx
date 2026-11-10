// Check-ins: 30-day trends of what the patient reports (pain, fluids, sleep, temperature, SpO₂, stress).
import type { ReactNode } from "react";
import { Droplets, Gauge, HeartPulse, Moon, Thermometer, Wind } from "lucide-react";
import type { CheckIn } from "../types";
import { Sparkline } from "./charts";
import { cToF, fmtTempShort } from "../lib/temp";

interface Series { key: string; temp?: boolean; label: string; unit: string; icon: ReactNode; color: string; get: (c: CheckIn) => number | null; digits: number; bad?: (v: number) => boolean; ref?: [number, number] }

const SERIES: Series[] = [
  { key: "pain", label: "Pain", unit: "/10", icon: <Gauge className="size-4" />, color: "#f43f5e", get: (c) => c.pain, digits: 0, bad: (v) => v >= 7 },
  { key: "fluids", label: "Fluids", unit: "L", icon: <Droplets className="size-4" />, color: "#2dd4bf", get: (c) => c.hydration_litres, digits: 1, bad: (v) => v < 1.5, ref: [2, 3.5] },
  { key: "sleep", label: "Sleep", unit: "h", icon: <Moon className="size-4" />, color: "#818cf8", get: (c) => c.sleep_hours, digits: 1, bad: (v) => v < 6, ref: [7, 9] },
  { key: "temp", temp: true, label: "Temperature", unit: "°C", icon: <Thermometer className="size-4" />, color: "#fb923c", get: (c) => c.temperature_c, digits: 1, bad: (v) => v >= 38.5, ref: [36.1, 37.5] },
  { key: "spo2", label: "SpO₂", unit: "%", icon: <Wind className="size-4" />, color: "#60a5fa", get: (c) => c.spo2 ?? null, digits: 0, bad: (v) => v < 92, ref: [95, 100] },
  { key: "stress", label: "Stress", unit: "/10", icon: <HeartPulse className="size-4" />, color: "#a78bfa", get: (c) => c.stress, digits: 0, bad: (v) => v >= 8 },
];

export function CheckinTrends({ rows }: { rows: CheckIn[] }) {
  if (!rows.length) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SERIES.map((s) => {
        const pts = rows.map((c) => ({ t: c.date, v: s.get(c) })).filter((p): p is { t: string; v: number } => p.v != null);
        const last = pts.length ? [...pts].sort((a, b) => b.t.localeCompare(a.t))[0].v : null;
        const avg = pts.length ? pts.reduce((a, p) => a + p.v, 0) / pts.length : null;
        const warn = last != null && s.bad?.(last);
        return (
          <div key={s.key} className={`glass rounded-2xl p-4 min-w-0 ${warn ? "border-bad/40" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium"><span style={{ color: s.color }}>{s.icon}</span>{s.label}</div>
              <div className="text-right">
                <div className={`num text-xl font-semibold leading-none ${warn ? "text-bad" : ""}`}>{last == null ? "—" : last.toFixed(s.digits)}<span className="text-xs text-faint font-normal ml-0.5">{s.unit}</span></div>
                {s.temp && last != null && <div className={`num text-sm mt-0.5 ${warn ? "text-bad/80" : "text-muted"}`}>{cToF(last).toFixed(1)}<span className="text-[11px] text-faint ml-0.5">°F</span></div>}
                {avg != null && <div className="num text-[11px] text-faint mt-1">30-day avg {s.temp ? fmtTempShort(avg) : avg.toFixed(s.digits)}</div>}
              </div>
            </div>
            <div className="mt-3">
              {pts.length ? <Sparkline points={pts.map((p) => ({ ...p, flag: s.bad?.(p.v) ? "high" : null }))} color={s.color} refLow={s.ref?.[0]} refHigh={s.ref?.[1]} height={48}
                fmtV={s.temp ? (v) => fmtTempShort(v) : (v) => `${v.toFixed(s.digits)} ${s.unit}`} />
                : <div className="h-12 grid place-items-center text-xs text-faint">Not reported</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
