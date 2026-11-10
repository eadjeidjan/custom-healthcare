// Ask: a patient-safe chat. Answers stream in; emergency advice comes first when warning signs are mentioned.
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BookOpen, ChevronDown, MessageCircleHeart, RotateCcw, SendHorizonal, ShieldAlert } from "lucide-react";
import { Markdown } from "../components/clinical";
import { cx } from "../components/ui";
import type { Source } from "../types";
import { portal } from "./api";
import { usePortal } from "./kit";

interface Msg { role: "user" | "assistant"; content: string; sources?: Source[]; blocked?: boolean; error?: boolean; streaming?: boolean }

const SUGGEST = [
  "Why is my risk where it is this week?",
  "How much water should I drink?",
  "What can I do when pain starts?",
  "What do my latest blood tests mean?",
];

export default function Ask() {
  const { me } = usePortal();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [params, setParams] = useSearchParams();
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    portal.askHistory().then((h) => setMsgs((m) => (m.length ? m : h))).catch(() => {});
    return () => abortRef.current?.abort();
  }, []);
  useEffect(() => {
    const q = params.get("q");
    if (q) { setParams({}, { replace: true }); void send(q); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs]);

  const patch = (fn: (m: Msg) => Msg) => setMsgs((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);

  async function send(q: string) {
    q = q.trim();
    if (!q || busy) return;
    setText(""); setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "", streaming: true }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await portal.ask(q, (e) => {
        if (e.type === "token") patch((m) => ({ ...m, content: m.content + e.text }));
        else if (e.type === "sources") patch((m) => ({ ...m, sources: e.items }));
        else if (e.type === "blocked") patch((m) => ({ ...m, content: e.message, blocked: true }));
        else if (e.type === "error") patch((m) => ({ ...m, content: (m.content ? m.content + "\n\n" : "") + e.message, error: true }));
      }, { fresh, signal: ctrl.signal });
    } catch (err) {
      if (!ctrl.signal.aborted) patch((m) => ({ ...m, content: (err as Error).message, error: true }));
    } finally {
      patch((m) => ({ ...m, streaming: false }));
      setBusy(false); setFresh(false);
    }
  }

  function reset() {
    abortRef.current?.abort();
    setMsgs([]); setFresh(true);
  }

  const name = (me?.patient.name || "").split(" ")[0];
  return (
    <div className="fade-in flex flex-col min-h-[calc(100dvh-64px-84px-20px)] md:min-h-[calc(100dvh-64px-60px)]">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[26px] font-semibold tracking-tight">Ask</h1>
        {msgs.length > 0 && (
          <button onClick={reset} className="pt-tap h-10 px-3.5 rounded-full border border-line text-[13.5px] text-muted flex items-center gap-1.5"><RotateCcw className="size-4" />New chat</button>
        )}
      </div>

      <div className="flex-1 mt-4 space-y-4" aria-live="polite">
        {msgs.length === 0 && (
          <div className="pt-card p-5">
            <span className="size-12 rounded-2xl teal-bg text-white grid place-items-center"><MessageCircleHeart className="size-6" /></span>
            <p className="mt-3 text-[18px] font-semibold">Hi{name ? ` ${name}` : ""}, what would you like to know?</p>
            <p className="text-[14.5px] text-muted mt-1">I can explain your check-ins and results in simple words and share self-care tips. I can't examine you or change your medicines.</p>
            <div className="mt-4 grid gap-2">
              {SUGGEST.map((s) => (
                <button key={s} onClick={() => send(s)} className="pt-tap text-left rounded-2xl border border-line bg-hi/50 px-4 py-3 text-[15px] font-medium hover:border-linehi">{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => m.role === "user" ? (
          <div key={i} className="flex justify-end">
            <div className="max-w-[85%] rounded-[20px] rounded-br-md grad-bg text-white px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">{m.content}</div>
          </div>
        ) : (
          <div key={i} className="flex">
            <div className={cx("max-w-[92%] rounded-[20px] rounded-bl-md px-4 py-3 pt-card", m.blocked && "border-warn/40", m.error && "border-bad/40")}>
              {m.blocked && <p className="flex items-center gap-1.5 text-[12.5px] text-warn font-medium mb-1"><ShieldAlert className="size-4" />I can't do that</p>}
              {m.content ? <Markdown text={m.content} className={cx("text-[15px]", m.streaming && "caret")} /> :
                <span className="inline-flex gap-1 py-1" aria-label="Thinking">{[0, 1, 2].map((d) => <span key={d} className="size-2 rounded-full bg-faint pulse-dot" style={{ animationDelay: `${d * 0.18}s` }} />)}</span>}
              {m.sources && m.sources.length > 0 && !m.streaming && <Sources items={m.sources} />}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(text); }}
        className="sticky bottom-[calc(env(safe-area-inset-bottom,0px)+76px)] md:bottom-6 mt-4">
        <div className="pt-card p-1.5 pl-4 flex items-end gap-2 !rounded-[26px]">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={2000} placeholder="Type your question…" aria-label="Your question"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }}
            className="flex-1 resize-none bg-transparent outline-none py-3 text-[16px] max-h-32 placeholder:text-faint" />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Send"
            className="pt-tap size-12 shrink-0 rounded-full grad-bg text-white grid place-items-center disabled:opacity-40 transition active:scale-95">
            <SendHorizonal className="size-5" />
          </button>
        </div>
        <p className="text-[11.5px] text-faint text-center mt-1.5 px-4">Not for emergencies: call 112. Answers can be wrong; check with your care team.</p>
      </form>
    </div>
  );
}

function Sources({ items }: { items: Source[] }) {
  const [open, setOpen] = useState(false);
  const titles = [...new Set(items.map((s) => s.title))];
  return (
    <div className="mt-2.5 pt-2.5 border-t border-line">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="pt-tap flex items-center gap-1.5 text-[12.5px] text-muted h-8">
        <BookOpen className="size-3.5" />Based on {titles.length} guide{titles.length > 1 ? "s" : ""}<ChevronDown className={cx("size-3.5 transition", open && "rotate-180")} />
      </button>
      {open && <ul className="mt-1 space-y-1 text-[12.5px] text-muted list-disc pl-4">{titles.map((t) => <li key={t}>{t}</li>)}</ul>}
    </div>
  );
}
