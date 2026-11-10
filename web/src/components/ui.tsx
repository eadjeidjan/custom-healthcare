// Small shared building blocks.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useEffect } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import type { RiskLevel } from "../types";
import { LEVEL_COLOR, LEVEL_LABEL } from "../lib/util";

export function cx(...c: (string | false | null | undefined)[]) { return c.filter(Boolean).join(" "); }

type BtnVariant = "primary" | "teal" | "ghost" | "outline" | "danger";
export function Button({ variant = "outline", size = "md", loading, className, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  const v = {
    primary: "grad-bg text-white shadow-[0_8px_28px_-10px_var(--glow)] hover:brightness-110",
    teal: "teal-bg text-white shadow-[0_8px_28px_-12px_rgba(45,212,191,.5)] hover:brightness-110",
    ghost: "text-muted hover:text-fg hover:bg-hi",
    outline: "border border-line text-fg hover:border-linehi hover:bg-hi",
    danger: "border border-bad/40 text-bad hover:bg-bad/10",
  }[variant];
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-150 whitespace-nowrap",
        "active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
        size === "sm" ? "h-8 px-3 text-xs" : size === "lg" ? "h-11 px-5 text-sm" : "h-10 px-4 text-sm",
        v, className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Panel({ className, children, title, actions, icon, sub }:
  { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode; icon?: ReactNode; sub?: ReactNode }) {
  return (
    <section className={cx("glass rounded-2xl min-w-0", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide">{icon}{title}</h2>
            {sub && <p className="text-xs text-faint mt-0.5">{sub}</p>}
          </div>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

const tones = {
  acc: "text-acc bg-acc/10 border-acc/25",
  teal: "text-teal bg-teal/10 border-teal/25",
  ok: "text-ok bg-ok/10 border-ok/25",
  warn: "text-warn bg-warn/10 border-warn/25",
  bad: "text-bad bg-bad/10 border-bad/25",
  info: "text-info bg-info/10 border-info/25",
  muted: "text-muted bg-hi border-line",
} as const;
export type Tone = keyof typeof tones;
export function Badge({ tone = "muted", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

/** Colored pill for a risk level, optionally with the score. */
export function LevelPill({ level, score, className }: { level: RiskLevel; score?: number; className?: string }) {
  const c = LEVEL_COLOR[level];
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 whitespace-nowrap num", className)}
      style={{ color: c, borderColor: `color-mix(in srgb, ${c} 35%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)` }}
    >
      <span className={cx("size-1.5 rounded-full", level === "critical" && "pulse-dot")} style={{ background: c }} />
      {LEVEL_LABEL[level]}{score != null && <span className="opacity-80 font-medium">· {Math.round(score)}</span>}
    </span>
  );
}

/** Small horizontal score meter (0–100). */
export function ScoreBar({ score, level, className }: { score: number; level: RiskLevel; className?: string }) {
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <div className="relative h-1.5 w-20 rounded-full bg-hi overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full bar-grow" style={{ width: `${Math.max(2, Math.min(100, score))}%`, background: LEVEL_COLOR[level] }} />
      </div>
      <span className="num text-sm font-semibold w-7 text-right" style={{ color: LEVEL_COLOR[level] }}>{Math.round(score)}</span>
    </div>
  );
}

const field = "w-full rounded-xl border border-line bg-solid/60 px-3 text-sm text-fg placeholder:text-faint outline-none transition focus:border-teal/60 focus:ring-2 focus:ring-teal/20 disabled:opacity-60";
export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(field, "h-10", p.className)} />;
}
export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx(field, "py-2.5 resize-y", p.className)} />;
}
export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(field, "h-10 pr-8", p.className)} />;
}
export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <div className="text-[11px] font-medium text-muted uppercase tracking-wider">{children}</div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </div>
  );
}
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <label className={cx("block", className)}><Label hint={hint}>{label}</Label>{children}</label>;
}

export function Toggle({ checked, onChange, disabled, label }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer disabled:opacity-50",
        checked ? "teal-bg" : "bg-hi border border-line")}
    >
      <span className={cx("absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-teal", className)} />;
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9" />)}
    </div>
  );
}
export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad fade-in">
      <AlertTriangle className="size-4 mt-0.5 shrink-0" /><div className="min-w-0 break-words">{children}</div>
    </div>
  );
}
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-12 px-6">
      <div className="grid place-items-center size-12 rounded-2xl bg-hi border border-line text-teal">{icon}</div>
      <div className="font-medium">{title}</div>
      {children && <div className="text-sm text-muted max-w-sm">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, sub, actions, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div className="min-w-0">
        {eyebrow && <div className="text-[11px] uppercase tracking-[0.2em] text-faint mb-1">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub && <div className="text-sm text-muted mt-1">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8 fade-in", className)}>{children}</div>;
}

export function Modal({ open, onClose, title, children, wide }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm fade-in" onClick={onClose} />
      <div className={cx("relative w-full max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-solid border border-line shadow-2xl fade-in",
        wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 h-14 border-b border-line bg-solid/95 backdrop-blur">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-fg cursor-pointer" aria-label="Close"><X className="size-5" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }:
  { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-xl border border-line bg-solid/50 p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cx("h-8 px-3 rounded-[10px] text-xs font-medium transition cursor-pointer",
            value === o.value ? "bg-hi text-fg shadow-sm border border-line" : "text-muted hover:text-fg")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
