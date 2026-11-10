// Hand-written SVG charts for the record tabs: 14-day vitals area chart, sparkline, raw-reading detail chart.
import { useEffect, useId, useRef, useState } from "react";
import { fullDate, parseDate, shortDate } from "../lib/util";

export function useWidth<T extends HTMLElement>(min = 160): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}

function niceDomain(vals: number[], floor?: number, ceil?: number): [number, number] {
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const pad = Math.max((hi - lo) * 0.18, Math.abs(hi) * 0.02, 0.5);
  lo -= pad; hi += pad;
  if (floor != null) lo = Math.max(floor, lo);
  if (ceil != null) hi = Math.min(ceil, hi);
  if (hi <= lo) hi = lo + 1;
  return [lo, hi];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface DayPoint { date: string; value: number; lo?: number; hi?: number; n?: number }

/** Daily values over the last `days` days: area + line, optional min–max whiskers, the 14-day baseline band. */
export function VitalArea({ points, days = 14, color, band, baseline, fmt, floor, ceil, warnBelow, warnAbove, height = 120 }: {
  points: DayPoint[]; days?: number; color: string; band?: [number, number] | null; baseline?: number | null;
  fmt: (v: number) => string; floor?: number; ceil?: number; warnBelow?: number; warnAbove?: number; height?: number;
}) {
  const id = useId().replace(/:/g, "");
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = height, pl = 4, pr = 4, pt = 8, pb = 18;
  const iw = W - pl - pr, ih = H - pt - pb;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const slots = Array.from({ length: days }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - (days - 1 - i)); return dayKey(d); });
  const byDay = new Map(points.map((p) => [p.date, p]));
  const series = slots.map((k) => byDay.get(k) ?? null);

  const vals = points.flatMap((p) => [p.value, p.lo ?? p.value, p.hi ?? p.value]);
  if (band) vals.push(band[0], band[1]);
  if (baseline != null) vals.push(baseline);
  const [lo, hi] = niceDomain(vals.length ? vals : [0, 1], floor, ceil);
  const x = (i: number) => pl + (days <= 1 ? iw / 2 : (iw * i) / (days - 1));
  const y = (v: number) => pt + ih - (ih * (Math.max(lo, Math.min(hi, v)) - lo)) / (hi - lo);

  // line segments (gaps where a day has no data)
  const segs: { i: number; p: DayPoint }[][] = [];
  series.forEach((p, i) => {
    if (!p) { if (segs.length && segs[segs.length - 1].length) segs.push([]); return; }
    if (!segs.length) segs.push([]);
    segs[segs.length - 1].push({ i, p });
  });
  const live = segs.filter((s) => s.length);
  const lastIdx = series.reduce((a, p, i) => (p ? i : a), -1);
  const hp = hover != null ? series[hover] : null;
  const isWarn = (v: number) => (warnBelow != null && v < warnBelow) || (warnAbove != null && v > warnAbove);

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg width={W} height={H} className="block overflow-visible"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pl) / iw) * (days - 1));
          setHover(i >= 0 && i < days && series[i] ? i : null);
        }}>
        <defs>
          <linearGradient id={`va${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.32" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {band && (
          <g>
            <rect x={pl} width={iw} y={y(band[1])} height={Math.max(1.5, y(band[0]) - y(band[1]))} fill={color} opacity={0.09} rx={3} />
          </g>
        )}
        {baseline != null && (
          <line x1={pl} x2={W - pr} y1={y(baseline)} y2={y(baseline)} stroke={color} strokeOpacity={0.55} strokeDasharray="4 4" />
        )}
        {warnBelow != null && warnBelow > lo && warnBelow < hi && (
          <line x1={pl} x2={W - pr} y1={y(warnBelow)} y2={y(warnBelow)} stroke="var(--bad)" strokeOpacity={0.45} strokeDasharray="2 3" />
        )}
        {warnAbove != null && warnAbove > lo && warnAbove < hi && (
          <line x1={pl} x2={W - pr} y1={y(warnAbove)} y2={y(warnAbove)} stroke="var(--bad)" strokeOpacity={0.45} strokeDasharray="2 3" />
        )}
        {series.map((p, i) => p && p.lo != null && p.hi != null && (
          <line key={`r${i}`} x1={x(i)} x2={x(i)} y1={y(p.hi)} y2={y(p.lo)} stroke={color} strokeOpacity={hover === i ? 0.6 : 0.22} strokeWidth={3} strokeLinecap="round" />
        ))}
        {live.map((s, k) => {
          const line = s.map(({ i, p }, j) => `${j ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
          const area = s.length > 1 ? `${line} L${x(s[s.length - 1].i)},${pt + ih} L${x(s[0].i)},${pt + ih} Z` : "";
          return (
            <g key={k}>
              {area && <path d={area} fill={`url(#va${id})`} />}
              {s.length > 1 && <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
              {s.length === 1 && <circle cx={x(s[0].i)} cy={y(s[0].p.value)} r={2.5} fill={color} />}
            </g>
          );
        })}
        {series.map((p, i) => p && isWarn(p.value) && (
          <circle key={`w${i}`} cx={x(i)} cy={y(p.value)} r={3} fill="var(--bad)" stroke="var(--panel-solid)" strokeWidth={1.2} />
        ))}
        {lastIdx >= 0 && series[lastIdx] && (
          <g>
            <circle cx={x(lastIdx)} cy={y(series[lastIdx]!.value)} r={7} fill={color} opacity={0.25} className="pulse-dot" />
            <circle cx={x(lastIdx)} cy={y(series[lastIdx]!.value)} r={3.6} fill={color} stroke="var(--panel-solid)" strokeWidth={1.5} />
          </g>
        )}
        {[0, Math.floor((days - 1) / 2), days - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 4} textAnchor={i === 0 ? "start" : i === days - 1 ? "end" : "middle"} fontSize="9.5" fill="var(--faint)">
            {i === days - 1 ? "Today" : shortDate(slots[i])}
          </text>
        ))}
        {hp && hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={pt} y2={pt + ih} stroke="var(--border-hi)" strokeDasharray="3 3" />
        )}
      </svg>
      {hp && hover != null && (
        <div className="absolute z-10 pointer-events-none rounded-lg border border-line bg-solid/95 px-2.5 py-1.5 text-xs shadow-xl whitespace-nowrap"
          style={{ left: Math.min(Math.max(x(hover) - 60, 0), Math.max(0, W - 150)), top: -6, transform: "translateY(-100%)" }}>
          <div className="font-medium">{fullDate(slots[hover])}</div>
          <div className="num" style={{ color }}>{fmt(hp.value)}</div>
          {hp.lo != null && hp.hi != null && <div className="num text-faint">range {fmt(hp.lo)} – {fmt(hp.hi)}</div>}
          {hp.n != null && <div className="num text-faint">{hp.n.toLocaleString()} readings</div>}
        </div>
      )}
    </div>
  );
}

/** Small trend line over time with an optional reference band and baseline. */
export function Sparkline({ points, color = "var(--teal)", refLow, refHigh, baseline, height = 44, showDots = true, fmtV }: {
  points: { t: string; v: number; flag?: string | null }[]; color?: string; refLow?: number | null; refHigh?: number | null;
  baseline?: number | null; height?: number; showDots?: boolean; fmtV?: (v: number) => string;
}) {
  const id = useId().replace(/:/g, "");
  const [ref, W] = useWidth<HTMLDivElement>(80);
  const pts = [...points].map((p) => ({ ...p, ms: parseDate(p.t).getTime() })).sort((a, b) => a.ms - b.ms);
  const H = height, pad = 4;
  if (!pts.length) return <div ref={ref} style={{ height: H }} />;
  const vals = pts.map((p) => p.v);
  if (baseline != null) vals.push(baseline);
  const [lo, hi] = niceDomain(vals);
  const t0 = pts[0].ms, t1 = pts[pts.length - 1].ms;
  const x = (t: number) => pad + (t1 === t0 ? (W - 2 * pad) / 2 : ((W - 2 * pad) * (t - t0)) / (t1 - t0));
  const y = (v: number) => pad + (H - 2 * pad) * (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ms)},${y(p.v)}`).join(" ");
  const area = pts.length > 1 ? `${line} L${x(t1)},${H} L${x(t0)},${H} Z` : "";
  const rl = refLow != null ? Math.max(lo, refLow) : lo, rh = refHigh != null ? Math.min(hi, refHigh) : hi;
  return (
    <div ref={ref} className="w-full">
      <svg width={W} height={H} className="block overflow-visible">
        <defs>
          <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.25" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {(refLow != null || refHigh != null) && rh > rl && (
          <rect x={0} width={W} y={y(rh)} height={Math.max(1, y(rl) - y(rh))} fill="var(--teal)" opacity={0.07} />
        )}
        {baseline != null && <line x1={0} x2={W} y1={y(baseline)} y2={y(baseline)} stroke="var(--faint)" strokeDasharray="3 3" />}
        {area && <path d={area} fill={`url(#sp${id})`} />}
        {pts.length > 1 && <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />}
        {showDots && pts.map((p, i) => (
          <circle key={i} cx={x(p.ms)} cy={y(p.v)} r={i === pts.length - 1 ? 3.2 : 1.8}
            fill={p.flag ? (p.flag === "low" ? "var(--info)" : "var(--warn)") : color} stroke="var(--panel-solid)" strokeWidth={i === pts.length - 1 ? 1.2 : 0}>
            <title>{`${fullDate(p.t)}: ${fmtV ? fmtV(p.v) : p.v}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/** Raw readings over hours, with axis labels and hover. */
export function DetailChart({ points, color, fmt, warnBelow, warnAbove, floor, ceil }: {
  points: { ts: string; value: number }[]; color: string; fmt: (v: number) => string;
  warnBelow?: number; warnAbove?: number; floor?: number; ceil?: number;
}) {
  const id = useId().replace(/:/g, "");
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = points.map((p) => ({ ...p, ms: parseDate(p.ts).getTime() }));
  if (!pts.length) return <div ref={ref} className="h-60 grid place-items-center text-sm text-muted">No readings in this period.</div>;
  const [lo, hi] = niceDomain(pts.map((p) => p.value), floor, ceil);
  const H = 240, pr = 10, pt = 10, pb = 24;
  const pl = Math.max(40, Math.max(fmt(lo).length, fmt(hi).length) * 5.6 + 10);   // room for "37.0°C / 98.6°F"
  const iw = W - pl - pr, ih = H - pt - pb;
  const t0 = pts[0].ms, t1 = Math.max(pts[pts.length - 1].ms, t0 + 60000);
  const x = (t: number) => pl + (iw * (t - t0)) / (t1 - t0);
  const y = (v: number) => pt + ih - (ih * (Math.max(lo, Math.min(hi, v)) - lo)) / (hi - lo);
  // thin very dense series for drawing
  const step = Math.max(1, Math.floor(pts.length / Math.max(60, iw)));
  const drawn = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const line = drawn.map((p, i) => `${i ? "L" : "M"}${x(p.ms).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(drawn[drawn.length - 1].ms)},${pt + ih} L${x(drawn[0].ms)},${pt + ih} Z`;
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
  const yt = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * i) / 3);
  const hp = hover != null ? pts[hover] : null;
  return (
    <div ref={ref} className="relative w-full">
      <svg width={W} height={H} className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const t = t0 + ((e.clientX - r.left - pl) / iw) * (t1 - t0);
          let best = 0, bd = Infinity;
          for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i].ms - t); if (d < bd) { bd = d; best = i; } }
          setHover(best);
        }}>
        <defs>
          <linearGradient id={`dc${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {yt.map((v) => (
          <g key={v}>
            <line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke="var(--border)" />
            <text x={pl - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--faint)" className="num">{fmt(v)}</text>
          </g>
        ))}
        {[warnBelow, warnAbove].map((w, i) => w != null && w > lo && w < hi && (
          <line key={i} x1={pl} x2={W - pr} y1={y(w)} y2={y(w)} stroke="var(--bad)" strokeOpacity={0.6} strokeDasharray="4 3" />
        ))}
        <path d={area} fill={`url(#dc${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--faint)">
            {new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}
          </text>
        ))}
        {hp && (
          <g>
            <line x1={x(hp.ms)} x2={x(hp.ms)} y1={pt} y2={pt + ih} stroke="var(--border-hi)" strokeDasharray="3 3" />
            <circle cx={x(hp.ms)} cy={y(hp.value)} r={4} fill={color} stroke="var(--panel-solid)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div className="absolute pointer-events-none rounded-lg border border-line bg-solid/95 px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: Math.min(Math.max(x(hp.ms) - 60, 0), W - 140), top: 0 }}>
          <div className="font-medium">{fullDate(hp.ts)}</div>
          <div className="num" style={{ color }}>{fmt(hp.value)}</div>
        </div>
      )}
    </div>
  );
}
