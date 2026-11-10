// Shared pieces for the patient portal: context, cards, the gentle risk dial, plain words, emergency sheet, charts.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Phone, PhoneCall, Siren, X } from "lucide-react";
import type { RiskLevel } from "../types";
import { cx } from "../components/ui";
import { fmtTemp } from "../lib/temp";
import type { PortalMe } from "./api";

// ---------- context ----------
interface PortalCtx {
  me: PortalMe | null;
  reload: () => Promise<void>;
  openEmergency: () => void;
}
export const Ctx = createContext<PortalCtx>({ me: null, reload: async () => {}, openEmergency: () => {} });
export const usePortal = () => useContext(Ctx);

// ---------- words ----------
export const LEVEL_WORDS: Record<RiskLevel, { title: string; sub: string }> = {
  low: { title: "Low chance of a crisis this week", sub: "Keep doing what you're doing." },
  moderate: { title: "Some chance of a crisis this week", sub: "A few small changes today can help." },
  high: { title: "Higher chance of a crisis this week", sub: "Take extra care today. Your care team can see this too." },
  critical: { title: "Please get help now", sub: "Contact your care team or emergency services today." },
};
export const LEVEL_SHORT: Record<RiskLevel, string> = { low: "Low", moderate: "Some", high: "Higher", critical: "Very high" };
export const LEVEL_VAR: Record<RiskLevel, string> = {
  low: "var(--lv-low)", moderate: "var(--lv-mod)", high: "var(--lv-high)", critical: "var(--lv-crit)",
};

export function firstName(name?: string) { return (name || "").split(" ")[0] || "there"; }

export function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function ago(s?: string | null): string {
  if (!s) return "never";
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function dayLabel(s: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  return d.toLocaleDateString(undefined, opts);
}

/** Server text may say "Fever 38.9 °C": show every body temperature in both units ("38.9 °C (102.0 °F)"). */
export function bothUnits(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?)\s?°C(?!\s*\()/g, (_, n: string) => fmtTemp(parseFloat(n), n.includes(".") ? n.split(".")[1].length : 1));
}

// ---------- layout bits ----------
export function Card({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={cx("pt-card", className)}>{children}</As>;
}

export function H1({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="mb-5">
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{children}</h1>
      {sub && <p className="mt-1.5 text-[15px] text-muted">{sub}</p>}
    </header>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 mt-7 mb-3">
      <h2 className="text-[17px] font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-40 !rounded-[22px]" />
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-20 !rounded-[22px]" />)}
    </div>
  );
}

export function Oops({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Card className="p-5 text-[15px]">
      <p className="font-medium">We couldn't load this just now.</p>
      <p className="text-muted mt-1">{message}</p>
      {retry && <button onClick={retry} className="mt-3 h-11 px-5 rounded-full border border-linehi font-medium pt-tap">Try again</button>}
    </Card>
  );
}

export function Disclaimer({ className }: { className?: string }) {
  return (
    <p className={cx("text-[12.5px] leading-relaxed text-faint text-center", className)}>
      SickleGuard helps you and your care team spot problems early. It supports your care team, it doesn't replace
      them. If you feel unwell, trust yourself and get help.
    </p>
  );
}

// ---------- the gentle risk dial ----------
export type Cuts = { moderate: number; high: number; critical: number };
export const DEFAULT_CUTS: Cuts = { moderate: 4, high: 10, critical: 25 };
const ZONES: [number, number, RiskLevel][] = [[0, 0.3, "low"], [0.3, 0.55, "moderate"], [0.55, 0.77, "high"], [0.77, 1, "critical"]];

/** A half-circle dial with four soft zones and a marker; no alarming red unless the level is critical. The zones are
 *  stretched (not linear in score) so "low" isn't a sliver; the marker always sits inside the zone of `level`
 *  (red flags can make a low score critical). */
export function RiskDial({ score, level, size = 220, onDark, cuts = DEFAULT_CUTS }: { score: number; level: RiskLevel; size?: number; onDark?: boolean; cuts?: Cuts }) {
  const w = size, h = size * 0.6, r = size * 0.42, cx0 = w / 2, cy = h - 8, sw = size * 0.075;
  const edges = [0, cuts.moderate, cuts.high, cuts.critical, 100];
  const zone = ZONES.find((z) => z[2] === level)!;
  const i = ZONES.indexOf(zone);
  const frac = Math.max(0, Math.min(1, (score - edges[i]) / (edges[i + 1] - edges[i] || 1)));
  const t = zone[0] + 0.03 + frac * (zone[1] - zone[0] - 0.06);
  const pt = (t: number, rr = r) => [cx0 - rr * Math.cos(Math.PI * t), cy - rr * Math.sin(Math.PI * t)];
  const arc = (a: number, b: number) => {
    const [x1, y1] = pt(a), [x2, y2] = pt(b);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const [mx, my] = pt(t);
  const [show, setShow] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setShow(1)); return () => cancelAnimationFrame(id); }, []);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${LEVEL_WORDS[level].title}. Score ${Math.round(score)} out of 100.`}>
      {ZONES.map(([a, b, lv]) => (
        <path key={lv} d={arc(a + 0.008, b - 0.008)} stroke={LEVEL_VAR[lv]} strokeWidth={sw} strokeLinecap="round" fill="none"
          opacity={lv === level ? 1 : onDark ? 0.28 : 0.22} />
      ))}
      <circle cx={mx} cy={my} r={sw * 0.95} fill={onDark ? "#0b1328" : "var(--panel-solid)"} stroke={LEVEL_VAR[level]} strokeWidth={4}
        style={{ transition: "opacity .6s", opacity: show }} />
      <circle cx={mx} cy={my} r={sw * 0.38} fill={LEVEL_VAR[level]} style={{ transition: "opacity .6s", opacity: show }} />
    </svg>
  );
}

// ---------- emergency ----------
export const RED_FLAGS: { title: string; detail: string }[] = [
  { title: `Fever of ${fmtTemp(38.5)} or more`, detail: "or you feel hot and shivery" },
  { title: "Chest pain or trouble breathing", detail: "cough with fever, fast breathing, lips turning blue" },
  { title: "Stroke signs", detail: "face drooping, weak arm or leg, slurred speech, sudden bad headache, fits" },
  { title: "Pain your home plan can't control", detail: "or the worst pain you've had" },
  { title: "Sudden paleness, tiredness or a swollen tummy", detail: "especially in children" },
  { title: "An erection that won't go down", detail: "lasting more than 2 hours (priapism)" },
  { title: "Sudden change in your eyesight", detail: "" },
];

export function EmergencySheet({ open, onClose, me }: { open: boolean; onClose: () => void; me: PortalMe | null }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  const em = me?.emergency;
  const teamPhone = em?.care_team_phone || "";
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="em-title">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="pt-sheet relative w-full md:max-w-md max-h-[92vh] overflow-y-auto bg-solid text-fg rounded-t-[28px] md:rounded-[28px] shadow-2xl">
        <div className="sticky top-0 bg-solid/95 backdrop-blur px-5 pt-4 pb-3 flex items-center justify-between border-b border-line">
          <h2 id="em-title" className="flex items-center gap-2 text-lg font-semibold"><Siren className="size-5 text-acc" />Emergency help</h2>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="size-11 grid place-items-center rounded-full hover:bg-hi pt-tap"><X className="size-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <a href={`tel:${em?.phone || "112"}`} className="pt-tap flex items-center gap-4 rounded-2xl p-4 text-white grad-bg shadow-[0_10px_30px_-10px_var(--glow)]">
            <span className="size-12 rounded-full bg-white/20 grid place-items-center"><PhoneCall className="size-6" /></span>
            <span className="min-w-0">
              <span className="block text-[13px] opacity-90">Emergency services (Ghana)</span>
              <span className="block text-2xl font-bold tracking-wide">Call {em?.phone || "112"}</span>
            </span>
          </a>
          <div className="grid grid-cols-2 gap-3">
            <a href={`tel:${em?.ambulance || "193"}`} className="pt-tap rounded-2xl border border-linehi p-3.5">
              <span className="block text-[12.5px] text-muted">National Ambulance</span>
              <span className="flex items-center gap-1.5 text-lg font-semibold"><Phone className="size-4" />{em?.ambulance || "193"}</span>
            </a>
            {teamPhone ? (
              <a href={`tel:${teamPhone.replace(/\s/g, "")}`} className="pt-tap rounded-2xl border border-linehi p-3.5">
                <span className="block text-[12.5px] text-muted">My care team</span>
                <span className="flex items-center gap-1.5 text-[15px] font-semibold"><Phone className="size-4" />Call</span>
              </a>
            ) : (
              <div className="rounded-2xl border border-line p-3.5">
                <span className="block text-[12.5px] text-muted">My care team</span>
                <span className="block text-[13.5px] font-medium leading-snug">{me?.care_team || "Your clinic"}</span>
              </div>
            )}
          </div>
          {!teamPhone && (
            <p className="text-[13px] text-muted">Use the phone number on your clinic card to reach your care team.</p>
          )}
          <div className="pt-2">
            <h3 className="font-semibold text-[15px] mb-2">Go to the emergency department now if you have:</h3>
            <ul className="space-y-2">
              {RED_FLAGS.map((f) => (
                <li key={f.title} className="flex gap-3 rounded-xl bg-hi p-3">
                  <AlertTriangle className="size-5 shrink-0 text-acc mt-0.5" />
                  <span className="text-[14.5px] leading-snug"><b className="font-semibold">{f.title}</b>{f.detail && <span className="text-muted"> — {f.detail}</span>}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[13px] text-muted pt-1">Tell them you have sickle cell disease. Bring your medicines or care plan if you can.</p>
        </div>
      </div>
    </div>
  );
}

// ---------- chart ----------
export interface ChartPoint { x: string; y: number; label?: string }

/** One series over days, with optional soft level bands, a dashed "usual" line and a hover/tap readout. */
export function LineChart({ points, height = 170, color = "var(--teal)", min, max, bands, baseline, format = (v) => String(Math.round(v)), area = true, ariaLabel }:
  { points: ChartPoint[]; height?: number; color?: string; min?: number; max?: number;
    bands?: { from: number; to: number; color: string }[]; baseline?: number; format?: (v: number) => string; area?: boolean; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const ys = points.map((p) => p.y);
  let lo = min ?? Math.min(...ys, baseline ?? Infinity);
  let hi = max ?? Math.max(...ys, baseline ?? -Infinity);
  // never a degenerate axis: give flat or single-day series a sensible span around their value
  const minSpan = Math.max(Math.abs((lo + hi) / 2) * 0.06, 1);
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = min ?? mid - minSpan / 2;
    hi = max ?? mid + minSpan / 2;
    if (hi - lo < minSpan) hi = lo + minSpan;
  }
  const X = (i: number) => pad.l + (points.length < 2 ? (w - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (w - pad.l - pad.r));
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const ticks = useMemo(() => {
    const t = [lo, (lo + hi) / 2, hi];
    return new Set(t.map(format)).size === 3 ? t : [lo, hi];
  }, [lo, hi, format]);
  const gid = useMemo(() => "g" + Math.random().toString(36).slice(2, 8), []);
  const pick = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !points.length) return;
    const t = (clientX - r.left - pad.l) / (w - pad.l - pad.r);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(t * (points.length - 1)))));
  };
  if (!points.length) return null;
  const hp = hover !== null ? points[hover] : null;
  return (
    <div ref={ref} className="relative select-none w-full min-w-0" onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {bands?.map((b) => {
          const y1 = Y(Math.min(hi, b.to)), y2 = Y(Math.max(lo, b.from));
          return y2 > y1 ? <rect key={b.from} x={pad.l} width={w - pad.l - pad.r} y={y1} height={y2 - y1} fill={b.color} opacity={0.07} /> : null;
        })}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--border)" />
            <text x={pad.l - 6} y={Y(t) + 4} textAnchor="end" fontSize="11" fill="var(--faint)" className="num">{format(t)}</text>
          </g>
        ))}
        {baseline !== undefined && (
          <g>
            <line x1={pad.l} x2={w - pad.r} y1={Y(baseline)} y2={Y(baseline)} stroke="var(--muted)" strokeDasharray="4 4" opacity={0.7} />
            <text x={w - pad.r} y={Y(baseline) - 5} textAnchor="end" fontSize="10.5" fill="var(--muted)">your usual</text>
          </g>
        )}
        {area && points.length > 1 && <path d={`${line} L${X(points.length - 1)},${height - pad.b} L${X(0)},${height - pad.b} Z`} fill={`url(#${gid})`} />}
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.length < 2 && <circle cx={X(0)} cy={Y(points[0].y)} r={4} fill={color} />}
        <text x={pad.l} y={height - 5} fontSize="11" fill="var(--faint)">{dayLabel(points[0].x)}</text>
        <text x={w - pad.r} y={height - 5} fontSize="11" fill="var(--faint)" textAnchor="end">{dayLabel(points[points.length - 1].x)}</text>
        {hp && hover !== null && (
          <g>
            <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--border-hi)" />
            <circle cx={X(hover)} cy={Y(hp.y)} r={5} fill={color} stroke="var(--panel-solid)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && hover !== null && (
        <div className="absolute top-0 pointer-events-none rounded-xl bg-solid border border-linehi shadow-lg px-2.5 py-1.5 text-[12.5px] whitespace-nowrap"
          style={{ left: Math.min(Math.max(X(hover) - 60, 0), w - 130) }}>
          <div className="text-muted">{dayLabel(hp.x, { weekday: "short", day: "numeric", month: "short" })}</div>
          <div className="font-semibold num">{hp.label ?? format(hp.y)}</div>
        </div>
      )}
    </div>
  );
}
