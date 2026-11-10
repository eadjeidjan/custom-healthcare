// Hand-written SVG charts for the policy dashboard: Ghana tile map, monthly trend, forecast band, drivers, seasonality.
import { useState, type ReactNode } from "react";
import { cx } from "../components/ui";
import type { Driver, ForecastWeek, RegionRow, TrendRow } from "./api";
import { HATCH_CSS, Tip, TipRow, monthLabel, n0, pct, useWidth, weekLabel } from "./shared";

// ======================================================================= Ghana tile map
// Tile cartogram: one equal tile per region, placed roughly where the region lies (north at the top).
export const TILES: Record<string, { x: number; y: number; abbr: string }> = {
  "Upper West": { x: 0, y: 0, abbr: "UW" }, "Upper East": { x: 2, y: 0, abbr: "UE" },
  Savannah: { x: 0, y: 1, abbr: "SV" }, Northern: { x: 1, y: 1, abbr: "NR" }, "North East": { x: 2, y: 1, abbr: "NE" },
  Bono: { x: 0, y: 2, abbr: "BO" }, "Bono East": { x: 1, y: 2, abbr: "BE" }, Oti: { x: 2, y: 2, abbr: "OT" },
  Ahafo: { x: 0, y: 3, abbr: "AH" }, Ashanti: { x: 1, y: 3.5, abbr: "AS" }, Volta: { x: 3, y: 3, abbr: "VR" },
  Eastern: { x: 2, y: 4, abbr: "ER" }, "Western North": { x: 0, y: 4, abbr: "WN" },
  Western: { x: 0, y: 5, abbr: "WR" }, Central: { x: 1, y: 5, abbr: "CR" }, "Greater Accra": { x: 2, y: 5, abbr: "GA" },
};

export type MapMetric = "crises_per_100k" | "admissions_12m" | "hu_coverage" | "avg_risk";
export const MAP_METRICS: { value: MapMetric; label: string; good: boolean; fmt: (v: number) => string; long: string }[] = [
  { value: "crises_per_100k", label: "Crises / 100k", good: false, fmt: (v) => v.toFixed(1), long: "Crises in the last 12 months per 100,000 population" },
  { value: "admissions_12m", label: "Admissions", good: false, fmt: (v) => n0(v), long: "Hospital admissions for crises, last 12 months" },
  { value: "hu_coverage", label: "Hydroxyurea", good: true, fmt: (v) => pct(v), long: "Share of registered patients prescribed hydroxyurea" },
  { value: "avg_risk", label: "Average risk", good: false, fmt: (v) => v.toFixed(0), long: "Average current 7-day crisis risk score (0–100)" },
];

/** Sequential single-hue fill: crimson for burden, teal for coverage (more = better). */
export function seqFill(t: number, good: boolean): string {
  const hue = good ? "var(--teal)" : "var(--acc)";
  return `color-mix(in oklab, ${hue} ${Math.round(14 + Math.max(0, Math.min(1, t)) * 78)}%, var(--panel-solid))`;
}

export function GhanaTileMap({ rows, metric, selected, onSelect }:
  { rows: RegionRow[]; metric: MapMetric; selected?: string | null; onSelect?: (r: string | null) => void }) {
  const [ref, w] = useWidth<HTMLDivElement>(420);
  const [hover, setHover] = useState<{ r: RegionRow; x: number; y: number } | null>(null);
  const m = MAP_METRICS.find((x) => x.value === metric)!;
  const by = Object.fromEntries(rows.map((r) => [r.region, r]));
  const vals = rows.map((r) => r[metric]).filter((v): v is number => typeof v === "number");
  const lo = Math.min(...vals, metric === "hu_coverage" ? 0 : Infinity), hi = Math.max(...vals, 0);
  const span = hi - (isFinite(lo) ? lo : 0) || 1;
  const cols = 4, rowsN = 6, gap = 7;
  const size = Math.min(86, (Math.min(w, 520) - gap * (cols - 1)) / cols);
  const W = cols * size + (cols - 1) * gap, H = rowsN * size + (rowsN - 1) * gap;
  return (
    <div ref={ref} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} className="mx-auto block overflow-visible" role="img"
        aria-label={`Map of Ghana's 16 regions coloured by ${m.long}`}>
        {/* coastline hint */}
        <path d={`M ${-4} ${H + 6} L ${W - size - gap + 4} ${H + 6}`} stroke="var(--info)" strokeOpacity={0.35} strokeDasharray="2 5" />
        {Object.entries(TILES).map(([name, t]) => {
          const r = by[name];
          const v = r?.[metric];
          const x = t.x * (size + gap), y = t.y * (size + gap);
          const sup = r?.suppressed;
          const empty = !r || r.patients === 0;
          const fill = sup ? "url(#obs-hatch)" : typeof v === "number" ? seqFill((v - (isFinite(lo) ? lo : 0)) / span, m.good) : "var(--panel-hi)";
          const sel = selected === name;
          const dark = typeof v === "number" && !sup && (v - lo) / span > 0.55;
          return (
            <g key={name} className="cursor-pointer" onClick={() => onSelect?.(sel ? null : name)}
              onMouseMove={(e) => {
                const b = ref.current!.getBoundingClientRect();
                setHover({ r: r ?? ({ region: name } as RegionRow), x: e.clientX - b.left, y: e.clientY - b.top });
              }}
              onMouseLeave={() => setHover(null)}>
              <rect x={x} y={y} width={size} height={size} rx={12} fill={fill}
                stroke={sel ? "var(--text)" : "var(--border-hi)"} strokeWidth={sel ? 2 : 1}
                strokeDasharray={empty && !sup ? "3 4" : undefined} className="transition-[fill] duration-500" />
              <text x={x + 10} y={y + 20} fontSize={11} fontWeight={600} letterSpacing="0.08em"
                fill={dark ? "#fff" : "var(--muted)"}>{t.abbr}</text>
              <text x={x + 10} y={y + size - 14} fontSize={size > 80 ? 19 : 15} fontWeight={600} className="num"
                fill={dark ? "#fff" : "var(--text)"}>
                {sup ? "<5" : typeof v === "number" ? m.fmt(v) : "—"}
              </text>
              {size > 120 && (
                <text x={x + size - 10} y={y + 20} fontSize={9} textAnchor="end" fill={dark ? "rgba(255,255,255,.75)" : "var(--faint)"}>
                  {name.length > 11 ? "" : name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* legend */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[11px] text-faint">
        <div className="flex items-center gap-2">
          <span className="num">{vals.length ? m.fmt(isFinite(lo) ? lo : 0) : "—"}</span>
          <span className="h-2 w-28 rounded-full" style={{ background: `linear-gradient(90deg, ${seqFill(0, m.good)}, ${seqFill(1, m.good)})` }} />
          <span className="num">{vals.length ? m.fmt(hi) : "—"}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5"><svg width="12" height="12"><rect width="12" height="12" rx="3" fill="url(#obs-hatch)" /></svg>&lt;5 patients</span>
          <span className="flex items-center gap-1.5"><svg width="12" height="12"><rect x=".5" y=".5" width="11" height="11" rx="3" fill="none" stroke="var(--border-hi)" strokeDasharray="2 2" /></svg>no data</span>
        </div>
      </div>
      {hover && (
        <Tip x={hover.x} y={hover.y} w={w}>
          <div className="font-semibold mb-1">{hover.r.region}</div>
          {hover.r.suppressed ? <div className="text-faint">Fewer than 5 patients: figures hidden.</div>
            : hover.r.patients === 0 || hover.r.patients == null ? <div className="text-faint">No registered patients yet.</div> : (
              <>
                <TipRow label="Patients" value={n0(hover.r.patients)} />
                <TipRow label="Crises / 100k" value={n0(hover.r.crises_per_100k, 1)} />
                <TipRow label="Admissions (12 m)" value={n0(hover.r.admissions_12m)} />
                <TipRow label="Hydroxyurea" value={pct(hover.r.hu_coverage)} />
                <TipRow label="Average risk" value={n0(hover.r.avg_risk)} />
              </>
            )}
        </Tip>
      )}
    </div>
  );
}

// ======================================================================= axes helpers
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function Grid({ W, H, pad, max, fmt = (v: number) => n0(v) }:
  { W: number; H: number; pad: { l: number; r: number; t: number; b: number }; max: number; fmt?: (v: number) => string }) {
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return (
    <g>
      {ticks.map((t) => {
        const y = pad.t + (H - pad.t - pad.b) * (1 - t);
        return (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "2 4"} />
            <text x={pad.l - 8} y={y + 3.5} fontSize={10} textAnchor="end" fill="var(--faint)" className="num">{fmt(max * t)}</text>
          </g>
        );
      })}
    </g>
  );
}

// ======================================================================= monthly trend (crises with admissions inside)
export function MonthlyChart({ rows, height = 260 }: { rows: TrendRow[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const pad = { l: 40, r: 10, t: 14, b: 28 };
  const W = w, H = height;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const max = niceMax(Math.max(1, ...rows.map((r) => num(r.crises))));
  const bw = (W - pad.l - pad.r) / Math.max(1, rows.length);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const base = y(0);
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHi(null)}>
      <svg width={W} height={H} role="img" aria-label="Crises and admissions per month">
        <Grid W={W} H={H} pad={pad} max={max} />
        {rows.map((r, i) => {
          const x = pad.l + i * bw;
          const harm = [12, 1, 2].includes(Number(r.month.slice(5)));
          const inner = Math.max(2, Math.min(bw - 6, 26));
          const cx0 = x + (bw - inner) / 2;
          return (
            <g key={r.month} onMouseEnter={() => setHi(i)}>
              {harm && <rect x={x} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="var(--info)" opacity={0.06} />}
              <rect x={x} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {r.suppressed ? (
                <rect x={cx0} y={base - 22} width={inner} height={22} rx={4} fill="url(#obs-hatch)" />
              ) : (
                <>
                  <rect x={cx0} y={y(num(r.crises))} width={inner} height={Math.max(0, base - y(num(r.crises)))} rx={4}
                    fill="var(--acc)" fillOpacity={hi === null || hi === i ? 0.38 : 0.2} />
                  <rect x={cx0 + 4} y={y(num(r.admissions))} width={Math.max(1, inner - 8)} height={Math.max(0, base - y(num(r.admissions)))} rx={3}
                    fill="var(--acc)" fillOpacity={hi === null || hi === i ? 1 : 0.55} />
                </>
              )}
              {(rows.length <= 14 || i % 2 === 0) && (
                <text x={x + bw / 2} y={H - 10} fontSize={10} textAnchor="middle" fill="var(--faint)">
                  {monthLabel(r.month, r.month.endsWith("-01") || i === 0)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-4 px-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--acc)", opacity: 0.38 }} />All crises</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--acc)" }} />Admitted</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--info)", opacity: 0.3 }} />Harmattan (Dec–Feb)</span>
      </div>
      {hi !== null && rows[hi] && (
        <Tip x={pad.l + hi * bw + bw / 2} y={20} w={w}>
          <div className="font-semibold mb-1">{monthLabel(rows[hi].month, true)}</div>
          {rows[hi].suppressed ? <div className="text-faint">Crises in fewer than 5 patients: hidden.</div> : (
            <>
              <TipRow label="Crises" value={n0(rows[hi].crises)} swatch="color-mix(in srgb, var(--acc) 40%, transparent)" />
              <TipRow label="Admissions" value={n0(rows[hi].admissions)} swatch="var(--acc)" />
              <TipRow label="Bed-days" value={n0(rows[hi].bed_days)} />
            </>
          )}
          <TipRow label="Average risk" value={rows[hi].risk_suppressed ? "<5 pts" : n0(rows[hi].avg_risk)} />
        </Tip>
      )}
    </div>
  );
}

// ======================================================================= small line (average risk)
export function RiskLine({ rows, height = 140 }: { rows: TrendRow[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const W = w, H = height;
  const vals = rows.map((r) => r.avg_risk);
  const max = niceMax(Math.max(10, ...vals.filter((v): v is number => v != null)));
  const step = (W - pad.l - pad.r) / Math.max(1, rows.length);
  const x = (i: number) => pad.l + step * i + step / 2;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let d = "", pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? "L" : "M"} ${x(i)} ${y(v)} `;
    pen = true;
  });
  const has = vals.some((v) => v != null);
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHi(null)}>
      <svg width={W} height={H} role="img" aria-label="Average risk score per month">
        <Grid W={W} H={H} pad={pad} max={max} />
        {has && <path d={d} fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {vals.map((v, i) => v != null && (
          <circle key={i} cx={x(i)} cy={y(v)} r={hi === i ? 4.5 : 3} fill="var(--warn)" stroke="var(--panel-solid)" strokeWidth={2} />
        ))}
        {rows.map((r, i) => (
          <rect key={r.month} x={pad.l + step * i} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHi(i)} />
        ))}
        {!has && <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={12} fill="var(--faint)">Not enough assessed patients per month yet</text>}
      </svg>
      {hi !== null && rows[hi] && (
        <Tip x={x(hi)} y={10} w={w}>
          <div className="font-semibold mb-1">{monthLabel(rows[hi].month, true)}</div>
          <TipRow label="Average risk" value={rows[hi].risk_suppressed ? "hidden (<5)" : n0(rows[hi].avg_risk, 1)} swatch="var(--warn)" />
          <TipRow label="Patients assessed" value={n0(rows[hi].patients_assessed)} />
        </Tip>
      )}
    </div>
  );
}

// ======================================================================= forecast with band
export function ForecastChart({ weeks, height = 280 }: { weeks: ForecastWeek[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const pad = { l: 40, r: 14, t: 16, b: 30 };
  const W = w, H = height;
  const ok = weeks.filter((x) => x.expected_crises != null);
  const max = niceMax(Math.max(1, ...ok.map((x) => x.high ?? 0)));
  const step = (W - pad.l - pad.r) / Math.max(1, weeks.length - 1);
  const x = (i: number) => pad.l + step * i;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const line = (k: "expected_crises" | "expected_admissions") => weeks.map((wk, i) => `${i ? "L" : "M"} ${x(i)} ${y(wk[k] ?? 0)}`).join(" ");
  const band = weeks.map((wk, i) => `${i ? "L" : "M"} ${x(i)} ${y(wk.high ?? 0)}`).join(" ") + " " +
    weeks.slice().reverse().map((wk, j) => `L ${x(weeks.length - 1 - j)} ${y(wk.low ?? 0)}`).join(" ") + " Z";
  if (!ok.length) return <div className="py-14 text-center text-sm text-faint">Forecast hidden: fewer than 5 patients.</div>;
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHi(null)}>
      <svg width={W} height={H} role="img" aria-label="Expected crises per week with 90% band">
        <Grid W={W} H={H} pad={pad} max={max} fmt={(v) => (max < 10 ? v.toFixed(1) : n0(v))} />
        {weeks.map((wk, i) => wk.harmattan && (
          <rect key={wk.week_start} x={x(i) - step / 2} y={pad.t} width={step} height={H - pad.t - pad.b} fill="var(--info)" opacity={0.06} />
        ))}
        <path d={band} fill="var(--acc)" opacity={0.14} />
        <path d={line("expected_crises")} fill="none" stroke="var(--acc)" strokeWidth={2.2} strokeLinejoin="round" className="draw-line" />
        <path d={line("expected_admissions")} fill="none" stroke="var(--text)" strokeOpacity={0.7} strokeWidth={1.6} strokeDasharray="5 4" />
        {weeks.map((wk, i) => (
          <g key={wk.week_start}>
            <circle cx={x(i)} cy={y(wk.expected_crises ?? 0)} r={hi === i ? 5 : 3.5} fill="var(--acc)" stroke="var(--panel-solid)" strokeWidth={2} />
            <text x={x(i)} y={H - 10} fontSize={10} textAnchor="middle" fill="var(--faint)">{weekLabel(wk.week_start)}</text>
            <rect x={x(i) - step / 2} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHi(i)} />
          </g>
        ))}
        {hi !== null && <line x1={x(hi)} x2={x(hi)} y1={pad.t} y2={H - pad.b} stroke="var(--border-hi)" />}
      </svg>
      <div className="flex flex-wrap items-center gap-4 px-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: "var(--acc)" }} />Expected crises</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm" style={{ background: "var(--acc)", opacity: 0.2 }} />90 % range</span>
        <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed" style={{ borderColor: "var(--text)", opacity: 0.7 }} />Expected admissions</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--info)", opacity: 0.3 }} />Harmattan</span>
      </div>
      {hi !== null && weeks[hi] && (
        <Tip x={x(hi)} y={20} w={w}>
          <div className="font-semibold mb-1">Week of {weekLabel(weeks[hi].week_start)}</div>
          <TipRow label="Expected crises" value={n0(weeks[hi].expected_crises, 1)} swatch="var(--acc)" />
          <TipRow label="90 % range" value={`${n0(weeks[hi].low, 1)}–${n0(weeks[hi].high, 1)}`} />
          <TipRow label="Admissions" value={n0(weeks[hi].expected_admissions, 1)} />
          <TipRow label="Bed-days" value={n0(weeks[hi].expected_bed_days, 1)} />
          <TipRow label="Season index" value={weeks[hi].season_index.toFixed(2)} />
        </Tip>
      )}
    </div>
  );
}

// ======================================================================= seasonality strip
export function SeasonStrip({ index }: { index: Record<string, number> }) {
  const vals = Array.from({ length: 12 }, (_, i) => index[String(i + 1)] ?? 1);
  const max = Math.max(...vals), min = Math.min(...vals);
  return (
    <div className="grid grid-cols-12 gap-1">
      {vals.map((v, i) => (
        <div key={i} className="text-center" title={`Season index ${v.toFixed(2)}`}>
          <div className="h-10 rounded-md flex items-end justify-center overflow-hidden bg-hi/60">
            <div className="w-full rounded-md" style={{ height: `${20 + ((v - min) / (max - min || 1)) * 80}%`,
              background: [11, 0, 1].includes(i) ? "var(--info)" : "color-mix(in oklab, var(--info) 35%, var(--panel-solid))" }} />
          </div>
          <div className="mt-1 text-[9.5px] text-faint">{new Date(2026, i, 1).toLocaleDateString(undefined, { month: "narrow" })}</div>
          <div className="num text-[10px] text-muted">{v.toFixed(2)}</div>
        </div>
      ))}
    </div>
  );
}

// ======================================================================= drivers
export function DriverBars({ rows }: { rows: Driver[] }) {
  const max = Math.max(0.01, ...rows.map((r) => r.share_of_risk));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.factor} className="group grid grid-cols-[minmax(0,13rem)_1fr_4.5rem] items-center gap-3"
          title={r.suppressed ? "Pooled: each factor seen in fewer than 5 patients" : `${n0(r.patients_affected)} patients affected`}>
          <div className="min-w-0">
            <div className={cx("text-sm truncate", r.modifiable ? "text-fg" : "text-muted")}>{r.label}</div>
            <div className="text-[10.5px] text-faint truncate">
              {r.suppressed ? "pooled · <5 patients each" : `${n0(r.patients_affected)} patients${r.share_of_patients != null ? ` · ${pct(r.share_of_patients)}` : ""}`}
              {r.lever && <> · <span className="text-teal">{r.lever}</span></>}
            </div>
          </div>
          <div className="h-3 rounded-full bg-hi/70 overflow-hidden">
            <div className="h-full rounded-full bar-grow" style={{ width: `${(r.share_of_risk / max) * 100}%`,
              background: r.suppressed ? HATCH_CSS : r.modifiable ? "var(--acc)" : "color-mix(in oklab, var(--muted) 55%, var(--panel-solid))" }} />
          </div>
          <div className="num text-sm font-semibold text-right">{pct(r.share_of_risk, 1)}</div>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: ReactNode }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: it.color }} />{it.label}</span>
      ))}
    </div>
  );
}
