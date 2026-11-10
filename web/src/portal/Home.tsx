// Home: greeting, today's risk in plain words, the top things to do today, streak, warning signs, shortcuts.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, BookOpen, Check, ChevronRight, ClipboardCheck, FileText, Flame, MessageCircleHeart, PhoneCall, Sparkles, TrendingDown, TrendingUp, Watch } from "lucide-react";
import { cx } from "../components/ui";
import { bothUnits, Card, Disclaimer, LEVEL_VAR, LEVEL_WORDS, Loading, RiskDial, SectionTitle, ago, firstName, greeting, usePortal } from "./kit";

function useDoneToday(): [Set<string>, (k: string) => void] {
  const key = `sg_portal_done_${new Date().toISOString().slice(0, 10)}`;
  const [done, setDone] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
  });
  const toggle = (k: string) => setDone((d) => {
    const n = new Set(d);
    if (n.has(k)) n.delete(k); else n.add(k);
    try { localStorage.setItem(key, JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });
  return [done, toggle];
}

export default function Home() {
  const { me, reload, openEmergency } = usePortal();
  const [done, toggle] = useDoneToday();
  useEffect(() => { void reload(); }, [reload]);
  if (!me) return <Loading />;

  const risk = me.risk;
  const level = risk?.level ?? "low";
  const words = LEVEL_WORDS[level];
  const flags = risk?.red_flags ?? [];
  const ups = (risk?.factors ?? []).filter((f) => f.direction === "up").slice(0, 3);
  const downs = (risk?.factors ?? []).filter((f) => f.direction === "down").slice(0, 2);
  const steps = me.next_steps;
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="fade-in">
      <p className="text-[13.5px] text-muted">{today}</p>
      <h1 className="text-[27px] leading-tight font-semibold tracking-tight mt-0.5">{greeting()}, {firstName(me.patient.name)}</h1>

      {flags.length > 0 && (
        <div role="alert" className="mt-4 rounded-[22px] p-4 bg-bad/10 border border-bad/35 flag-pulse">
          <div className="flex gap-3">
            <AlertTriangle className="size-6 text-bad shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold text-[16px]">Your last check-in shows a warning sign</p>
              <ul className="mt-1 text-[14.5px] text-muted list-disc pl-4">{flags.map((f) => <li key={f.key}>{bothUnits(f.label)}</li>)}</ul>
              <p className="mt-2 text-[14.5px]">Please get help now: call 112 or go to the nearest emergency department.</p>
              <a href="tel:112" className="pt-tap mt-3 inline-flex items-center gap-2 h-12 px-5 rounded-full grad-bg text-white font-semibold"><PhoneCall className="size-5" />Call 112</a>
            </div>
          </div>
        </div>
      )}

      {/* today's risk */}
      <section className="pt-hero mt-4 p-5 pb-4 overflow-hidden" aria-labelledby="risk-title">
        <div className="flex items-center justify-between text-[13px] pt-dim">
          <span>Your 7-day outlook</span>
          {risk && <span>Updated {ago(risk.created_at)}</span>}
        </div>
        {risk ? (
          <>
            <div className="flex justify-center mt-2"><RiskDial score={risk.score} level={level} size={232} onDark cuts={me.thresholds} /></div>
            <h2 id="risk-title" className="text-center text-[21px] font-semibold leading-snug -mt-3 px-2">{words.title}</h2>
            <p className="text-center pt-dim text-[14.5px] mt-1 px-4">{words.sub}</p>
            {(ups.length > 0 || downs.length > 0) && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {ups.map((f) => (
                  <span key={f.key} className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[13px]">
                    <TrendingUp className="size-3.5" style={{ color: LEVEL_VAR.high }} />{f.label}
                  </span>
                ))}
                {downs.map((f) => (
                  <span key={f.key} className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[13px]">
                    <TrendingDown className="size-3.5 text-[#2dd4bf]" />{f.label}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="py-8 text-center">
            <Sparkles className="size-8 mx-auto text-[#fb7185]" />
            <h2 id="risk-title" className="text-xl font-semibold mt-3">Let's get your first reading</h2>
            <p className="pt-dim mt-1 text-[14.5px]">Do a quick check-in and SickleGuard will show your outlook for the week.</p>
          </div>
        )}
        {!me.checked_in_today && (
          <Link to="/portal/check-in" className="pt-tap mt-5 flex items-center justify-center gap-2 h-13 py-3.5 rounded-2xl bg-white text-[#0d1730] font-semibold text-[16px] active:scale-[0.98] transition">
            <ClipboardCheck className="size-5" />Do today's check-in<span className="font-normal text-[#4d5874]">· 1 min</span>
          </Link>
        )}
      </section>

      {/* streak */}
      <Card className="mt-4 p-4 flex items-center gap-4">
        <span className={cx("size-12 rounded-2xl grid place-items-center shrink-0", me.streak_days ? "bg-acc/10 text-acc" : "bg-hi text-faint")}>
          <Flame className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[16px]">{me.streak_days ? `${me.streak_days}-day check-in streak` : "Start a check-in streak"}</p>
          <p className="text-[13.5px] text-muted">{me.checked_in_today ? "Today's check-in is done. Nice work!" : "Check in today to keep it going."}</p>
        </div>
        <div className="hidden min-[440px]:flex gap-1" aria-hidden>
          {Array.from({ length: 7 }).map((_, i) => (
            <span key={i} className={cx("size-2.5 rounded-full", i < Math.min(7, me.streak_days) ? "bg-acc" : "bg-hi border border-line")} />
          ))}
        </div>
      </Card>

      {/* things to do */}
      <SectionTitle>Today, try to</SectionTitle>
      <Card className="divide-y divide-[var(--border)]">
        {steps.map((s) => {
          const urgent = s.urgency === "now";
          const isDone = done.has(s.action);
          const inner = (
            <>
              <span className={cx("size-7 rounded-full border-2 grid place-items-center shrink-0 mt-0.5 transition",
                urgent ? "border-bad text-bad" : isDone ? "teal-bg border-transparent text-white" : "border-linehi text-transparent")}>
                {urgent ? <AlertTriangle className="size-4" /> : <Check className="size-4" strokeWidth={3} />}
              </span>
              <span className="min-w-0 text-left">
                <span className={cx("block text-[15.5px] font-medium leading-snug", isDone && "line-through text-faint")}>{bothUnits(s.action)}</span>
                <span className="block text-[13.5px] text-muted mt-0.5">{bothUnits(s.why)}</span>
              </span>
            </>
          );
          if (s.action.startsWith("Do today's check-in")) {
            return <Link key={s.action} to="/portal/check-in" className="pt-tap flex gap-3.5 p-4 items-start">{inner}<ChevronRight className="size-5 text-faint ml-auto shrink-0 mt-1" /></Link>;
          }
          if (urgent && s.action.includes("112")) {
            return <button key={s.action} onClick={openEmergency} className="pt-tap w-full flex gap-3.5 p-4 items-start bg-bad/5">{inner}</button>;
          }
          return (
            <button key={s.action} onClick={() => toggle(s.action)} aria-pressed={isDone} className="pt-tap w-full flex gap-3.5 p-4 items-start">{inner}</button>
          );
        })}
      </Card>

      {/* warning signs */}
      <button onClick={openEmergency} className="pt-tap mt-4 w-full text-left pt-card p-4 flex items-center gap-4 border-acc/30">
        <span className="size-12 rounded-2xl bg-acc/10 text-acc grid place-items-center shrink-0"><AlertTriangle className="size-6" /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[16px]">Know the warning signs</span>
          <span className="block text-[13.5px] text-muted">Fever, chest pain, stroke signs… and who to call</span>
        </span>
        <ChevronRight className="size-5 text-faint" />
      </button>

      {/* shortcuts */}
      <SectionTitle>Your health</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <Shortcut to="/portal/trends" icon={<TrendingUp className="size-5" />} title="My trends" sub="Risk and vitals over time" />
        <Shortcut to="/portal/devices" icon={<Watch className="size-5" />} title="My devices" sub={me.devices.length ? `${me.devices.length} connected` : "None yet"} />
        <Shortcut to="/portal/records" icon={<FileText className="size-5" />} title="My records" sub="Blood tests and scans" />
        <Shortcut to="/portal/learn" icon={<BookOpen className="size-5" />} title="Learn" sub="Simple self-care tips" />
      </div>
      <Link to="/portal/ask" className="pt-tap mt-3 pt-card p-4 flex items-center gap-4">
        <span className="size-12 rounded-2xl teal-bg text-white grid place-items-center shrink-0"><MessageCircleHeart className="size-6" /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[16px]">Got a question?</span>
          <span className="block text-[13.5px] text-muted">Ask SickleGuard in your own words</span>
        </span>
        <ChevronRight className="size-5 text-faint" />
      </Link>

      <Disclaimer className="mt-8 px-2" />
    </div>
  );
}

function Shortcut({ to, icon, title, sub }: { to: string; icon: ReactNode; title: string; sub: string }) {
  return (
    <Link to={to} className="pt-tap pt-card p-4 block active:scale-[0.98] transition">
      <span className="size-10 rounded-xl bg-hi grid place-items-center text-acc">{icon}</span>
      <span className="block mt-3 font-semibold text-[15px]">{title}</span>
      <span className="block text-[12.5px] text-muted mt-0.5">{sub}</span>
    </Link>
  );
}
