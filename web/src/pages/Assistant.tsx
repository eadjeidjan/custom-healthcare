import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowUp, Bot, ChevronDown, CircleSlash, History, Loader2, MessageSquarePlus, Plug, Square, User as UserIcon, Wrench, X, AlertTriangle,
} from "lucide-react";
import type { ChatEvent, Source, ThreadSummary } from "../types";
import { api } from "../lib/api";
import { streamPost } from "../lib/sse";
import { useAsync, when } from "../lib/util";
import { useToast } from "../lib/toast";
import { Badge, Select, Spinner, cx } from "../components/ui";
import { Markdown, SourcesList } from "../components/clinical";
import Logo from "../components/Logo";

interface ToolCall { name: string; args?: Record<string, unknown>; preview?: string; done: boolean }
interface Msg {
  role: "user" | "assistant"; content: string; tools: ToolCall[]; sources: Source[];
  blocked?: string; error?: string; streaming?: boolean;
}

const STARTERS = [
  "Which patients are at highest risk this week and why?",
  "Explain this patient's risk and draft a prevention plan",
  "What are the red flags that need emergency care?",
  "Who hasn't checked in for 3 days or more?",
];

export default function Assistant() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [patientId, setPatientId] = useState<string>(params.get("patient") || "");
  const [threadId, setThreadId] = useState<string | null>(params.get("thread"));
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const threads = useAsync(() => api.threads(), []);
  const patients = useAsync(() => api.patients(), []);
  const tools = useAsync(() => api.tools(), []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs]);

  // open thread from URL on first load
  useEffect(() => { if (threadId) void openThread(threadId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function openThread(id: string) {
    abortRef.current?.abort();
    setShowThreads(false);
    setLoadingThread(true);
    try {
      const t = await api.thread(id);
      setThreadId(t.id);
      if (t.patient_id) setPatientId(t.patient_id);
      setMsgs(t.messages.map((m) => ({
        role: m.role, content: m.content, sources: [],
        tools: (m.tools ?? []).map((n) => ({ name: n, done: true })),
      })));
      setParams((p) => { p.set("thread", t.id); return p; }, { replace: true });
    } catch (e) { toast.error((e as Error).message); }
    finally { setLoadingThread(false); }
  }

  function newChat() {
    abortRef.current?.abort();
    setThreadId(null); setMsgs([]); setShowThreads(false);
    setParams((p) => { p.delete("thread"); return p; }, { replace: true });
  }

  function patchLast(fn: (m: Msg) => Msg) {
    setMsgs((xs) => { const c = xs.slice(); c[c.length - 1] = fn(c[c.length - 1]); return c; });
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMsgs((xs) => [...xs,
      { role: "user", content: message, tools: [], sources: [] },
      { role: "assistant", content: "", tools: [], sources: [], streaming: true }]);
    const ctl = new AbortController();
    abortRef.current = ctl;
    const onEvent = (e: ChatEvent) => {
      switch (e.type) {
        case "thread":
          setThreadId(e.thread_id);
          setParams((p) => { p.set("thread", e.thread_id); return p; }, { replace: true });
          break;
        case "token": patchLast((m) => ({ ...m, content: m.content + e.text })); break;
        case "tool": patchLast((m) => ({ ...m, tools: [...m.tools, { name: e.name, args: e.args, done: false }] })); break;
        case "tool_result": patchLast((m) => {
          const ts = m.tools.slice();
          let i = -1;
          for (let k = ts.length - 1; k >= 0; k--) if (ts[k].name === e.name && !ts[k].done) { i = k; break; }
          if (i >= 0) ts[i] = { ...ts[i], preview: e.preview, done: true };
          else ts.push({ name: e.name, preview: e.preview, done: true });
          return { ...m, tools: ts };
        }); break;
        case "sources": patchLast((m) => ({ ...m, sources: e.items })); break;
        case "blocked": patchLast((m) => ({ ...m, blocked: e.message })); break;
        case "error": patchLast((m) => ({ ...m, error: e.message })); break;
        case "done": patchLast((m) => ({ ...m, streaming: false })); break;
      }
    };
    try {
      await streamPost("/assistant/chat", { message, thread_id: threadId || undefined, patient_id: patientId || undefined }, onEvent, ctl.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") patchLast((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      patchLast((m) => ({ ...m, streaming: false, tools: m.tools.map((t) => ({ ...t, done: true })) }));
      setBusy(false);
      abortRef.current = null;
      threads.reload(true);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void send(input); }

  const selectedPatient = patients.data?.find((p) => p.id === patientId);

  const threadList = (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-line">
        <button onClick={newChat} className="w-full h-10 rounded-xl grad-bg text-white text-sm font-medium inline-flex items-center justify-center gap-2 cursor-pointer hover:brightness-110">
          <MessageSquarePlus className="size-4" />New conversation
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {threads.loading && !threads.data && <div className="p-4 grid place-items-center"><Spinner /></div>}
        {threads.data?.length === 0 && <div className="text-xs text-faint p-4 text-center">No conversations yet.</div>}
        {threads.data?.map((t: ThreadSummary) => (
          <button key={t.id} onClick={() => openThread(t.id)}
            className={cx("w-full text-left rounded-xl px-3 py-2.5 transition cursor-pointer",
              t.id === threadId ? "bg-hi text-fg" : "text-muted hover:bg-hi/60 hover:text-fg")}>
            <div className="text-sm truncate">{t.title || "Untitled"}</div>
            <div className="text-[11px] text-faint flex items-center gap-1.5 mt-0.5">
              {when(t.updated_at)}
              {t.patient_id && <span className="truncate">· {patients.data?.find((p) => p.id === t.patient_id)?.name ?? "patient"}</span>}
            </div>
          </button>
        ))}
      </div>
      <ToolsPanel tools={tools.data} />
    </div>
  );

  return (
    <div className="h-full flex min-h-0">
      <aside className="hidden md:block w-72 shrink-0 border-r border-line bg-solid/30">{threadList}</aside>
      {showThreads && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowThreads(false)} />
          <div className="absolute inset-y-0 left-0 w-72 bg-solid border-r border-line fade-in">
            <button onClick={() => setShowThreads(false)} className="absolute right-2 top-2 z-10 text-muted cursor-pointer"><X className="size-5" /></button>
            {threadList}
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* context bar */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-line bg-solid/20">
          <button onClick={() => setShowThreads(true)} className="md:hidden inline-flex items-center gap-1.5 text-sm text-muted cursor-pointer"><History className="size-4" />Threads</button>
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-faint text-xs uppercase tracking-wider hidden sm:inline">Patient</span>
            <Select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="h-9 w-56 max-w-[60vw]">
              <option value="">Whole cohort (no patient)</option>
              {patients.data?.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.mrn}</option>)}
            </Select>
            {selectedPatient?.risk && (
              <Badge tone={selectedPatient.risk.level === "critical" ? "bad" : selectedPatient.risk.level === "high" ? "warn" : "teal"}>
                risk {Math.round(selectedPatient.risk.score)}
              </Badge>
            )}
          </div>
          <div className="flex-1" />
          <span className="text-[11px] text-faint hidden lg:inline">LangGraph agent · MCP tools · guideline RAG</span>
        </div>

        {/* messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
            {loadingThread && <div className="grid place-items-center py-20"><Spinner /></div>}
            {!loadingThread && msgs.length === 0 && (
              <div className="pt-10 sm:pt-16 text-center fade-in">
                <div className="inline-flex"><Logo size={52} /></div>
                <h2 className="text-2xl font-semibold tracking-tight mt-4">Care assistant</h2>
                <p className="text-sm text-muted mt-2 max-w-md mx-auto">
                  Ask about risk, red flags or prevention. It looks up patient data with tools and cites sickle cell guidance.
                  {selectedPatient && <> Focused on <span className="text-fg font-medium">{selectedPatient.name}</span>.</>}
                </p>
                <div className="grid sm:grid-cols-2 gap-2.5 mt-8 text-left">
                  {STARTERS.map((s) => (
                    <button key={s} onClick={() => send(s)}
                      className="glass rounded-xl px-4 py-3 text-sm text-muted hover:text-fg hover:border-linehi transition cursor-pointer">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => <Message key={i} m={m} />)}
            <div ref={endRef} />
          </div>
        </div>

        {/* composer */}
        <form onSubmit={submit} className="px-4 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <div className="glass glow rounded-2xl flex items-end gap-2 p-2 focus-within:border-teal/50 transition">
              <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} rows={1}
                placeholder={selectedPatient ? `Ask about ${selectedPatient.name}…` : "Ask about your patients…"}
                className="flex-1 resize-none bg-transparent outline-none px-3 py-2 text-sm max-h-40 placeholder:text-faint"
                style={{ fieldSizing: "content" } as React.CSSProperties} />
              {busy ? (
                <button type="button" onClick={() => abortRef.current?.abort()} title="Stop"
                  className="grid place-items-center size-9 rounded-xl bg-hi border border-line text-fg cursor-pointer"><Square className="size-3.5" /></button>
              ) : (
                <button type="submit" disabled={!input.trim()} title="Send"
                  className="grid place-items-center size-9 rounded-xl grad-bg text-white disabled:opacity-40 cursor-pointer"><ArrowUp className="size-4" /></button>
              )}
            </div>
            <p className="text-[10.5px] text-faint text-center mt-2">Decision support only — not a diagnosis. Check answers against the patient record.</p>
          </div>
        </form>
      </div>
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end gap-3 fade-in">
        <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-hi border border-line px-4 py-2.5 text-sm whitespace-pre-wrap">{m.content}</div>
        <div className="grid place-items-center size-8 rounded-full bg-hi border border-line shrink-0"><UserIcon className="size-4 text-muted" /></div>
      </div>
    );
  }
  const thinking = m.streaming && !m.content && !m.blocked && !m.error;
  return (
    <div className="flex gap-3 fade-in">
      <div className="grid place-items-center size-8 rounded-full bg-acc/10 border border-acc/30 shrink-0"><Bot className="size-4 text-acc" /></div>
      <div className="flex-1 min-w-0 space-y-2.5">
        {m.tools.length > 0 && <div className="flex flex-col gap-1.5">{m.tools.map((t, i) => <ToolChip key={i} t={t} />)}</div>}
        {thinking && m.tools.every((t) => t.done) && <div className="text-sm shimmer">Thinking…</div>}
        {m.content && <div className={cx(m.streaming && "caret")}><Markdown text={m.content} /></div>}
        {m.blocked && (
          <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/[0.08] px-3 py-2.5 text-sm">
            <CircleSlash className="size-4 text-warn mt-0.5 shrink-0" />
            <div><div className="font-medium text-warn">Question not answered</div><div className="text-muted text-xs mt-0.5">{m.blocked}</div></div>
          </div>
        )}
        {m.error && (
          <div className="flex items-start gap-2 rounded-xl border border-bad/30 bg-bad/[0.08] px-3 py-2.5 text-sm">
            <AlertTriangle className="size-4 text-bad mt-0.5 shrink-0" />
            <div><div className="font-medium text-bad">Something went wrong</div><div className="text-muted text-xs mt-0.5">{m.error}</div></div>
          </div>
        )}
        {m.sources.length > 0 && <SourcesList sources={m.sources} title="Sources" />}
      </div>
    </div>
  );
}

function ToolChip({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const args = t.args ? Object.entries(t.args).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ") : "";
  const expandable = !!(t.preview || (t.args && Object.keys(t.args).length));
  return (
    <div className={cx("rounded-xl border text-xs transition w-fit max-w-full", t.done ? "border-line bg-solid/40" : "border-teal/40 bg-teal/[0.06]")}>
      <button type="button" onClick={() => expandable && setOpen(!open)} className={cx("flex items-center gap-2 px-2.5 h-8 max-w-full", expandable && "cursor-pointer")}>
        {t.done ? <Wrench className="size-3.5 text-teal shrink-0" /> : <Loader2 className="size-3.5 text-teal animate-spin shrink-0" />}
        <span className="font-mono font-medium">{t.name}</span>
        {args && <span className="font-mono text-faint truncate max-w-[40vw] sm:max-w-sm">({args})</span>}
        {t.done && t.preview && <span className="text-faint">· result</span>}
        {expandable && <ChevronDown className={cx("size-3.5 text-faint transition-transform shrink-0", open && "rotate-180")} />}
      </button>
      {open && (
        <div className="px-3 pb-2.5 space-y-2 fade-in">
          {t.args && <pre className="font-mono text-[11px] text-muted bg-[var(--code-bg)] rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(t.args, null, 2)}</pre>}
          {t.preview && <pre className="font-mono text-[11px] text-muted bg-[var(--code-bg)] rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">{t.preview}</pre>}
        </div>
      )}
    </div>
  );
}

function ToolsPanel({ tools }: { tools: { name: string; description: string; source: "mcp" | "local" }[] | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-4 h-11 text-xs text-muted hover:text-fg cursor-pointer">
        <Plug className="size-3.5 text-teal" />Agent tools {tools && <span className="num text-faint">({tools.length})</span>}
        <ChevronDown className={cx("size-4 ml-auto transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="max-h-64 overflow-y-auto px-3 pb-3 space-y-1.5 fade-in">
          {!tools && <li className="text-xs text-faint px-1">Loading…</li>}
          {tools?.map((t) => (
            <li key={t.name} className="rounded-lg border border-line bg-hi/40 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-medium truncate flex-1">{t.name}</span>
                <Badge tone={t.source === "mcp" ? "teal" : "muted"}>{t.source.toUpperCase()}</Badge>
              </div>
              <div className="text-[11px] text-faint mt-1 leading-snug line-clamp-3">{t.description}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
