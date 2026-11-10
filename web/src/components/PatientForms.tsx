// New check-in and record-crisis forms (shown in modals on the patient page).
import { useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, FlaskConical } from "lucide-react";
import type { Assessment, CheckIn, CheckInInput, Crisis, Severity, Sex } from "../types";
import { api } from "../lib/api";
import { todayIso } from "../lib/util";
import { useToast } from "../lib/toast";
import { Button, ErrorNote, Field, Input, Seg, Textarea, Toggle, cx } from "./ui";

function Slider({ label, value, onChange, lowGood }: { label: string; value: number; onChange: (v: number) => void; lowGood?: boolean }) {
  const c = lowGood ? (value >= 7 ? "var(--lv-crit)" : value >= 4 ? "var(--lv-mod)" : "var(--teal)") : "var(--teal)";
  return (
    <div className="rounded-xl border border-line bg-solid/40 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium text-muted uppercase tracking-wider">{label}</span>
        <span className="num text-xl font-semibold" style={{ color: c }}>{value}<span className="text-xs text-faint font-normal">/10</span></span>
      </div>
      <input type="range" min={0} max={10} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ accentColor: c }} />
      <div className="flex justify-between text-[10px] text-faint mt-0.5"><span>none</span><span>worst</span></div>
    </div>
  );
}

function Flag({ label, hint, checked, onChange, danger }: { label: ReactNode; hint?: string; checked: boolean; onChange: (v: boolean) => void; danger?: boolean }) {
  return (
    <label className={cx("flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition",
      checked ? (danger ? "border-bad/50 bg-bad/10" : "border-teal/40 bg-teal/[0.07]") : "border-line bg-solid/30 hover:border-linehi")}>
      <div className="min-w-0">
        <div className={cx("text-sm", danger && checked && "text-bad font-medium")}>{label}</div>
        {hint && <div className="text-[11px] text-faint">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={typeof label === "string" ? label : undefined} />
    </label>
  );
}

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

export function CheckInForm({ patientId, sex, onHydroxyurea, onSaved, onCancel }:
  { patientId: string; sex: Sex; onHydroxyurea: boolean; onSaved: (r: { checkin: CheckIn; assessment: Assessment }) => void; onCancel: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [pain, setPain] = useState(2);
  const [stress, setStress] = useState(3);
  const [n, setN] = useState({ hydration_litres: "2.0", sleep_hours: "7", temperature_c: "36.8", spo2: "97", hb: "", wbc: "", retic_percent: "", ldh: "" });
  const [b, setB] = useState({
    cold_exposure: false, infection_symptoms: false, chest_symptoms: false, neuro_symptoms: false,
    menstruating: false, alcohol: false, strenuous_activity: false, hydroxyurea_taken: onHydroxyurea,
  });
  const [notes, setNotes] = useState("");
  const [labs, setLabs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setNum = (k: keyof typeof n, v: string) => setN((x) => ({ ...x, [k]: v }));
  const setBool = (k: keyof typeof b) => (v: boolean) => setB((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const body: CheckInInput = {
      date, pain, stress,
      hydration_litres: Number(n.hydration_litres), sleep_hours: Number(n.sleep_hours), temperature_c: Number(n.temperature_c),
      spo2: numOrNull(n.spo2),
      cold_exposure: b.cold_exposure, infection_symptoms: b.infection_symptoms, chest_symptoms: b.chest_symptoms,
      neuro_symptoms: b.neuro_symptoms, menstruating: sex === "F" ? b.menstruating : null, alcohol: b.alcohol,
      strenuous_activity: b.strenuous_activity, hydroxyurea_taken: onHydroxyurea ? b.hydroxyurea_taken : null,
      hb: labs ? numOrNull(n.hb) : null, wbc: labs ? numOrNull(n.wbc) : null,
      retic_percent: labs ? numOrNull(n.retic_percent) : null, ldh: labs ? numOrNull(n.ldh) : null,
      notes: notes.trim(),
    };
    try {
      const r = await api.addCheckin(patientId, body);
      toast.ok(`Check-in saved · risk ${Math.round(r.assessment.score)} (${r.assessment.level})`);
      onSaved(r);
    } catch (ex) { setErr((ex as Error).message); }
    finally { setBusy(false); }
  }

  const temp = Number(n.temperature_c);
  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid sm:grid-cols-[1fr_2fr] gap-4 items-end">
        <Field label="Date" hint="same date replaces"><Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="text-xs text-faint sm:pb-3">One check-in per day. The model re-scores the 7-day risk as soon as you save.</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Slider label="Pain" value={pain} onChange={setPain} lowGood />
        <Slider label="Stress" value={stress} onChange={setStress} lowGood />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Fluids" hint="litres"><Input type="number" step="0.1" min="0" max="10" required value={n.hydration_litres} onChange={(e) => setNum("hydration_litres", e.target.value)} /></Field>
        <Field label="Sleep" hint="hours"><Input type="number" step="0.5" min="0" max="24" required value={n.sleep_hours} onChange={(e) => setNum("sleep_hours", e.target.value)} /></Field>
        <Field label="Temp" hint="°C">
          <Input type="number" step="0.1" min="30" max="45" required value={n.temperature_c} onChange={(e) => setNum("temperature_c", e.target.value)}
            className={cx(temp >= 38.5 && "border-bad/60 text-bad")} />
        </Field>
        <Field label="SpO₂" hint="% optional"><Input type="number" min="50" max="100" value={n.spo2} onChange={(e) => setNum("spo2", e.target.value)} /></Field>
      </div>
      {temp >= 38.5 && <ErrorNote>Fever of 38.5 °C or more in sickle cell disease is a red flag: seek emergency care now.</ErrorNote>}

      <div>
        <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-2">Today</div>
        <div className="grid sm:grid-cols-2 gap-2">
          <Flag label="Chest pain / trouble breathing" hint="possible acute chest syndrome" danger checked={b.chest_symptoms} onChange={setBool("chest_symptoms")} />
          <Flag label="Stroke-like symptoms" hint="weakness, speech, vision, severe headache" danger checked={b.neuro_symptoms} onChange={setBool("neuro_symptoms")} />
          <Flag label="Infection symptoms" hint="cough, sore throat, urinary…" checked={b.infection_symptoms} onChange={setBool("infection_symptoms")} />
          <Flag label="Cold exposure" checked={b.cold_exposure} onChange={setBool("cold_exposure")} />
          <Flag label="Strenuous activity" checked={b.strenuous_activity} onChange={setBool("strenuous_activity")} />
          <Flag label="Alcohol" checked={b.alcohol} onChange={setBool("alcohol")} />
          {sex === "F" && <Flag label="Menstruating" checked={b.menstruating} onChange={setBool("menstruating")} />}
          {onHydroxyurea && <Flag label="Hydroxyurea taken today" checked={b.hydroxyurea_taken} onChange={setBool("hydroxyurea_taken")} />}
        </div>
      </div>

      <div className="rounded-xl border border-line">
        <button type="button" onClick={() => setLabs(!labs)} className="w-full flex items-center gap-2 px-4 h-11 text-sm cursor-pointer">
          <FlaskConical className="size-4 text-teal" />Lab results <span className="text-faint text-xs">(optional)</span>
          <ChevronDown className={cx("size-4 ml-auto text-faint transition-transform", labs && "rotate-180")} />
        </button>
        {labs && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 pb-4 fade-in">
            <Field label="Hb" hint="g/dL"><Input type="number" step="0.1" value={n.hb} onChange={(e) => setNum("hb", e.target.value)} /></Field>
            <Field label="WBC" hint="×10⁹/L"><Input type="number" step="0.1" value={n.wbc} onChange={(e) => setNum("wbc", e.target.value)} /></Field>
            <Field label="Retic" hint="%"><Input type="number" step="0.1" value={n.retic_percent} onChange={(e) => setNum("retic_percent", e.target.value)} /></Field>
            <Field label="LDH" hint="U/L"><Input type="number" step="1" value={n.ldh} onChange={(e) => setNum("ldh", e.target.value)} /></Field>
          </div>
        )}
      </div>

      <Field label="Notes" hint="optional"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <ErrorNote>{err}</ErrorNote>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="teal" loading={busy}>Save & score</Button>
      </div>
    </form>
  );
}

export function CrisisForm({ patientId, onSaved, onCancel }: { patientId: string; onSaved: (c: Crisis) => void; onCancel: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [severity, setSeverity] = useState<Severity>("moderate");
  const [hosp, setHosp] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const c = await api.addCrisis(patientId, { date, severity, hospitalised: hosp, notes: notes.trim() || undefined });
      toast.ok("Crisis recorded");
      onSaved(c);
    } catch (ex) { setErr((ex as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs text-muted">Recording what actually happened lets the team check how well the model predicted it.</p>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Date"><Input type="date" required value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></Field>
        <div>
          <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-1.5">Severity</div>
          <Seg<Severity> value={severity} onChange={setSeverity}
            options={[{ value: "mild", label: "Mild" }, { value: "moderate", label: "Moderate" }, { value: "severe", label: "Severe" }]} />
        </div>
      </div>
      <Flag label="Hospitalised" checked={hosp} onChange={setHosp} />
      <Field label="Notes" hint="optional"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <ErrorNote>{err}</ErrorNote>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Record crisis</Button>
      </div>
    </form>
  );
}
