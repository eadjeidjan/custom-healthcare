// Hand-written SVG charts: risk gauge, factor bars, trend lines, level distribution.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Crisis, Factor, RiskLevel } from "../types";
import { LEVEL_COLOR, LEVEL_LABEL, parseDate, shortDate, fullDate } from "../lib/util";
import { cx } from "./ui";

export interface Thresholds { moderate: number; high: number; critical: number }
export const DEFAULT_THRESHOLDS: Thresholds = { moderate: 20, high: 40, critical: 70 };
/** Thresholds may come back as probabilities (0–1) or score points (0–100); use points. */
export function toPoints(t?: Thresholds | null): Thresholds {
  if (!t) return DEFAULT_THRESHOLDS;
  const f = Math.max(t.moderate, t.high, t.critical) <= 1 ? 100 : 1;
  return { moderate: t.moderate * f, high: t.high * f, critical: t.critical * f };
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------- Gauge ----------------
export function RiskGauge({ score, level, size = 240, label, thresholds }:
  { score: number | null; level: RiskLevel | null; size?: number; label?: ReactNode; thresholds?: Thresholds }) {
  const id = useId().replace(/:/g, "");
  const r = 88, cx0 = 110, cy0 = 110, sw = 14;
  const start = 135, sweep = 270; // degrees, clockwise from +x
  const pt = (deg: number, rad = r) => {
    const a = (deg * Math.PI) / 180;
    return [cx0 + rad * Math.cos(a), cy0 + rad * Math.sin(a)];
  };
  const arc = (from: number, to: number, rad = r) => {
    const [x1, y1] = pt(from, rad), [x2, y2] = pt(to, rad);
    return `M ${x1} ${y1} A ${rad} ${rad} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const len = (2 * Math.PI * r * sweep) / 360;
  const s = score == null ? 0 : Math.max(0, Math.min(100, score));
  const color = level ? LEVEL_COLOR[level] : "var(--faint)";
  const th = thresholds ?? DEFAULT_THRESHOLDS;
  const bands: [number, number, RiskLevel][] = [
    [0, th.moderate, "low"], [th.moderate, th.high, "moderate"], [th.high, th.critical, "high"], [th.critical, 100, "critical"],
  ];
  const [nx, ny] = pt(start + (sweep * s) / 100, r);
  return (
    <div className="relative" style={{ width: size, height: size * 0.88 }}>
      <svg viewBox="0 0 220 194" width={size} height={size * 0.88} role="img" aria-label={`Risk score ${Math.round(s)} of 100`}>
        <defs>
          <filter id={`gl${id}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {/* level bands (thin outer ring) */}
        {bands.map(([a, b, lv]) => (
          <path key={lv} d={arc(start + (sweep * a) / 100 + 0.8, start + (sweep * b) / 100 - 0.8, r + 14)}
            stroke={LEVEL_COLOR[lv]} strokeOpacity={0.55} strokeWidth={3} fill="none" strokeLinecap="round" />
        ))}
        <path d={arc(start, start + sweep)} stroke="var(--panel-hi)" strokeWidth={sw} fill="none" strokeLinecap="round" />
        <path d={arc(start, start + sweep)} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round"
          strokeDasharray={len} strokeDashoffset={len * (1 - s / 100)} className="gauge-arc" filter={`url(#gl${id})`} />
        {score != null && <circle cx={nx} cy={ny} r={5} fill="#fff" stroke={color} strokeWidth={3} className="gauge-arc" />}
        {[0, 25, 50, 75, 100].map((t) => {
          const [x, y] = pt(start + (sweep * t) / 100, r - 22);
          return <text key={t} x={x} y={y + 3} textAnchor="middle" fontSize="8.5" fill="var(--faint)" className="num">{t}</text>;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-2 pointer-events-none">
        <div className="num font-semibold tracking-tight leading-none" style={{ fontSize: size * 0.24, color }}>
          {score == null ? "—" : Math.round(s)}
        </div>
        <div className="text-[11px] uppercase tracking-[0.2em] mt-1.5 font-semibold" style={{ color }}>
          {level ? `${LEVEL_LABEL[level]} risk` : "No assessment"}
        </div>
        {label && <div className="text-[11px] text-faint mt-1">{label}</div>}
      </div>
    </div>
  );
}

// ---------------- Factor bars ----------------
export function FactorBars({ factors }: { factors: Factor[] }) {
  const max = Math.max(1, ...factors.map((f) => Math.abs(f.impact)));
  return (
    <div className="space-y-2.5">
      {factors.map((f) => {
        const up = f.direction === "up";
        const w = (Math.abs(f.impact) / max) * 50;
        const c = up ? "var(--lv-crit)" : "var(--teal)";
        return (
          <div key={f.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_3rem] items-center gap-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium" title={f.label}>{f.label}</div>
              <div className="text-[11px] text-faint truncate" title={f.value}>{f.value}</div>
            </div>
            <div className="relative h-5">
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-linehi" />
              <div className="absolute top-1 bottom-1 rounded-full bar-grow"
                style={{
                  width: `${w}%`, left: up ? "50%" : `${50 - w}%`,
                  background: `linear-gradient(${up ? 90 : 270}deg, color-mix(in srgb, ${c} 45%, transparent), ${c})`,
                }} />
            </div>
            <div className="num text-right text-xs font-semibold" style={{ color: c }}>
              {up ? "+" : "−"}{Math.abs(f.impact).toFixed(1)}
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_3rem] gap-3 text-[10.5px] text-faint pt-1">
        <div />
        <div className="flex justify-between"><span>← lowers risk</span><span>raises risk →</span></div>
        <div className="text-right">pts</div>
      </div>
    </div>
  );
}

// ---------------- Level distribution ----------------
export function LevelDistribution({ levels }: { levels: Record<RiskLevel, number> }) {
  const order: RiskLevel[] = ["low", "moderate", "high", "critical"];
  const total = order.reduce((a, l) => a + (levels[l] || 0), 0) || 1;
  return (
    <div>
      <div className="flex h-3.5 rounded-full overflow-hidden bg-hi gap-0.5">
        {order.map((l) => levels[l] ? (
          <div key={l} className="bar-grow h-full first:rounded-l-full last:rounded-r-full" title={`${LEVEL_LABEL[l]}: ${levels[l]}`}
            style={{ width: `${(levels[l] / total) * 100}%`, background: LEVEL_COLOR[l] }} />
        ) : null)}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        {order.map((l) => (
          <div key={l} className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-sm" style={{ background: LEVEL_COLOR[l] }} />
            <div className="leading-tight">
              <div className="num font-semibold">{levels[l] || 0}</div>
              <div className="text-[11px] text-faint">{LEVEL_LABEL[l]} · {Math.round(((levels[l] || 0) / total) * 100)}%</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- Cohort trend ----------------
export function CohortTrend({ data }: { data: { date: string; avg_score: number; high: number }[] }) {
  const id = useId().replace(/:/g, "");
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 220, pl = 34, pr = 34, pt = 14, pb = 26;
  const iw = W - pl - pr, ih = H - pt - pb;
  const n = data.length;
  const maxS = Math.max(20, Math.ceil(Math.max(...data.map((d) => d.avg_score), 0) / 10) * 10);
  const maxH = Math.max(2, ...data.map((d) => d.high));
  const x = (i: number) => pl + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v: number) => pt + ih - (ih * v) / maxS;
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.avg_score)}`).join(" ");
  const area = n ? `${line} L${x(n - 1)},${pt + ih} L${x(0)},${pt + ih} Z` : "";
  const bw = Math.max(2, Math.min(14, (iw / Math.max(1, n)) * 0.55));
  const hd = hover != null ? data[hover] : null;
  return (
    <div ref={ref} className="relative w-full">
      <svg width={W} height={H} className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pl) / iw) * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}>
        <defs>
          <linearGradient id={`ar${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--teal)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--teal)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pl} x2={W - pr} y1={pt + ih * (1 - f)} y2={pt + ih * (1 - f)} stroke="var(--border)" />
            <text x={pl - 6} y={pt + ih * (1 - f) + 3} textAnchor="end" fontSize="10" fill="var(--faint)" className="num">{Math.round(maxS * f)}</text>
          </g>
        ))}
        <text x={W - pr + 6} y={pt + 3} fontSize="10" fill="var(--lv-high)" className="num">{maxH}</text>
        <text x={W - pr + 6} y={pt + ih + 3} fontSize="10" fill="var(--lv-high)" className="num">0</text>
        {data.map((d, i) => (
          <rect key={d.date} x={x(i) - bw / 2} width={bw} y={pt + ih - (ih * d.high) / maxH} height={(ih * d.high) / maxH}
            rx={2} fill="var(--lv-high)" opacity={hover === i ? 0.8 : 0.35} />
        ))}
        {n > 0 && <path d={area} fill={`url(#ar${id})`} />}
        {n > 0 && <path d={line} fill="none" stroke="var(--teal)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" className="draw-line" />}
        {data.map((d, i) => (i % Math.ceil(n / 6) === 0 || i === n - 1) && (
          <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--faint)">{shortDate(d.date)}</text>
        ))}
        {hd && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pt} y2={pt + ih} stroke="var(--border-hi)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(hd.avg_score)} r={4.5} fill="var(--teal)" stroke="var(--panel-solid)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hd && hover != null && (
        <div className="absolute pointer-events-none rounded-lg border border-line bg-solid/95 px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: Math.min(Math.max(x(hover) - 70, 0), W - 150), top: 0 }}>
          <div className="font-medium">{fullDate(hd.date)}</div>
          <div className="text-teal num">Avg score {hd.avg_score.toFixed(1)}</div>
          <div className="num" style={{ color: "var(--lv-high)" }}>{hd.high} high / critical</div>
        </div>
      )}
      <div className="flex gap-4 text-[11px] text-faint mt-1 px-1">
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-teal rounded" /> Average risk score</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--lv-high)", opacity: 0.6 }} /> Patients high or critical</span>
      </div>
    </div>
  );
}

// ---------------- Patient risk trend ----------------
export function PatientTrend({ points, crises, thresholds, days = 60 }:
  { points: { at: string; score: number; level: RiskLevel; kind: string }[]; crises: Crisis[]; thresholds: Thresholds; days?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 240, pl = 30, pr = 12, pt = 12, pb = 26;
  const iw = W - pl - pr, ih = H - pt - pb;
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const startT = end.getTime() - days * 86400000;
  const x = (t: number) => pl + (iw * (t - startT)) / (end.getTime() - startT);
  const y = (v: number) => pt + ih - (ih * Math.max(0, Math.min(100, v))) / 100;
  const pts = [...points]
    .map((p) => ({ ...p, t: parseDate(p.at).getTime() }))
    .filter((p) => p.t >= startT)
    .sort((a, b) => a.t - b.t);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.score)}`).join(" ");
  const bands: [number, number, RiskLevel][] = [
    [0, thresholds.moderate, "low"], [thresholds.moderate, thresholds.high, "moderate"],
    [thresholds.high, thresholds.critical, "high"], [thresholds.critical, 100, "critical"],
  ];
  const cr = crises.map((c) => ({ ...c, t: parseDate(c.date).getTime() + 43200000 })).filter((c) => c.t >= startT);
  const ticks = Array.from({ length: 5 }, (_, i) => startT + ((end.getTime() - startT) * i) / 4);
  const hp = hover != null ? pts[hover] : null;
  return (
    <div ref={ref} className="relative w-full">
      <svg width={W} height={H} className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          if (!pts.length) return;
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const mx = e.clientX - r.left;
          let best = 0, bd = Infinity;
          pts.forEach((p, i) => { const d = Math.abs(x(p.t) - mx); if (d < bd) { bd = d; best = i; } });
          setHover(bd < 40 ? best : null);
        }}>
        {bands.map(([a, b, lv]) => (
          <g key={lv}>
            <rect x={pl} width={iw} y={y(b)} height={y(a) - y(b)} fill={LEVEL_COLOR[lv]} opacity={0.07} />
            <text x={W - pr - 4} y={y(b) + 11} textAnchor="end" fontSize="9" fill={LEVEL_COLOR[lv]} opacity={0.8}
              className="uppercase" letterSpacing="0.1em">{LEVEL_LABEL[lv]}</text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((v) => (
          <text key={v} x={pl - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--faint)" className="num">{v}</text>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--faint)">
            {new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </text>
        ))}
        {cr.map((c) => (
          <g key={c.id}>
            <line x1={x(c.t)} x2={x(c.t)} y1={pt} y2={pt + ih} stroke="var(--lv-crit)" strokeDasharray="4 3" strokeOpacity={0.7} />
            <g transform={`translate(${x(c.t)},${pt + 6}) rotate(45)`}>
              <rect x={-5} y={-5} width={10} height={10} fill="var(--lv-crit)" stroke="var(--panel-solid)" strokeWidth={1.5}>
                <title>{`Crisis ${fullDate(c.date)} · ${c.severity}${c.hospitalised ? " · hospitalised" : ""}`}</title>
              </rect>
            </g>
          </g>
        ))}
        {pts.length > 1 && <path d={line} fill="none" stroke="var(--text)" strokeOpacity={0.85} strokeWidth={2} strokeLinejoin="round" className="draw-line" />}
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.score)} r={hover === i ? 6 : p.kind === "ai" ? 4.5 : 3.2}
            fill={LEVEL_COLOR[p.level]} stroke="var(--panel-solid)" strokeWidth={1.5} />
        ))}
      </svg>
      {hp && (
        <div className="absolute pointer-events-none rounded-lg border border-line bg-solid/95 px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: Math.min(Math.max(x(hp.t) - 70, 0), W - 160), top: Math.max(0, y(hp.score) - 64) }}>
          <div className="font-medium">{fullDate(hp.at)}</div>
          <div className="num" style={{ color: LEVEL_COLOR[hp.level] }}>{LEVEL_LABEL[hp.level]} · {Math.round(hp.score)}</div>
          <div className="text-faint">{hp.kind === "ai" ? "AI assessment" : "Check-in assessment"}</div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint mt-1 px-1">
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-fg/80 rounded" /> Risk score</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rotate-45" style={{ background: "var(--lv-crit)" }} /> Recorded crisis</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-line bg-hi" /> larger dot = AI assessment</span>
      </div>
    </div>
  );
}

// ---------------- Horizontal weights (model card) ----------------
export function WeightBars({ items }: { items: { key: string; label: string; weight: number; description: string }[] }) {
  const max = Math.max(1e-9, ...items.map((i) => Math.abs(i.weight)));
  const sorted = [...items].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return (
    <div className="space-y-2">
      {sorted.map((f) => {
        const pos = f.weight >= 0;
        const w = (Math.abs(f.weight) / max) * 50;
        const c = pos ? "var(--lv-crit)" : "var(--teal)";
        return (
          <div key={f.key} className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_3.5rem] items-center gap-3 text-sm" title={f.description}>
            <div className="min-w-0">
              <div className="truncate font-medium">{f.label}</div>
              <div className="text-[11px] text-faint truncate">{f.description}</div>
            </div>
            <div className="relative h-4">
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-linehi" />
              <div className={cx("absolute top-0.5 bottom-0.5 rounded-full bar-grow")}
                style={{ width: `${w}%`, left: pos ? "50%" : `${50 - w}%`, background: c, opacity: 0.85 }} />
            </div>
            <div className="num text-right text-xs font-semibold" style={{ color: c }}>{pos ? "+" : "−"}{Math.abs(f.weight).toFixed(2)}</div>
          </div>
        );
      })}
    </div>
  );
}
