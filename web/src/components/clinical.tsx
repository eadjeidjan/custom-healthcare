// Clinical pieces shared across pages: red-flag banner, plan, sources, markdown.
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertOctagon, BookOpen, ChevronDown, Clock, Siren, Stethoscope, User as UserIcon } from "lucide-react";
import type { PlanItem, RedFlag, Source, Urgency } from "../types";
import { cx } from "./ui";

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("prose-chat", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Very prominent red banner; never hidden or collapsible. */
export function RedFlagBanner({ flags }: { flags: RedFlag[] }) {
  if (!flags.length) return null;
  return (
    <div role="alert" className="relative overflow-hidden rounded-2xl border-2 border-[#f43f5e] bg-gradient-to-r from-[#7f1d1d] via-[#9f1239] to-[#7f1d1d] text-white shadow-[0_10px_40px_-10px_rgba(244,63,94,.6)] flag-pulse fade-in">
      <div className="absolute inset-0 opacity-20 bg-[repeating-linear-gradient(135deg,transparent_0_14px,rgba(255,255,255,.12)_14px_28px)]" />
      <div className="relative p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <div className="grid place-items-center size-10 rounded-xl bg-white/15 shrink-0"><Siren className="size-5" /></div>
          <div>
            <div className="text-base sm:text-lg font-bold tracking-tight">Red flag{flags.length > 1 ? "s" : ""}: urgent action needed</div>
            <div className="text-xs text-white/80">These override the model score. Act on them now.</div>
          </div>
        </div>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {flags.map((f) => (
            <li key={f.key} className="rounded-xl bg-black/25 border border-white/15 px-3.5 py-2.5">
              <div className="flex items-center gap-2 font-semibold"><AlertOctagon className="size-4 shrink-0" />{f.label}</div>
              <div className="text-sm text-white/90 mt-0.5 pl-6">→ {f.action}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const URG: { key: Urgency; label: string; tone: string; icon: typeof Clock }[] = [
  { key: "now", label: "Now", tone: "var(--lv-crit)", icon: Siren },
  { key: "today", label: "Today", tone: "var(--lv-high)", icon: Clock },
  { key: "this week", label: "This week", tone: "var(--teal)", icon: Clock },
];

export function PlanView({ plan }: { plan: PlanItem[] }) {
  if (!plan.length) return <div className="text-sm text-muted">No plan items.</div>;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {URG.map(({ key, label, tone, icon: Icon }) => {
        const items = plan.filter((p) => p.urgency === key);
        return (
          <div key={key} className="rounded-xl border border-line bg-solid/40 min-w-0">
            <div className="flex items-center justify-between px-3.5 h-10 border-b border-line">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: tone }}>
                <Icon className="size-3.5" />{label}
              </div>
              <span className="num text-[11px] text-faint">{items.length}</span>
            </div>
            <ul className="p-2.5 space-y-2">
              {items.length === 0 && <li className="text-xs text-faint px-1 py-2">Nothing at this urgency.</li>}
              {items.map((p, i) => (
                <li key={i} className="rounded-lg bg-hi/60 border border-line px-3 py-2.5">
                  <div className="text-sm font-medium leading-snug">{p.action}</div>
                  <div className="text-xs text-muted mt-1 leading-relaxed">{p.why}</div>
                  <div className="mt-2 inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-faint">
                    {p.who === "patient" ? <UserIcon className="size-3" /> : <Stethoscope className="size-3" />}{p.who}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function SourcesList({ sources, defaultOpen = false, title = "Guideline sources" }:
  { sources: Source[]; defaultOpen?: boolean; title?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!sources.length) return null;
  return (
    <div className="rounded-xl border border-line bg-solid/30">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3.5 h-10 text-xs font-medium text-muted hover:text-fg cursor-pointer">
        <BookOpen className="size-3.5 text-teal" />{title}<span className="num text-faint">({sources.length})</span>
        <ChevronDown className={cx("size-4 ml-auto transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="px-3 pb-3 space-y-2 fade-in">
          {sources.map((s, i) => (
            <li key={i} className="rounded-lg border border-line bg-hi/40 px-3 py-2 cursor-pointer" onClick={() => setExpanded(expanded === i ? null : i)}>
              <div className="flex items-center gap-2">
                <span className="num grid place-items-center size-5 rounded-md bg-teal/15 text-teal text-[10px] font-bold">{i + 1}</span>
                <span className="text-sm font-medium truncate flex-1">{s.title}</span>
                <ScoreChip score={s.score} />
              </div>
              <p className={cx("text-xs text-muted mt-1.5 leading-relaxed whitespace-pre-wrap", expanded !== i && "line-clamp-2")}>{s.snippet}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ScoreChip({ score }: { score: number }) {
  return (
    <span className="num shrink-0 text-[10.5px] font-mono px-1.5 py-0.5 rounded-md bg-hi border border-line text-muted" title="Similarity score">
      {score <= 1 ? score.toFixed(3) : score.toFixed(1)}
    </span>
  );
}
