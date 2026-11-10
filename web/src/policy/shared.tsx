// Shared bits for the policy dashboard: settings (cost per bed-day), number formatting, KPI tiles, panels.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cx } from "../components/ui";
import type { Count } from "./api";

// ---------------- settings ----------------
interface Settings { costBedDay: number; setCostBedDay: (n: number) => void; edVisit: number }
const Ctx = createContext<Settings>({ costBedDay: 600, setCostBedDay: () => {}, edVisit: 250 });
const KEY = "sg_policy_cost_bed_day";

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [costBedDay, set] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(KEY)); return v > 0 ? v : 600; } catch { return 600; }
  });
  const setCostBedDay = (n: number) => {
    set(n);
    try { localStorage.setItem(KEY, String(n)); } catch { /* ignore */ }
  };
  return <Ctx.Provider value={{ costBedDay, setCostBedDay, edVisit: 250 }}>{children}</Ctx.Provider>;
}
export const useSettings = () => useContext(Ctx);

/** Value that follows `v` after `ms` of quiet (for refetching on slider moves). */
export function useDebounced<T>(v: T, ms = 400): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** CSS (non-SVG) version of the suppressed-cell hatch. */
export const HATCH_CSS = "repeating-linear-gradient(45deg, color-mix(in srgb, var(--faint) 45%, transparent) 0 1.5px, var(--panel-hi) 1.5px 5px)";

// ---------------- formatting ----------------
export const isSup = (v: unknown) => v === "<5";
export function n0(v: Count | number | undefined, digits = 0): string {
  if (v === "<5") return "<5";
  if (v == null || (typeof v === "number" && isNaN(v))) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export function pct(v: number | null | undefined, digits = 0): string {
  return v == null ? "—" : `${(v * 100).toFixed(digits)} %`;
}
export function ghs(v: number | null | undefined, compact = true): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  const s = compact && a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)} M` : compact && a >= 1e4 ? `${(a / 1e3).toFixed(0)} k` : Math.round(a).toLocaleString();
  return `${v < 0 ? "−" : ""}GHS ${s}`;
}
export function monthLabel(m: string, withYear = false): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", ...(withYear ? { year: "2-digit" } : {}) });
}
export function weekLabel(s: string): string {
  const d = new Date(`${s}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// ---------------- KPI tile ----------------
/** `goodWhen` says which direction of change is good (crises down = good, coverage up = good). */
export function Kpi({ label, value, unit, delta, goodWhen = "down", hint, accent, sub }:
  { label: string; value: ReactNode; unit?: string; delta?: number | null; goodWhen?: "up" | "down"; hint?: string;
    accent?: "acc" | "teal" | "info" | "warn"; sub?: ReactNode }) {
  const good = delta == null || delta === 0 ? null : (delta < 0) === (goodWhen === "down");
  const Icon = delta == null || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const bar = { acc: "var(--acc)", teal: "var(--teal)", info: "var(--info)", warn: "var(--warn)" }[accent || "info"];
  return (
    <div className="obs-tile glass rounded-2xl p-4 min-w-0 relative overflow-hidden" title={hint}>
      <span className="absolute left-0 top-4 bottom-4 w-[2px] rounded-full" style={{ background: bar }} />
      <div className="text-[10.5px] uppercase tracking-[0.18em] text-faint truncate">{label}</div>
      <div className="mt-2 flex items-baseline gap-1.5 min-w-0">
        <div className="num text-[28px] leading-none font-semibold tracking-tight truncate">{value}</div>
        {unit && <div className="text-xs text-muted">{unit}</div>}
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-[11.5px] min-h-4">
        {delta !== undefined && (
          <span className={cx("inline-flex items-center gap-0.5 num font-medium whitespace-nowrap",
            good == null ? "text-muted" : good ? "text-teal" : "text-acc")}>
            <Icon className="size-3.5" />{delta == null ? "no prior data" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} %`}
          </span>
        )}
        {sub && <span className="text-faint truncate">{sub}</span>}
      </div>
    </div>
  );
}

export function Card({ title, sub, actions, children, className, eyebrow }:
  { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; eyebrow?: ReactNode }) {
  return (
    <section className={cx("glass rounded-2xl min-w-0", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            {eyebrow && <div className="text-[10px] uppercase tracking-[0.22em] text-faint mb-0.5">{eyebrow}</div>}
            <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
            {sub && <p className="text-xs text-muted mt-0.5 max-w-2xl">{sub}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageTitle({ eyebrow, title, sub, actions }: { eyebrow: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase tracking-[0.26em] text-teal/90 mb-1.5 flex items-center gap-2">
          <span className="h-px w-6 bg-teal/60" />{eyebrow}
        </div>
        <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
        {sub && <div className="text-sm text-muted mt-1 max-w-3xl">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SuppressedNote({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-2 text-[11px] text-faint", className)}>
      <svg width="14" height="14" aria-hidden><rect width="14" height="14" rx="3" fill="url(#obs-hatch)" stroke="var(--border-hi)" /></svg>
      Fewer than 5 patients: hidden to protect privacy
    </div>
  );
}

/** Hatch pattern used for suppressed cells; render once per page. */
export function HatchDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <pattern id="obs-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--panel-hi)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--faint)" strokeWidth="1.6" strokeOpacity="0.55" />
        </pattern>
      </defs>
    </svg>
  );
}

/** Element width via ResizeObserver. */
export function useWidth<T extends HTMLElement>(initial = 640): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Floating tooltip positioned inside a relative container. */
export function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 14), w - 220);
  return (
    <div className="pointer-events-none absolute z-20 w-[210px] rounded-xl border border-linehi bg-solid/95 backdrop-blur px-3 py-2 text-xs shadow-2xl"
      style={{ left, top: Math.max(0, y - 10) }}>
      {children}
    </div>
  );
}
export function TipRow({ label, value, swatch }: { label: ReactNode; value: ReactNode; swatch?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="flex items-center gap-1.5 text-muted">{swatch && <span className="size-2 rounded-sm" style={{ background: swatch }} />}{label}</span>
      <span className="num font-medium text-fg">{value}</span>
    </div>
  );
}
