import { useRef, useState, type FormEvent } from "react";
import { BookOpen, FileText, Search, Trash2, Upload } from "lucide-react";
import type { Doc, Source } from "../types";
import { api } from "../lib/api";
import { useAsync, when } from "../lib/util";
import { useSession } from "../lib/session";
import { useToast } from "../lib/toast";
import { Badge, Button, Empty, ErrorNote, Input, Page, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { ScoreChip } from "../components/clinical";

export default function Knowledge() {
  const { isAdmin } = useSession();
  const toast = useToast();
  const docs = useAsync(() => api.docs(), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Source[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  async function upload(f: File) {
    setUploading(true);
    try {
      const d = await api.uploadDoc(f);
      docs.setData((xs) => [d, ...(xs ?? [])]);
      toast.ok(`${d.title || d.filename} uploaded (${d.status})`);
      setTimeout(() => docs.reload(true), 4000);
    } catch (e) { toast.error((e as Error).message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function remove(d: Doc) {
    if (!confirm(`Delete "${d.title || d.filename}" from the knowledge base?`)) return;
    try { await api.deleteDoc(d.id); docs.setData((xs) => (xs ?? []).filter((x) => x.id !== d.id)); toast.ok("Document deleted"); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true); setSearchErr(null);
    try { setHits(await api.searchKnowledge(q.trim(), 5)); }
    catch (ex) { setSearchErr((ex as Error).message); }
    finally { setSearching(false); }
  }

  return (
    <Page>
      <PageHeader title="Knowledge" sub="Sickle cell guidance the AI retrieves from when it explains risk and drafts plans."
        actions={isAdmin && (
          <>
            <input ref={fileRef} type="file" accept=".md,.txt,.pdf" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button variant="primary" loading={uploading} onClick={() => fileRef.current?.click()}><Upload className="size-4" />Upload guidance</Button>
          </>
        )} />

      <Panel title="This is what the AI reads" icon={<Search className="size-4 text-teal" />} sub="Search the guideline index exactly as the assistant does">
        <form onSubmit={search} className="flex gap-2 p-4">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. fever threshold in sickle cell disease" />
          <Button type="submit" variant="teal" loading={searching}>Search</Button>
        </form>
        {searchErr && <div className="px-4 pb-4"><ErrorNote>{searchErr}</ErrorNote></div>}
        {hits && (
          <div className="px-4 pb-4 space-y-2 fade-in">
            {hits.length === 0 && <div className="text-sm text-muted py-4 text-center">No matching passages.</div>}
            {hits.map((h, i) => (
              <div key={i} className="rounded-xl border border-line bg-hi/40 p-3.5">
                <div className="flex items-center gap-2">
                  <span className="num grid place-items-center size-5 rounded-md bg-teal/15 text-teal text-[10px] font-bold">{i + 1}</span>
                  <span className="text-sm font-medium truncate flex-1">{h.title}</span>
                  <div className="hidden sm:block w-24 h-1.5 rounded-full bg-hi overflow-hidden">
                    <div className="h-full teal-bg bar-grow" style={{ width: `${Math.max(4, Math.min(100, (h.score <= 1 ? h.score : h.score / 100) * 100))}%` }} />
                  </div>
                  <ScoreChip score={h.score} />
                </div>
                <p className="text-sm text-muted mt-2 leading-relaxed whitespace-pre-wrap">{h.snippet}</p>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="mt-4" title="Guidance documents" icon={<BookOpen className="size-4 text-acc" />}
        sub={isAdmin ? "Upload .md, .txt or .pdf files" : "Only admins can upload or delete documents"}>
        {docs.error && <div className="p-4"><ErrorNote>{docs.error}</ErrorNote></div>}
        {docs.loading && !docs.data ? <SkeletonRows rows={4} /> : docs.data?.length ? (
          <ul className="divide-y divide-line">
            {docs.data.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="grid place-items-center size-9 rounded-xl bg-hi border border-line shrink-0"><FileText className="size-4 text-muted" /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{d.title || d.filename}</div>
                  <div className="text-[11px] text-faint truncate">{d.filename} · {when(d.created_at)}</div>
                  {d.error && <div className="text-[11px] text-bad mt-0.5">{d.error}</div>}
                </div>
                <span className="num text-xs text-muted whitespace-nowrap hidden sm:inline">{d.chunks} chunks</span>
                <Badge tone={d.status === "indexed" ? "ok" : d.status === "pending" ? "warn" : "bad"}>
                  {d.status === "pending" && <span className="size-1.5 rounded-full bg-warn pulse-dot" />}{d.status}
                </Badge>
                {isAdmin && (
                  <button onClick={() => remove(d)} title="Delete" className="text-faint hover:text-bad cursor-pointer p-1"><Trash2 className="size-4" /></button>
                )}
              </li>
            ))}
          </ul>
        ) : <Empty icon={<BookOpen className="size-5" />} title="No guidance documents">Upload guidelines so the AI can ground its plans.</Empty>}
      </Panel>
    </Page>
  );
}
