// Labs: latest value per test with flags and trend, full table, add a result, import CSV / FHIR.
import { useMemo, useState } from "react";
import { FileJson, FileSpreadsheet, FlaskConical, Plus, Trash2, Upload } from "lucide-react";
import { fullDate, todayIso, useAsync, when } from "../lib/util";
import { useToast } from "../lib/toast";
import { Badge, Button, Empty, ErrorNote, Field, Input, Modal, Panel, Select, Skeleton, SkeletonRows, cx } from "../components/ui";
import { records } from "./api";
import type { ImportResult, Lab, LabInfo } from "./types";
import { LAB_ORDER } from "./meta";
import { Sparkline } from "./charts";
import { DropZone, LabFlagBadge } from "./ui";

const fmtV = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : v >= 10 ? 1 : 2 });
const range = (l: { ref_low: number | null; ref_high: number | null }) =>
  l.ref_low != null && l.ref_high != null ? `${fmtV(l.ref_low)}–${fmtV(l.ref_high)}` : l.ref_high != null ? `≤ ${fmtV(l.ref_high)}` : l.ref_low != null ? `≥ ${fmtV(l.ref_low)}` : "—";

export function LabsTab({ patientId, hbBaseline, onChanged }: { patientId: string; hbBaseline?: number; onChanged?: () => void }) {
  const toast = useToast();
  const labs = useAsync(() => records.labs(patientId, 3650), [patientId]);
  const catalogue = useAsync(() => records.catalogue().then((c) => c.labs).catch(() => [] as LabInfo[]), []);
  const [modal, setModal] = useState<"add" | "import" | null>(null);
  const [filter, setFilter] = useState<string>("");

  const byCode = useMemo(() => {
    const m = new Map<string, Lab[]>();
    for (const l of labs.data ?? []) { if (!m.has(l.code)) m.set(l.code, []); m.get(l.code)!.push(l); }
    return m;
  }, [labs.data]);
  const codes = useMemo(() => [...byCode.keys()].sort((a, b) => (LAB_ORDER.indexOf(a) + 99 * +(LAB_ORDER.indexOf(a) < 0)) - (LAB_ORDER.indexOf(b) + 99 * +(LAB_ORDER.indexOf(b) < 0))), [byCode]);
  const rows = (labs.data ?? []).filter((l) => !filter || l.code === filter);
  const flagged = codes.filter((c) => byCode.get(c)![0].flag).length;

  async function remove(l: Lab) {
    if (!confirm(`Delete ${l.name} ${fmtV(l.value)} ${l.unit} from ${fullDate(l.taken_at)}?`)) return;
    try { await records.deleteLab(l.id); labs.setData((xs) => (xs ?? []).filter((x) => x.id !== l.id)); onChanged?.(); toast.ok("Lab result deleted"); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {labs.data ? <>{labs.data.length} results · {codes.length} tests{flagged ? <> · <span className="text-warn">{flagged} outside reference range</span></> : null}</> : "Loading…"}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setModal("import")}><Upload className="size-3.5" />Import CSV / FHIR</Button>
          <Button size="sm" variant="teal" onClick={() => setModal("add")}><Plus className="size-3.5" />Add result</Button>
        </div>
      </div>
      {labs.error && <ErrorNote>{labs.error}</ErrorNote>}

      {labs.loading && !labs.data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div>
      ) : codes.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {codes.map((c) => {
            const xs = byCode.get(c)!;
            const l = xs[0], prev = xs[1];
            const diff = prev ? l.value - prev.value : null;
            const baseline = c === "hb" ? hbBaseline : undefined;
            const color = l.flag === "low" ? "var(--info)" : l.flag === "high" ? "var(--warn)" : "var(--teal)";
            const hbDrop = c === "hb" && baseline != null && l.value <= baseline - 2;
            return (
              <button key={c} type="button" onClick={() => setFilter(filter === c ? "" : c)}
                className={cx("glass rounded-2xl p-4 text-left transition cursor-pointer min-w-0 hover:border-linehi",
                  filter === c && "border-teal/50 ring-2 ring-teal/15", hbDrop && "border-bad/45")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wider text-faint font-mono">{c}</div>
                    <div className="text-sm font-medium truncate" title={l.name}>{l.name}</div>
                  </div>
                  <LabFlagBadge flag={l.flag} />
                </div>
                <div className="flex items-baseline gap-1.5 mt-2">
                  <span className="num text-2xl font-semibold tracking-tight" style={{ color: l.flag ? color : undefined }}>{fmtV(l.value)}</span>
                  <span className="text-xs text-faint">{l.unit}</span>
                  {diff != null && Math.abs(diff) > 0 && (
                    <span className="num text-[11px] text-faint ml-auto">{diff > 0 ? "▲" : "▼"} {fmtV(Math.abs(diff))}</span>
                  )}
                </div>
                <div className="mt-2"><Sparkline points={[...xs].reverse().map((x) => ({ t: x.taken_at, v: x.value, flag: x.flag }))} color={color}
                  refLow={l.ref_low} refHigh={l.ref_high} baseline={baseline} height={40} /></div>
                <div className="flex justify-between gap-2 text-[11px] text-faint mt-1.5">
                  <span className="num">ref {range(l)}</span>
                  <span>{when(l.taken_at)}</span>
                </div>
                {baseline != null && (
                  <div className={cx("text-[11px] mt-1 num", hbDrop ? "text-bad font-medium" : "text-faint")}>
                    {l.value - baseline >= 0 ? "+" : ""}{(l.value - baseline).toFixed(1)} vs baseline {baseline}{hbDrop ? " · fall ≥ 2 g/dL" : ""}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <Panel>
          <Empty icon={<FlaskConical className="size-5" />} title="No lab results yet">
            Add a result by hand or import a CSV export or a FHIR R4 Bundle from the laboratory system.
          </Empty>
        </Panel>
      )}

      {(labs.data?.length ?? 0) > 0 && (
        <Panel title="All results" icon={<FlaskConical className="size-4 text-teal" />}
          sub={filter ? `Showing ${byCode.get(filter)?.[0]?.name ?? filter}` : "Newest first · adult reference ranges; many people with sickle cell disease live outside them, so compare with the patient's own baseline"}
          actions={filter ? <Button size="sm" variant="ghost" onClick={() => setFilter("")}>Show all</Button> : undefined}>
          {labs.loading && !labs.data ? <SkeletonRows /> : (
            <div className="overflow-x-auto max-h-[520px]">
              <table className="w-full text-sm num">
                <thead className="sticky top-0 bg-solid/95 backdrop-blur z-[1]">
                  <tr className="text-left text-[11px] uppercase tracking-wider text-faint border-b border-line">
                    <th className="font-medium px-5 py-2.5">Date</th>
                    <th className="font-medium px-2 py-2.5">Test</th>
                    <th className="font-medium px-2 py-2.5 text-right">Value</th>
                    <th className="font-medium px-2 py-2.5">Reference</th>
                    <th className="font-medium px-2 py-2.5">Flag</th>
                    <th className="font-medium px-2 py-2.5">Source</th>
                    <th className="px-2 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 300).map((l) => (
                    <tr key={l.id} className="border-b border-line/70 last:border-0 hover:bg-hi/40 group">
                      <td className="px-5 py-2 whitespace-nowrap">{fullDate(l.taken_at.slice(0, 10))}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{l.name}</td>
                      <td className={cx("px-2 py-2 text-right font-semibold whitespace-nowrap", l.flag === "low" && "text-info", l.flag === "high" && "text-warn")}>
                        {fmtV(l.value)} <span className="text-faint font-normal text-xs">{l.unit}</span>
                      </td>
                      <td className="px-2 py-2 text-muted whitespace-nowrap">{range(l)}</td>
                      <td className="px-2 py-2"><LabFlagBadge flag={l.flag} /></td>
                      <td className="px-2 py-2"><Badge tone={l.source === "manual" ? "acc" : l.source === "fhir" || l.source === "import" ? "info" : "muted"}>{l.source}</Badge></td>
                      <td className="px-2 py-2 text-right">
                        <button type="button" onClick={() => remove(l)} aria-label="Delete result"
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-faint hover:text-bad transition cursor-pointer"><Trash2 className="size-4" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Modal open={modal === "add"} onClose={() => setModal(null)} title="Add lab result">
        {modal === "add" && <AddLab patientId={patientId} catalogue={catalogue.data ?? []} onCancel={() => setModal(null)}
          onSaved={(l) => { labs.setData((xs) => [l, ...(xs ?? [])].sort((a, b) => b.taken_at.localeCompare(a.taken_at))); setModal(null); onChanged?.(); toast.ok(`${l.name} saved`); }} />}
      </Modal>
      <Modal open={modal === "import"} onClose={() => setModal(null)} title="Import lab results" wide>
        {modal === "import" && <ImportLabs patientId={patientId} catalogue={catalogue.data ?? []} onClose={() => setModal(null)}
          onImported={() => { labs.reload(true); onChanged?.(); }} />}
      </Modal>
    </div>
  );
}

function AddLab({ patientId, catalogue, onSaved, onCancel }: { patientId: string; catalogue: LabInfo[]; onSaved: (l: Lab) => void; onCancel: () => void }) {
  const [code, setCode] = useState("hb");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [date, setDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const info = catalogue.find((c) => c.code === code);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = Number(value);
    if (value.trim() === "" || isNaN(v)) { setErr("Enter a number."); return; }
    setBusy(true); setErr(null);
    try { onSaved(await records.addLab(patientId, { code, value: v, unit: unit.trim() || undefined, taken_at: date })); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Test">
        <Select value={code} onChange={(e) => { setCode(e.target.value); setUnit(""); }}>
          {(catalogue.length ? catalogue : LAB_ORDER.map((c) => ({ code: c, name: c.toUpperCase() } as LabInfo))).map((c) => (
            <option key={c.code} value={c.code}>{c.name}{c.unit ? ` (${c.unit})` : ""}</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Value" hint={info ? `ref ${range(info)} ${info.unit}` : undefined}>
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.0" autoFocus required />
        </Field>
        <Field label="Unit" hint="blank = catalogue unit">
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={info?.unit ?? ""} maxLength={20} />
        </Field>
      </div>
      <Field label="Date taken"><Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} required /></Field>
      {info?.note && <p className="text-[11px] text-faint">{info.note}</p>}
      <p className="text-[11px] text-faint">Other units are converted (e.g. Hb in g/L, bilirubin or creatinine in mg/dL, CRP in mg/dL).</p>
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="teal" loading={busy}>Save result</Button>
      </div>
    </form>
  );
}

const CSV_EXAMPLE = `taken_at,code,value,unit
2026-11-02,hb,7.8,g/dL
2026-11-02,retic,9.5,%
2026-11-02,ldh,520,U/L
2026-11-02,2160-0,0.7,mg/dL`;

function ImportLabs({ patientId, catalogue, onImported, onClose }: { patientId: string; catalogue: LabInfo[]; onImported: () => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [showLoinc, setShowLoinc] = useState(false);
  async function run() {
    if (!file) return;
    setBusy(true); setErr(null); setRes(null);
    try { const r = await records.importLabs(patientId, file); setRes(r); if (r.imported) onImported(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-hi/30 p-3">
          <div className="flex items-center gap-2 text-sm font-medium"><FileSpreadsheet className="size-4 text-teal" />CSV</div>
          <p className="text-[11px] text-faint mt-1">Columns <code className="font-mono">taken_at,code,value[,unit]</code>. Code: ours (hb, wbc, …), a name or a LOINC code.</p>
          <pre className="mt-2 rounded-lg bg-[var(--code-bg)] border border-line p-2 font-mono text-[10.5px] leading-relaxed overflow-x-auto">{CSV_EXAMPLE}</pre>
        </div>
        <div className="rounded-xl border border-line bg-hi/30 p-3">
          <div className="flex items-center gap-2 text-sm font-medium"><FileJson className="size-4 text-info" />FHIR R4 Bundle</div>
          <p className="text-[11px] text-faint mt-1">
            Observations with LOINC codes and <code className="font-mono">valueQuantity</code>; date from <code className="font-mono">effectiveDateTime</code>.
            Other observations (vital signs, unknown tests) and entered-in-error results are skipped.
          </p>
          <button type="button" onClick={() => setShowLoinc((s) => !s)} className="text-[11px] text-teal underline underline-offset-2 mt-2 cursor-pointer">
            {showLoinc ? "Hide" : "Show"} LOINC codes
          </button>
          {showLoinc && (
            <div className="mt-2 max-h-36 overflow-y-auto text-[10.5px] space-y-0.5">
              {catalogue.map((c) => <div key={c.code}><span className="font-mono text-muted">{c.code}</span> · {c.loinc.join(", ")}</div>)}
            </div>
          )}
        </div>
      </div>
      <DropZone accept=".csv,.json,.txt" maxMb={5} file={file} onFile={(f, e) => { setFile(f); setErr(e ?? null); setRes(null); }} hint="CSV or JSON, up to 5 MB" />
      {err && <ErrorNote>{err}</ErrorNote>}
      {res && (
        <div className="rounded-xl border border-line p-3 fade-in">
          <div className="flex flex-wrap gap-2">
            <Badge tone="ok">{res.imported} imported</Badge>
            <Badge tone="muted">{res.skipped} skipped</Badge>
            {res.errors.length > 0 && <Badge tone="bad">{res.errors.length} errors</Badge>}
          </div>
          {res.errors.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-bad space-y-0.5 font-mono">
              {res.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          {res.skipped > 0 && <p className="text-[11px] text-faint mt-2">Skipped: duplicates already in the record, or observations that are not one of SickleGuard's lab tests.</p>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{res ? "Close" : "Cancel"}</Button>
        <Button variant="teal" onClick={run} loading={busy} disabled={!file}><Upload className="size-4" />Import</Button>
      </div>
    </div>
  );
}
