// Imaging: study timeline, report and impression, structured findings, TCD velocity, AI second look, image viewer, upload.
import { useEffect, useState } from "react";
import { Bot, ExternalLink, FileText, ImageOff, Loader2, Maximize2, RefreshCw, ScanEye, ShieldAlert, Trash2, Upload, X } from "lucide-react";
import { fullDate, todayIso, useAsync, when } from "../lib/util";
import { useToast } from "../lib/toast";
import { Badge, Button, Empty, ErrorNote, Field, Input, Modal, Panel, Select, Skeleton, Textarea, Toggle, cx } from "../components/ui";
import { fileObjectUrl, records } from "./api";
import type { Imaging, Modality } from "./types";
import { MODALITIES, MODALITY_ORDER } from "./meta";
import { DropZone, FindingChip, SeverityIcon, sortFindings } from "./ui";

const AI_LABEL = "AI second look, not a radiology report; the radiologist's report is authoritative.";

function worst(st: Imaging) {
  const fs = st.findings.filter((f) => f.code !== "normal");
  return fs.length ? sortFindings(fs)[0].severity : null;
}

export function ImagingTab({ patientId, onChanged }: { patientId: string; onChanged?: () => void }) {
  const toast = useToast();
  const studies = useAsync(() => records.imaging(patientId), [patientId]);
  const [sel, setSel] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const list = studies.data ?? [];
  const current = list.find((s) => s.id === sel) ?? list[0] ?? null;

  function replace(st: Imaging) { studies.setData((xs) => (xs ?? []).map((x) => (x.id === st.id ? st : x))); }
  async function remove(st: Imaging) {
    if (!confirm(`Delete the ${MODALITIES[st.modality]?.label ?? st.modality} of ${fullDate(st.study_date)}${st.file_url ? " and its file" : ""}?`)) return;
    try {
      await records.deleteImaging(st.id);
      studies.setData((xs) => (xs ?? []).filter((x) => x.id !== st.id)); setSel(null); onChanged?.(); toast.ok("Study deleted");
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted">{studies.data ? `${list.length} stud${list.length === 1 ? "y" : "ies"}` : "Loading…"}</div>
        <Button size="sm" variant="teal" onClick={() => setUpload(true)}><Upload className="size-3.5" />Add study</Button>
      </div>
      {studies.error && <ErrorNote>{studies.error}</ErrorNote>}

      {studies.loading && !studies.data ? (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]"><Skeleton className="h-96 rounded-2xl" /><Skeleton className="h-96 rounded-2xl" /></div>
      ) : !list.length ? (
        <Panel>
          <Empty icon={<ScanEye className="size-5" />} title="No imaging yet">
            Add x-ray, MRI, CT, ultrasound or transcranial Doppler studies with the radiologist's report; findings are extracted automatically.
          </Empty>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] items-start">
          <Panel title="Studies" icon={<ScanEye className="size-4 text-teal" />} className="lg:sticky lg:top-4">
            <ol className="relative p-3 max-h-[70vh] overflow-y-auto">
              <span className="absolute left-[29px] top-6 bottom-6 w-px bg-line" />
              {list.map((st) => {
                const m = MODALITIES[st.modality] ?? MODALITIES.xray;
                const I = m.icon;
                const w = worst(st);
                const on = current?.id === st.id;
                return (
                  <li key={st.id}>
                    <button type="button" onClick={() => setSel(st.id)}
                      className={cx("relative w-full flex items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition cursor-pointer",
                        on ? "bg-hi border border-linehi" : "border border-transparent hover:bg-hi/50")}>
                      <span className={cx("relative z-[1] grid place-items-center size-8 rounded-lg border shrink-0 bg-solid",
                        on ? "border-teal/50 text-teal" : "border-line text-muted")}>
                        <I className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">{m.label}{st.body_part ? ` · ${st.body_part}` : ""}</span>
                          {w && <SeverityIcon s={w} />}
                        </div>
                        <div className="text-[11px] text-faint">{fullDate(st.study_date)}</div>
                        {st.impression && <div className="text-xs text-muted line-clamp-2 mt-0.5">{st.impression}</div>}
                        <div className="flex gap-1 mt-1">
                          {st.file_url && <Badge tone="muted">{st.content_type === "application/pdf" ? "PDF" : "image"}</Badge>}
                          {st.ai_summary && <Badge tone="info">AI look</Badge>}
                          {st.tcd_velocity != null && <Badge tone={st.tcd_velocity >= 200 ? "bad" : st.tcd_velocity >= 170 ? "warn" : "ok"}>{st.tcd_velocity} cm/s</Badge>}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          </Panel>
          {current && <StudyDetail key={current.id} st={current} onChange={replace} onDelete={() => remove(current)} />}
        </div>
      )}

      <Modal open={upload} onClose={() => setUpload(false)} title="Add imaging study" wide>
        {upload && <UploadStudy patientId={patientId} onCancel={() => setUpload(false)}
          onSaved={(st) => { studies.setData((xs) => [st, ...(xs ?? [])].sort((a, b) => b.study_date.localeCompare(a.study_date))); setSel(st.id); setUpload(false); onChanged?.(); toast.ok("Study added"); }} />}
      </Modal>
    </div>
  );
}

function StudyDetail({ st, onChange, onDelete }: { st: Imaging; onChange: (s: Imaging) => void; onDelete: () => void }) {
  const toast = useToast();
  const m = MODALITIES[st.modality] ?? MODALITIES.xray;
  const I = m.icon;
  const [redo, setRedo] = useState(false);
  const findings = sortFindings(st.findings);
  const isImage = !!st.file_url && !!st.content_type?.startsWith("image/");
  async function again() {
    setRedo(true);
    try { onChange(await records.secondLook(st.id)); toast.ok("AI second look updated"); }
    catch (e) { toast.error((e as Error).message); } finally { setRedo(false); }
  }
  return (
    <div className="space-y-4 min-w-0">
      <Panel title={<>{m.label}{st.body_part ? ` · ${st.body_part}` : ""}</>} icon={<I className="size-4 text-teal" />}
        sub={<>{fullDate(st.study_date)} · source {st.source} · added {when(st.created_at)}</>}
        actions={<Button size="sm" variant="ghost" onClick={onDelete} className="hover:!text-bad"><Trash2 className="size-3.5" />Delete</Button>}>
        <div className="p-5 space-y-5">
          {st.indication && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Indication</div>
              <p className="text-sm text-muted">{st.indication}</p>
            </div>
          )}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-2">Findings from the report</div>
            {findings.length ? (
              <div className="flex flex-wrap gap-1.5">{findings.map((f, i) => <FindingChip key={i} f={f} />)}</div>
            ) : <p className="text-sm text-faint">No structured findings (no report text).</p>}
          </div>
          {st.tcd_velocity != null && <TcdBar v={st.tcd_velocity} />}
          {st.impression && (
            <div className="rounded-xl border border-line bg-hi/40 p-4">
              <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Impression</div>
              <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap">{st.impression}</p>
            </div>
          )}
          {st.report && (
            <div>
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-faint mb-1"><FileText className="size-3.5" />Radiologist's report</div>
              <p className="text-sm text-muted leading-relaxed whitespace-pre-wrap">{st.report}</p>
            </div>
          )}
        </div>
      </Panel>

      {st.file_url && <FileViewer st={st} />}

      {(st.ai_summary || st.ai_findings.length > 0 || isImage) && (
        <Panel title="AI second look" icon={<Bot className="size-4 text-info" />}
          actions={isImage ? <Button size="sm" variant="ghost" onClick={again} loading={redo}>{!redo && <RefreshCw className="size-3.5" />}{st.ai_summary ? "Run again" : "Run"}</Button> : undefined}>
          <div className="p-5 space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-info/30 bg-info/[0.07] px-3 py-2 text-xs text-fg/90">
              <ShieldAlert className="size-4 text-info shrink-0 mt-px" />
              <span><b>{st.ai_label || AI_LABEL}</b> It may be wrong and is not a diagnosis.</span>
            </div>
            {st.ai_summary ? (
              <>
                <p className="text-sm leading-relaxed text-muted">{st.ai_summary}</p>
                {st.ai_findings.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-faint mb-1.5">Possible findings for the radiologist to confirm</div>
                    <div className="flex flex-wrap gap-1.5">{sortFindings(st.ai_findings).map((f, i) => <FindingChip key={i} f={f} dim />)}</div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-faint">No AI second look yet{isImage ? " (needs an OpenAI key)." : "."}</p>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

function TcdBar({ v }: { v: number }) {
  const max = 260;
  const pos = (x: number) => `${(Math.min(max, Math.max(0, x)) / max) * 100}%`;
  const tone = v >= 200 ? "var(--bad)" : v >= 170 ? "var(--warn)" : "var(--ok)";
  const label = v >= 200 ? "Abnormal" : v >= 170 ? "Conditional" : "Normal";
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-faint">TCD velocity (TAMMV) · STOP thresholds</div>
        <div className="num text-sm"><b style={{ color: tone }}>{v} cm/s</b> <span className="text-faint">· {label}</span></div>
      </div>
      <div className="relative h-3 rounded-full overflow-hidden flex">
        <div style={{ width: pos(170), background: "color-mix(in srgb, var(--ok) 30%, transparent)" }} />
        <div style={{ width: `calc(${pos(200)} - ${pos(170)})`, background: "color-mix(in srgb, var(--warn) 35%, transparent)" }} />
        <div className="flex-1" style={{ background: "color-mix(in srgb, var(--bad) 35%, transparent)" }} />
      </div>
      <div className="relative h-4">
        <div className="absolute -top-[18px] size-4 rounded-full border-2 border-[var(--panel-solid)] shadow" style={{ left: `calc(${pos(v)} - 8px)`, background: tone }} />
        {[0, 170, 200].map((t) => <span key={t} className="absolute text-[10px] text-faint num top-0.5" style={{ left: pos(t), transform: t ? "translateX(-50%)" : undefined }}>{t}</span>)}
      </div>
    </div>
  );
}

function FileViewer({ st }: { st: Imaging }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const isPdf = st.content_type === "application/pdf";
  useEffect(() => {
    let alive = true, made: string | null = null;
    setUrl(null); setErr(null);
    fileObjectUrl(st.file_url!).then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); })
      .catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [st.file_url]);
  return (
    <Panel title={isPdf ? "Report document" : "Image"} icon={<ScanEye className="size-4 text-teal" />}
      sub={st.file_name || undefined}
      actions={url ? (
        <div className="flex gap-1">
          {!isPdf && <Button size="sm" variant="ghost" onClick={() => setZoom(true)}><Maximize2 className="size-3.5" />Full screen</Button>}
          <a href={url} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink className="size-3.5" />Open</Button></a>
        </div>
      ) : undefined}>
      <div className="p-4">
        {err ? (
          <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted"><ImageOff className="size-6 text-faint" />{err}</div>
        ) : !url ? (
          <div className="grid place-items-center h-72 rounded-xl bg-black/30"><Loader2 className="size-6 animate-spin text-teal" /></div>
        ) : isPdf ? (
          <iframe src={url} title={st.file_name || "Report"} className="w-full h-[560px] rounded-xl border border-line bg-white" />
        ) : (
          <button type="button" onClick={() => setZoom(true)} className="block w-full rounded-xl bg-black overflow-hidden cursor-zoom-in">
            <img src={url} alt={`${MODALITIES[st.modality]?.label ?? st.modality} ${st.body_part}`} className="mx-auto max-h-[520px] object-contain" />
          </button>
        )}
      </div>
      {zoom && url && (
        <div className="fixed inset-0 z-[70] bg-black/95 flex items-center justify-center p-4 fade-in" onClick={() => setZoom(false)}>
          <button type="button" className="absolute top-4 right-4 text-white/80 hover:text-white cursor-pointer" aria-label="Close"><X className="size-6" /></button>
          <img src={url} alt="" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </Panel>
  );
}

function UploadStudy({ patientId, onSaved, onCancel }: { patientId: string; onSaved: (s: Imaging) => void; onCancel: () => void }) {
  const [modality, setModality] = useState<Modality>("xray");
  const [date, setDate] = useState(todayIso());
  const [bodyPart, setBodyPart] = useState("chest");
  const [indication, setIndication] = useState("");
  const [report, setReport] = useState("");
  const [impression, setImpression] = useState("");
  const [velocity, setVelocity] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [look, setLook] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isImage = !!file && /\.(png|jpe?g)$/i.test(file.name);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (velocity && (isNaN(Number(velocity)) || Number(velocity) <= 0 || Number(velocity) >= 400)) { setErr("TCD velocity must be between 0 and 400 cm/s."); return; }
    const f = new FormData();
    f.append("modality", modality); f.append("study_date", date); f.append("body_part", bodyPart.trim());
    f.append("indication", indication.trim()); f.append("report", report.trim()); f.append("impression", impression.trim());
    if (velocity.trim()) f.append("tcd_velocity", velocity.trim());
    f.append("second_look", String(look));
    if (file) f.append("file", file);
    setBusy(true); setErr(null);
    try { onSaved(await records.addImaging(patientId, f)); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Modality">
          <Select value={modality} onChange={(e) => { const m = e.target.value as Modality; setModality(m); if (m === "tcd") setBodyPart("brain"); }}>
            {MODALITY_ORDER.map((m) => <option key={m} value={m}>{MODALITIES[m].label}</option>)}
          </Select>
        </Field>
        <Field label="Study date"><Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Body part"><Input value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} placeholder="chest, hip, brain…" maxLength={60} /></Field>
      </div>
      <Field label="Indication"><Input value={indication} onChange={(e) => setIndication(e.target.value)} placeholder="e.g. fever and chest pain" maxLength={2000} /></Field>
      <Field label="Report" hint="findings are extracted from this text">
        <Textarea rows={4} value={report} onChange={(e) => setReport(e.target.value)} placeholder="Paste the radiologist's report" maxLength={20000} />
      </Field>
      <Field label="Impression"><Textarea rows={2} value={impression} onChange={(e) => setImpression(e.target.value)} maxLength={4000} /></Field>
      {modality === "tcd" && (
        <Field label="TCD velocity (TAMMV, cm/s)" hint="STOP: 170–199 conditional · ≥ 200 abnormal">
          <Input inputMode="decimal" value={velocity} onChange={(e) => setVelocity(e.target.value)} placeholder="e.g. 165" />
        </Field>
      )}
      <div>
        <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-1.5">Image or document (optional)</div>
        <DropZone accept=".jpg,.jpeg,.png,.pdf" maxMb={15} file={file} onFile={(f, e) => { setFile(f); setErr(e ?? null); }}
          hint="JPEG, PNG (export DICOM as PNG) or PDF · up to 15 MB" />
      </div>
      {isImage && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-line bg-hi/30 px-3 py-2.5">
          <div className="text-sm">
            <div className="font-medium flex items-center gap-1.5"><Bot className="size-4 text-info" />AI second look</div>
            <div className="text-[11px] text-faint mt-0.5">{AI_LABEL}</div>
          </div>
          <Toggle checked={look} onChange={setLook} label="AI second look" />
        </div>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="flex items-center justify-end gap-2">
        {busy && <span className="text-xs text-muted mr-auto shimmer">{isImage && look ? "Extracting findings and taking an AI second look…" : "Extracting findings…"}</span>}
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="teal" loading={busy}>{!busy && <Upload className="size-4" />}Save study</Button>
      </div>
    </form>
  );
}
