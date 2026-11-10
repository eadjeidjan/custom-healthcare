import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Search, UserPlus, Users } from "lucide-react";
import type { Genotype, PatientCreate, RiskLevel, Sex } from "../types";
import { GENOTYPES, LEVELS } from "../types";
import { api } from "../lib/api";
import { LEVEL_COLOR, LEVEL_LABEL, useAsync } from "../lib/util";
import { useToast } from "../lib/toast";
import { Button, Empty, ErrorNote, Field, Input, Modal, Page, PageHeader, Panel, Select, SkeletonRows, Textarea, Toggle, cx } from "../components/ui";
import PatientTable from "../components/PatientTable";

export default function Patients() {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [level, setLevel] = useState<RiskLevel | "">("");
  const [adding, setAdding] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const { data, error, loading } = useAsync(() => api.patients(dq, level), [dq, level]);

  return (
    <Page>
      <PageHeader title="Patients" sub="Sorted by 7-day crisis risk, highest first."
        actions={<Button variant="primary" onClick={() => setAdding(true)}><UserPlus className="size-4" />Add patient</Button>} />
      <Panel>
        <div className="flex flex-col sm:flex-row gap-3 p-4 border-b border-line">
          <div className="relative flex-1">
            <Search className="size-4 absolute left-3 top-3 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or MRN…" className="pl-9" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setLevel("")}
              className={cx("h-10 px-3 rounded-xl border text-xs font-medium cursor-pointer transition", level === "" ? "bg-hi border-linehi text-fg" : "border-line text-muted hover:text-fg")}>
              All
            </button>
            {LEVELS.map((l) => (
              <button key={l} onClick={() => setLevel(level === l ? "" : l)}
                className={cx("h-10 px-3 rounded-xl border text-xs font-medium cursor-pointer transition inline-flex items-center gap-1.5",
                  level === l ? "bg-hi border-linehi text-fg" : "border-line text-muted hover:text-fg")}>
                <span className="size-2 rounded-full" style={{ background: LEVEL_COLOR[l] }} />{LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="p-4"><ErrorNote>{error}</ErrorNote></div>}
        {loading && !data ? <SkeletonRows rows={8} /> : data && data.length ? <PatientTable rows={data} />
          : <Empty icon={<Users className="size-5" />} title={dq || level ? "No matching patients" : "No patients yet"}>
              {dq || level ? "Try a different search or filter." : "Add your first patient to start monitoring."}
            </Empty>}
      </Panel>
      <AddPatient open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

function AddPatient({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({
    mrn: "", name: "", date_of_birth: "", sex: "F" as Sex, genotype: "HbSS" as Genotype, on_hydroxyurea: false,
    hb_baseline: "8.5", hbf_percent: "", phone: "", care_team: "", notes: "", crises_12m: "0",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const body: PatientCreate = {
      mrn: f.mrn.trim(), name: f.name.trim(), date_of_birth: f.date_of_birth, sex: f.sex, genotype: f.genotype,
      on_hydroxyurea: f.on_hydroxyurea, hb_baseline: Number(f.hb_baseline),
      hbf_percent: f.hbf_percent === "" ? null : Number(f.hbf_percent),
      phone: f.phone.trim() || undefined, care_team: f.care_team.trim() || undefined, notes: f.notes.trim() || undefined,
      crises_12m: Number(f.crises_12m || 0),
    };
    try {
      const p = await api.createPatient(body);
      toast.ok(`${p.name} added`);
      onClose();
      nav(`/patients/${p.id}`);
    } catch (ex) { setErr((ex as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add patient" wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Full name"><Input required value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="MRN"><Input required value={f.mrn} onChange={(e) => set("mrn", e.target.value)} className="font-mono" /></Field>
          <Field label="Date of birth"><Input required type="date" value={f.date_of_birth} onChange={(e) => set("date_of_birth", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sex">
              <Select value={f.sex} onChange={(e) => set("sex", e.target.value as Sex)}><option value="F">Female</option><option value="M">Male</option></Select>
            </Field>
            <Field label="Genotype">
              <Select value={f.genotype} onChange={(e) => set("genotype", e.target.value as Genotype)}>
                {GENOTYPES.map((g) => <option key={g} value={g}>{g}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Baseline Hb" hint="g/dL"><Input required type="number" step="0.1" min="3" max="20" value={f.hb_baseline} onChange={(e) => set("hb_baseline", e.target.value)} /></Field>
          <Field label="HbF" hint="% (optional)"><Input type="number" step="0.1" min="0" max="100" value={f.hbf_percent} onChange={(e) => set("hbf_percent", e.target.value)} /></Field>
          <Field label="Crises in last 12 months"><Input type="number" min="0" max="50" value={f.crises_12m} onChange={(e) => set("crises_12m", e.target.value)} /></Field>
          <div className="flex items-center justify-between rounded-xl border border-line px-3 h-10 self-end">
            <span className="text-sm">On hydroxyurea</span>
            <Toggle checked={f.on_hydroxyurea} onChange={(v) => set("on_hydroxyurea", v)} label="On hydroxyurea" />
          </div>
          <Field label="Phone" hint="optional"><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="Care team" hint="optional"><Input value={f.care_team} onChange={(e) => set("care_team", e.target.value)} placeholder="e.g. Dr Mensah, Nurse Owusu" /></Field>
        </div>
        <Field label="Notes" hint="optional"><Textarea rows={3} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        <ErrorNote>{err}</ErrorNote>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Add patient</Button>
        </div>
      </form>
    </Modal>
  );
}
