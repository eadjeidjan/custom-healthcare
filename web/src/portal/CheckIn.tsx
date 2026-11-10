// Daily check-in: five quick friendly steps (under a minute), then what changed and why.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Minus, PhoneCall, Plus, TrendingDown, TrendingUp } from "lucide-react";
import { cx } from "../components/ui";
import { cToF, fToC, fmtTemp } from "../lib/temp";
import type { CheckIn as CheckInRow } from "../types";
import { portal, type CheckinResult } from "./api";
import { bothUnits, Card, Disclaimer, LEVEL_VAR, LEVEL_WORDS, RiskDial, SectionTitle, usePortal } from "./kit";

const PAIN = [
  { max: 0, face: "😀", word: "No pain" }, { max: 2, face: "🙂", word: "A little" }, { max: 4, face: "😐", word: "Some pain" },
  { max: 6, face: "🙁", word: "Quite bad" }, { max: 8, face: "😣", word: "Very bad" }, { max: 10, face: "😭", word: "Worst ever" },
];
const STRESS = [
  { v: 1, face: "😌", word: "Calm" }, { v: 3, face: "🙂", word: "OK" }, { v: 5, face: "😕", word: "A bit" },
  { v: 7, face: "😟", word: "Stressed" }, { v: 9, face: "😫", word: "Very" },
];
const painOf = (v: number) => PAIN.find((p) => v <= p.max)!;

interface Form {
  pain: number; temp: number | null; spo2: number | null; cups: number; sleep: number; stress: number;
  cold_exposure: boolean; infection_symptoms: boolean; chest_symptoms: boolean; neuro_symptoms: boolean;
  alcohol: boolean; strenuous_activity: boolean; menstruating: boolean; hydroxyurea_taken: boolean | null;
}
const START: Form = {
  pain: 0, temp: null, spo2: null, cups: 8, sleep: 7, stress: 3, cold_exposure: false, infection_symptoms: false,
  chest_symptoms: false, neuro_symptoms: false, alcohol: false, strenuous_activity: false, menstruating: false,
  hydroxyurea_taken: null,
};
const TEMP_UNIT_KEY = "sg_temp_unit";
const STEPS = ["Pain", "Temperature", "Water & sleep", "Stress", "Anything else?"];

export default function CheckIn() {
  const { me, reload } = usePortal();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>(START);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CheckinResult | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  // the patient enters temperature in °C or °F (remembered); it is always stored and sent in °C
  const [tUnit, setTUnit] = useState<"C" | "F">(() => {
    try { return localStorage.getItem(TEMP_UNIT_KEY) === "F" ? "F" : "C"; } catch { return "C"; }
  });
  const chooseUnit = (u: "C" | "F") => { setTUnit(u); try { localStorage.setItem(TEMP_UNIT_KEY, u); } catch { /* ignore */ } };

  // start from today's answers (editing) or yesterday's habits
  useEffect(() => {
    portal.checkins(3).then((rows: CheckInRow[]) => {
      const last = rows[0];
      if (!last) return;
      const isToday = last.date === new Date().toISOString().slice(0, 10);
      setF((x) => ({
        ...x, cups: Math.round(last.hydration_litres * 4), sleep: last.sleep_hours,
        ...(isToday ? {
          pain: last.pain, stress: last.stress, temp: last.temperature_c, spo2: last.spo2,
          cold_exposure: last.cold_exposure, infection_symptoms: last.infection_symptoms, chest_symptoms: last.chest_symptoms,
          neuro_symptoms: last.neuro_symptoms, alcohol: last.alcohol, strenuous_activity: last.strenuous_activity,
          menstruating: !!last.menstruating, hydroxyurea_taken: last.hydroxyurea_taken,
        } : {}),
      }));
    }).catch(() => { /* defaults are fine */ });
  }, []);

  const onHU = !!me?.patient.on_hydroxyurea;
  const hasOximeter = !!me?.devices.some((d) => d.kind === "pulse_oximeter" || d.kind === "wearable");
  const danger = f.chest_symptoms || f.neuro_symptoms || (f.temp ?? 0) >= 38.5 || (f.spo2 !== null && f.spo2 < 92);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await portal.checkin({
        pain: f.pain, hydration_litres: f.cups / 4, sleep_hours: f.sleep, stress: f.stress,
        ...(f.temp !== null ? { temperature_c: Math.round(f.temp * 100) / 100 } : {}), ...(f.spo2 !== null ? { spo2: f.spo2 } : {}),
        cold_exposure: f.cold_exposure, infection_symptoms: f.infection_symptoms, chest_symptoms: f.chest_symptoms,
        neuro_symptoms: f.neuro_symptoms, alcohol: f.alcohol, strenuous_activity: f.strenuous_activity,
        menstruating: me?.patient.sex === "F" ? f.menstruating : null, hydroxyurea_taken: onHU ? f.hydroxyurea_taken : null,
      });
      setResult(r);
      window.scrollTo(0, 0);
      void reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) return <Result r={result} onDone={() => nav("/portal")} />;

  const last = step === STEPS.length - 1;
  return (
    <div className="fade-in">
      <div className="flex items-center gap-3">
        <button onClick={() => (step ? setStep(step - 1) : nav("/portal"))} aria-label="Back" className="pt-tap size-11 -ml-2 grid place-items-center rounded-full hover:bg-hi">
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex-1">
          <p className="text-[13px] text-muted">Daily check-in · step {step + 1} of {STEPS.length}</p>
          <div className="mt-1.5 flex gap-1.5" aria-hidden>
            {STEPS.map((_, i) => <span key={i} className={cx("h-1.5 flex-1 rounded-full transition-colors", i <= step ? "bg-acc" : "bg-hi")} />)}
          </div>
        </div>
      </div>

      <div key={step} className="fade-in mt-6">
        {step === 0 && (
          <Q title="How much pain do you have right now?">
            <div className="text-center">
              <div className="text-[76px] leading-none pt-pop" key={painOf(f.pain).face} aria-hidden>{painOf(f.pain).face}</div>
              <p className="mt-2 text-[22px] font-semibold"><span className="num">{f.pain}</span><span className="text-faint text-base font-normal"> / 10</span> · {painOf(f.pain).word}</p>
            </div>
            <input type="range" min={0} max={10} step={1} value={f.pain} onChange={(e) => set("pain", +e.target.value)} aria-label="Pain from 0 to 10"
              className="pt-range mt-4" style={{ ["--track" as string]: "linear-gradient(90deg, var(--lv-low), var(--lv-mod), var(--lv-high), var(--lv-crit))", ["--thumb" as string]: f.pain >= 7 ? "var(--lv-crit)" : "var(--acc)" }} />
            <div className="flex justify-between text-[12.5px] text-faint"><span>No pain</span><span>Worst ever</span></div>
            {f.pain >= 8 && (
              <Note tone="bad">That's very bad pain. Start your home pain plan now. If it doesn't help, go to hospital or call 112.</Note>
            )}
          </Q>
        )}

        {step === 1 && (
          <Q title="Did you take your temperature today?" sub="Skip it if you don't have a thermometer.">
            <Measured on={f.temp !== null} onToggle={(v) => set("temp", v ? 36.8 : null)} label="I took my temperature" />
            {f.temp !== null && (
              <>
                <div className="mt-5 flex items-center justify-between">
                  <p className="font-medium text-[15.5px]">Temperature</p>
                  <div className="inline-flex rounded-full bg-hi p-1" role="radiogroup" aria-label="Temperature unit">
                    {(["C", "F"] as const).map((u) => (
                      <button key={u} role="radio" aria-checked={tUnit === u} onClick={() => chooseUnit(u)}
                        className={cx("pt-tap h-9 w-14 rounded-full text-[14px] font-semibold transition", tUnit === u ? "bg-solid shadow text-fg" : "text-muted")}>°{u}</button>
                    ))}
                  </div>
                </div>
                {tUnit === "C" ? (
                  <Stepper value={f.temp} step={0.1} min={34} max={42} onChange={(v) => set("temp", Math.round(v * 10) / 10)} unit="°C" digits={1} label="Temperature"
                    hint={`= ${cToF(f.temp).toFixed(1)} °F`} />
                ) : (
                  <Stepper value={Math.round(cToF(f.temp) * 10) / 10} step={0.1} min={93.2} max={107.6} onChange={(v) => set("temp", Math.round(fToC(v) * 100) / 100)} unit="°F" digits={1} label="Temperature"
                    hint={`= ${f.temp.toFixed(1)} °C`} />
                )}
              </>
            )}
            {f.temp !== null && f.temp >= 38.5 && <Note tone="bad"><b>{fmtTemp(f.temp)} is a fever, and a fever is an emergency in sickle cell.</b> Please go to the emergency department or call 112 now.</Note>}
            {f.temp !== null && f.temp >= 37.6 && f.temp < 38.5 && <Note tone="warn">A little warm. Check again in an hour; {fmtTemp(38.5)} or more means go to hospital.</Note>}
            {hasOximeter && (
              <div className="mt-7">
                <p className="font-medium text-[15.5px] mb-2">Did you check your oxygen (SpO2)?</p>
                <Measured on={f.spo2 !== null} onToggle={(v) => set("spo2", v ? 97 : null)} label="I checked my oxygen (SpO2)" />
                {f.spo2 !== null && <Stepper value={f.spo2} step={1} min={70} max={100} onChange={(v) => set("spo2", v)} unit="%" label="Oxygen" />}
                {f.spo2 !== null && f.spo2 < 92 && <Note tone="bad">Oxygen under 92 % needs emergency care. Call 112 or go to hospital now.</Note>}
              </div>
            )}
          </Q>
        )}

        {step === 2 && (
          <Q title="Water and sleep" sub="Since this time yesterday.">
            <p className="font-medium text-[15.5px]">Cups of water or other drinks</p>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-hidden>
              {Array.from({ length: 12 }).map((_, i) => (
                <span key={i} className={cx("h-8 w-6 rounded-b-lg rounded-t-sm border-2 transition-colors", i < f.cups ? "border-info bg-info/25" : "border-line")} />
              ))}
            </div>
            <Stepper value={f.cups} step={1} min={0} max={20} onChange={(v) => set("cups", v)} unit={f.cups === 1 ? "cup" : "cups"} label="Cups" hint={`about ${(f.cups / 4).toFixed(1)} litres`} />
            {f.cups < 8 && <Note tone="warn">Try to drink a bit more today: water helps keep your blood flowing.</Note>}
            <p className="font-medium text-[15.5px] mt-7">Hours of sleep last night</p>
            <Stepper value={f.sleep} step={0.5} min={0} max={16} onChange={(v) => set("sleep", v)} unit="hours" digits={1} label="Sleep" />
          </Q>
        )}

        {step === 3 && (
          <Q title="How stressed or worried do you feel?">
            <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Stress">
              {STRESS.map((s) => {
                const on = Math.abs(f.stress - s.v) <= 1;
                return (
                  <button key={s.v} role="radio" aria-checked={on} onClick={() => set("stress", s.v)}
                    className={cx("pt-tap rounded-2xl py-3 flex flex-col items-center gap-1 border-2 transition", on ? "border-acc bg-acc/10 scale-[1.03]" : "border-line bg-solid")}>
                    <span className="text-[34px] leading-none">{s.face}</span>
                    <span className="text-[12px] font-medium">{s.word}</span>
                  </button>
                );
              })}
            </div>
            {f.stress >= 7 && <Note tone="info">Thanks for telling us. Slow breathing or talking to someone you trust can help. Your care team can offer support too.</Note>}
          </Q>
        )}

        {step === 4 && (
          <Q title="Anything else today?" sub="Tap any that are true.">
            <div className="space-y-2.5">
              <Tog on={f.chest_symptoms} set={(v) => set("chest_symptoms", v)} emoji="🫁" danger label="Chest pain or trouble breathing" />
              <Tog on={f.neuro_symptoms} set={(v) => set("neuro_symptoms", v)} emoji="🧠" danger label="Weak face, arm or leg, trouble speaking, or a sudden bad headache" />
              <Tog on={f.infection_symptoms} set={(v) => set("infection_symptoms", v)} emoji="🤒" label="I feel ill (cough, cold, flu, being sick)" />
              <Tog on={f.cold_exposure} set={(v) => set("cold_exposure", v)} emoji="🥶" label="I got cold (wind, rain, cold water, strong AC)" />
              <Tog on={f.strenuous_activity} set={(v) => set("strenuous_activity", v)} emoji="🏃" label="I did hard exercise or heavy work" />
              <Tog on={f.alcohol} set={(v) => set("alcohol", v)} emoji="🍺" label="I drank alcohol" />
              {me?.patient.sex === "F" && <Tog on={f.menstruating} set={(v) => set("menstruating", v)} emoji="🩸" label="I'm on my period" />}
            </div>
            {onHU && (
              <div className="mt-5">
                <p className="font-medium text-[15.5px]">💊 Did you take your hydroxyurea today?</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {[true, false].map((v) => (
                    <button key={String(v)} onClick={() => set("hydroxyurea_taken", v)} aria-pressed={f.hydroxyurea_taken === v}
                      className={cx("pt-tap h-13 py-3.5 rounded-2xl border-2 font-semibold text-[15.5px] transition",
                        f.hydroxyurea_taken === v ? "border-acc bg-acc/10" : "border-line bg-solid")}>
                      {v ? "Yes" : "Not yet"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Q>
        )}
      </div>

      {danger && (
        <div role="alert" className="mt-5 rounded-2xl p-4 bg-bad/10 border border-bad/40">
          <p className="font-semibold flex items-center gap-2"><AlertTriangle className="size-5 text-bad" />This could be an emergency</p>
          <p className="text-[14.5px] mt-1">Don't wait for your result. Call 112 or go to the nearest emergency department now.</p>
          <a href="tel:112" className="pt-tap mt-3 inline-flex items-center gap-2 h-12 px-5 rounded-full grad-bg text-white font-semibold"><PhoneCall className="size-5" />Call 112</a>
        </div>
      )}

      {err && <p role="alert" className="mt-4 text-bad text-[14.5px]">{err}</p>}

      <div className="mt-7 flex gap-3">
        {step > 0 && (
          <button onClick={() => setStep(step - 1)} className="pt-tap h-14 px-5 rounded-2xl border border-linehi font-semibold text-[16px]">Back</button>
        )}
        <button onClick={() => (last ? submit() : setStep(step + 1))} disabled={busy}
          className="pt-tap flex-1 h-14 rounded-2xl grad-bg text-white font-semibold text-[16.5px] flex items-center justify-center gap-2 active:scale-[0.98] transition disabled:opacity-60">
          {last ? (busy ? "Saving…" : <>See my result <Check className="size-5" /></>) : <>Next <ArrowRight className="size-5" /></>}
        </button>
      </div>
      {step > 0 && step < STEPS.length - 1 && (
        <button onClick={() => setStep(STEPS.length - 1)} className="pt-tap mt-3 w-full h-11 text-[14px] text-muted">Skip to the last step</button>
      )}
    </div>
  );
}

function Q({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section>
      <h1 className="text-[24px] leading-tight font-semibold tracking-tight">{title}</h1>
      {sub && <p className="text-[14.5px] text-muted mt-1">{sub}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Note({ tone, children }: { tone: "bad" | "warn" | "info"; children: ReactNode }) {
  const c = { bad: "bg-bad/10 border-bad/35", warn: "bg-warn/10 border-warn/30", info: "bg-info/10 border-info/25" }[tone];
  return <p role={tone === "bad" ? "alert" : undefined} className={cx("mt-4 rounded-2xl border p-3.5 text-[14.5px] leading-snug", c)}>{children}</p>;
}

function Stepper({ value, step, min, max, onChange, unit, digits = 0, label, hint }:
  { value: number; step: number; min: number; max: number; onChange: (v: number) => void; unit: string; digits?: number; label: string; hint?: string }) {
  const clamp = (v: number) => Math.max(min, Math.min(max, +v.toFixed(2)));
  return (
    <div className="mt-3 flex items-center gap-3">
      <button onClick={() => onChange(clamp(value - step))} aria-label={`Less ${label.toLowerCase()}`} className="pt-tap size-14 rounded-2xl border border-linehi bg-solid grid place-items-center active:scale-95 transition"><Minus className="size-6" /></button>
      <div className="flex-1 text-center" aria-live="polite">
        <div className="text-[30px] font-semibold num leading-none">{value.toFixed(digits)} <span className="text-[15px] font-normal text-muted">{unit}</span></div>
        {hint && <div className="text-[12.5px] text-faint mt-1">{hint}</div>}
      </div>
      <button onClick={() => onChange(clamp(value + step))} aria-label={`More ${label.toLowerCase()}`} className="pt-tap size-14 rounded-2xl border border-linehi bg-solid grid place-items-center active:scale-95 transition"><Plus className="size-6" /></button>
    </div>
  );
}

function Measured({ on, onToggle, label }: { on: boolean; onToggle: (v: boolean) => void; label: string }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button onClick={() => onToggle(true)} aria-pressed={on} className={cx("pt-tap h-13 py-3.5 rounded-2xl border-2 font-semibold text-[15px] transition", on ? "border-acc bg-acc/10" : "border-line bg-solid")}>{label.startsWith("I took") ? "Yes" : "Yes, I checked"}</button>
      <button onClick={() => onToggle(false)} aria-pressed={!on} className={cx("pt-tap h-13 py-3.5 rounded-2xl border-2 font-semibold text-[15px] transition", !on ? "border-acc bg-acc/10" : "border-line bg-solid")}>Not today</button>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function Tog({ on, set, label, emoji, danger }: { on: boolean; set: (v: boolean) => void; label: string; emoji: string; danger?: boolean }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => set(!on)}
      className={cx("pt-tap w-full min-h-16 rounded-2xl border-2 px-4 py-3 flex items-center gap-3 text-left transition",
        on ? (danger ? "border-bad bg-bad/10" : "border-acc bg-acc/10") : "border-line bg-solid")}>
      <span className="text-[26px] leading-none" aria-hidden>{emoji}</span>
      <span className="flex-1 text-[15px] font-medium leading-snug">{label}</span>
      <span className={cx("relative h-7 w-12 shrink-0 rounded-full transition-colors", on ? (danger ? "bg-bad" : "bg-acc") : "bg-hi border border-line")}>
        <span className={cx("absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform", on ? "translate-x-5" : "translate-x-0.5")} />
      </span>
    </button>
  );
}

function Result({ r, onDone }: { r: CheckinResult; onDone: () => void }) {
  const { me } = usePortal();
  const a = r.assessment;
  const words = LEVEL_WORDS[a.level];
  const delta = r.previous ? Math.round(a.score - r.previous.score) : null;
  const ups = a.factors.filter((x) => x.direction === "up").slice(0, 4);
  const downs = a.factors.filter((x) => x.direction === "down").slice(0, 3);
  const askQ = useMemo(() => encodeURIComponent("Can you explain my check-in result today and what I should do?"), []);
  return (
    <div className="fade-in">
      <p className="text-[13px] text-muted flex items-center gap-1.5"><Check className="size-4 text-ok" />Check-in saved{r.streak_days > 1 ? ` · ${r.streak_days}-day streak 🔥` : ""}</p>
      {a.red_flags.length > 0 && (
        <div role="alert" className="mt-4 rounded-[22px] p-4 bg-bad/10 border border-bad/40 flag-pulse">
          <p className="font-semibold text-[17px] flex items-center gap-2"><AlertTriangle className="size-5 text-bad" />Please get help now</p>
          <ul className="mt-1.5 text-[14.5px] list-disc pl-5">{a.red_flags.map((f) => <li key={f.key}>{bothUnits(f.label)}</li>)}</ul>
          <p className="text-[14.5px] mt-2">Call 112 or go to the nearest emergency department. Your care team has been alerted too.</p>
          <a href="tel:112" className="pt-tap mt-3 inline-flex items-center gap-2 h-12 px-5 rounded-full grad-bg text-white font-semibold"><PhoneCall className="size-5" />Call 112</a>
        </div>
      )}
      <Card className="mt-4 p-5 text-center">
        <div className="flex justify-center"><RiskDial score={a.score} level={a.level} size={240} cuts={me?.thresholds} /></div>
        <h1 className="text-[22px] font-semibold leading-snug -mt-3">{words.title}</h1>
        <p className="text-muted text-[14.5px] mt-1">{words.sub}</p>
        {delta !== null && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-hi px-3.5 py-1.5 text-[13.5px] font-medium">
            {delta > 1 ? <TrendingUp className="size-4" style={{ color: LEVEL_VAR.high }} /> : delta < -1 ? <TrendingDown className="size-4 text-ok" /> : null}
            {delta > 1 ? `Up ${delta} points since last time` : delta < -1 ? `Down ${-delta} points since last time` : "About the same as last time"}
          </p>
        )}
      </Card>

      {(ups.length > 0 || downs.length > 0) && (
        <>
          <SectionTitle>Why</SectionTitle>
          <Card className="p-4 space-y-3">
            {ups.map((x) => (
              <div key={x.key} className="flex items-start gap-3">
                <span className="size-8 rounded-full grid place-items-center shrink-0" style={{ background: "color-mix(in srgb, var(--lv-high) 14%, transparent)" }}><TrendingUp className="size-4" style={{ color: LEVEL_VAR.high }} /></span>
                <div className="min-w-0"><p className="font-medium text-[15px]">{x.label}</p><p className="text-[13px] text-muted">{bothUnits(x.value)} · raises your risk</p></div>
              </div>
            ))}
            {downs.map((x) => (
              <div key={x.key} className="flex items-start gap-3">
                <span className="size-8 rounded-full bg-ok/15 grid place-items-center shrink-0"><TrendingDown className="size-4 text-ok" /></span>
                <div className="min-w-0"><p className="font-medium text-[15px]">{x.label}</p><p className="text-[13px] text-muted">{bothUnits(x.value)} · helps lower your risk</p></div>
              </div>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>What to do now</SectionTitle>
      <Card className="divide-y divide-[var(--border)]">
        {r.next_steps.map((s) => (
          <div key={s.action} className="p-4 flex gap-3">
            <span className={cx("size-2.5 rounded-full mt-2 shrink-0", s.urgency === "now" ? "bg-bad" : "bg-teal")} />
            <div><p className="font-medium text-[15.5px] leading-snug">{bothUnits(s.action)}</p><p className="text-[13.5px] text-muted mt-0.5">{bothUnits(s.why)}</p></div>
          </div>
        ))}
      </Card>

      <div className="mt-6 grid gap-3">
        <button onClick={onDone} className="pt-tap h-14 rounded-2xl grad-bg text-white font-semibold text-[16px]">Back to home</button>
        <Link to={`/portal/ask?q=${askQ}`} className="pt-tap h-14 rounded-2xl border border-linehi font-semibold text-[15.5px] grid place-items-center">Ask a question about this</Link>
      </div>
      <Disclaimer className="mt-6" />
    </div>
  );
}
