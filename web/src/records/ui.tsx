// Small pieces shared by the record tabs.
import { useRef, useState, type ReactNode } from "react";
import { AlertOctagon, AlertTriangle, ArrowDown, ArrowUp, Check, Copy, Info, Upload } from "lucide-react";
import { cx } from "../components/ui";
import type { Finding, LabFlag, Severity } from "./types";
import { SEVERITY } from "./meta";

export interface TabDef<T extends string> { id: T; label: string; icon: ReactNode; badge?: number | null; badgeTone?: "bad" | "warn" | "muted" }

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="glass rounded-2xl p-1 mb-4 overflow-x-auto">
      <div role="tablist" className="flex min-w-max gap-1">
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <button key={t.id} role="tab" aria-selected={on} type="button" onClick={() => onChange(t.id)}
              className={cx("relative inline-flex items-center gap-2 h-10 px-4 rounded-xl text-sm font-medium transition cursor-pointer whitespace-nowrap",
                on ? "bg-hi text-fg border border-linehi shadow-sm" : "text-muted hover:text-fg hover:bg-hi/50 border border-transparent")}>
              <span className={cx(on ? "text-teal" : "text-faint")}>{t.icon}</span>
              {t.label}
              {t.badge ? (
                <span className={cx("num min-w-5 h-5 px-1.5 rounded-full text-[10.5px] font-semibold grid place-items-center",
                  t.badgeTone === "bad" ? "bg-bad/15 text-bad border border-bad/30" : t.badgeTone === "warn" ? "bg-warn/15 text-warn border border-warn/30" : "bg-hi text-muted border border-line")}>
                  {t.badge}
                </span>
              ) : null}
              {on && <span className="absolute left-3 right-3 -bottom-px h-0.5 rounded-full teal-bg" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); }
        catch {
          const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } finally { ta.remove(); }
        }
        setDone(true); setTimeout(() => setDone(false), 1600);
      }}
      className={cx("inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition cursor-pointer",
        done ? "border-ok/40 text-ok bg-ok/10" : "border-line text-muted hover:text-fg hover:border-linehi", className)}>
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{done ? "Copied" : label}
    </button>
  );
}

export function SeverityIcon({ s, className }: { s: Severity; className?: string }) {
  const I = s === "severe" ? AlertOctagon : s === "moderate" ? AlertTriangle : Info;
  return <I className={cx("size-3.5 shrink-0", className)} style={{ color: SEVERITY[s].color }} />;
}

export function FindingChip({ f, dim }: { f: Finding; dim?: boolean }) {
  const s = SEVERITY[f.severity] ?? SEVERITY.info;
  return (
    <span title={`${s.label}${f.study_date ? ` · ${f.study_date}` : ""}`}
      className={cx("inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium leading-4", dim && "opacity-80")}
      style={{ color: s.color, borderColor: `color-mix(in srgb, ${s.color} 35%, transparent)`, background: `color-mix(in srgb, ${s.color} 10%, transparent)` }}>
      <SeverityIcon s={f.severity} />
      <span className="text-fg/90">{f.label}</span>
    </span>
  );
}

export function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) => (SEVERITY[a.severity]?.rank ?? 3) - (SEVERITY[b.severity]?.rank ?? 3));
}

export function LabFlagBadge({ flag }: { flag: LabFlag }) {
  if (!flag) return <span className="text-[11px] text-faint">in range</span>;
  const low = flag === "low";
  return (
    <span className={cx("inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
      low ? "text-info bg-info/10 border-info/30" : "text-warn bg-warn/10 border-warn/30")}>
      {low ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}{flag}
    </span>
  );
}

export function LiveDot({ label }: { label: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full rounded-full bg-teal opacity-60 animate-ping" />
        <span className="relative inline-flex size-2 rounded-full bg-teal" />
      </span>
      {label}
    </span>
  );
}

/** File picker with drag and drop; checks type and size before upload. */
export function DropZone({ accept, maxMb, file, onFile, hint }: {
  accept: string; maxMb: number; file: File | null; onFile: (f: File | null, error?: string) => void; hint?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const exts = accept.split(",").map((s) => s.trim().toLowerCase());
  function take(f?: File | null) {
    if (!f) return;
    const ok = exts.some((e) => f.name.toLowerCase().endsWith(e));
    if (!ok) return onFile(null, `Choose a ${exts.join(", ")} file.`);
    if (f.size > maxMb * 1024 * 1024) return onFile(null, `The file is larger than ${maxMb} MB.`);
    onFile(f);
  }
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
      onClick={() => input.current?.click()}
      className={cx("rounded-xl border-2 border-dashed px-4 py-5 text-center cursor-pointer transition",
        over ? "border-teal/70 bg-teal/[0.06]" : "border-line hover:border-linehi hover:bg-hi/40")}>
      <input ref={input} type="file" accept={accept} className="hidden" onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }} />
      <Upload className="size-5 mx-auto text-teal" />
      {file ? (
        <div className="mt-2 text-sm">
          <span className="font-medium">{file.name}</span> <span className="text-faint num">· {(file.size / 1024 / 1024).toFixed(2)} MB</span>
          <button type="button" className="ml-2 text-xs text-muted hover:text-bad underline cursor-pointer" onClick={(e) => { e.stopPropagation(); onFile(null); }}>remove</button>
        </div>
      ) : (
        <div className="mt-2 text-sm text-muted">Drop a file here or <span className="text-teal underline underline-offset-2">browse</span></div>
      )}
      {hint && <div className="mt-1 text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

export function StatTile({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-hi/40 px-3.5 py-2.5 min-w-0">
      <div className="text-[10.5px] uppercase tracking-wider text-faint truncate">{label}</div>
      <div className="num text-lg font-semibold leading-tight mt-0.5" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="text-[11px] text-faint truncate">{sub}</div>}
    </div>
  );
}
