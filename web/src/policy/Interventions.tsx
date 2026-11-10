// Interventions: scenario cards with sliders. The API sends each scenario's inputs and assumptions; the numbers are
// recomputed here (same formula as the API) so moving a slider updates instantly.
import { useMemo, useState, type ReactNode } from "react";
import { BookOpen, Info } from "lucide-react";
import { useAsync } from "../lib/util";
import { Badge, cx, ErrorNote, Skeleton } from "../components/ui";
import { estimate, policy, type Interventions as IV, type Scenario } from "./api";
import { Card, Kpi, PageTitle, ghs, n0, pct, useSettings } from "./shared";

type Base = NonNullable<IV["baseline"]>;

export default function Interventions() {
  const { costBedDay, setCostBedDay, edVisit: edDefault } = useSettings();
  const iv = useAsync(() => policy.interventions(costBedDay), []);   // inputs don't depend on cost; fetched once
  const [edVisit, setEdVisit] = useState(edDefault);
  const [values, setValues] = useState<Record<string, number>>({});
  const [unitCost, setUnitCost] = useState<Record<string, number>>({});
  const b = iv.data?.baseline;
  const scen = iv.data?.scenarios ?? [];
  const results = useMemo(() => !b ? [] : scen.map((s) => {
    const sc = { ...s, model: { ...s.model, programme_cost_per_person_ghs: unitCost[s.key] ?? s.model.programme_cost_per_person_ghs } };
    return { s, r: estimate(sc, values[s.key] ?? s.slider.default, b, costBedDay, edVisit) };
  }), [b, scen, values, unitCost, costBedDay, edVisit]);
  const total = results.reduce((a, { r }) => ({ crises: a.crises + r.crises, adm: a.adm + r.adm, bed: a.bed + r.bed, net: a.net + r.net, saved: a.saved + r.saved }),
    { crises: 0, adm: 0, bed: 0, net: 0, saved: 0 });

  return (
    <>
      <PageTitle eyebrow="What if" title="Intervention scenarios"
        sub="Yearly estimates for the registry population. Every number comes from the assumptions shown on each card; move the sliders to test them. Scenarios overlap, so totals are an upper bound." />
      <ErrorNote>{iv.error}</ErrorNote>
      {iv.data?.suppressed && <div className="text-sm text-faint">Too few patients to model scenarios.</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-4 mb-4">
        <Card eyebrow="Cost assumptions" title="Unit costs (GHS)" sub="Illustrative defaults; no published Ghana cost per VOC bed-day was found. Set your own.">
          <div className="px-5 pb-5 space-y-4">
            <SliderRow label="Cost per bed-day" value={costBedDay} min={100} max={3000} step={50} fmt={(v) => `GHS ${n0(v)}`} onChange={setCostBedDay} />
            <SliderRow label="Cost per crisis treated without admission" value={edVisit} min={0} max={1500} step={25} fmt={(v) => `GHS ${n0(v)}`} onChange={setEdVisit} />
            {b && (
              <div className="grid grid-cols-3 gap-2 text-xs pt-1">
                <Mini k="Crises / year" v={n0(b.crises_per_year)} /><Mini k="Admitted" v={pct(b.admission_rate)} /><Mini k="Avg stay" v={`${b.avg_los} d`} />
              </div>
            )}
          </div>
        </Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 content-start">
          {!b ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[112px] rounded-2xl" />) : (
            <>
              <Kpi label="Crises avoided / yr" value={n0(total.crises)} accent="teal" sub={`${pct(total.crises / (b.crises_per_year || 1))} of crises`} />
              <Kpi label="Admissions avoided / yr" value={n0(total.adm)} accent="teal" />
              <Kpi label="Bed-days saved / yr" value={n0(total.bed)} accent="teal" />
              <Kpi label="Net saving / yr" value={ghs(total.net)} accent={total.net >= 0 ? "teal" : "acc"} sub={`gross ${ghs(total.saved)}`} />
            </>
          )}
          {b && <ImpactBars results={results} />}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
        {!iv.data && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-96 rounded-2xl" />)}
        {b && results.map(({ s, r }) => (
          <ScenarioCard key={s.key} s={s} r={r} b={b} value={values[s.key] ?? s.slider.default}
            onValue={(v) => setValues((x) => ({ ...x, [s.key]: v }))}
            unitCost={unitCost[s.key] ?? s.model.programme_cost_per_person_ghs}
            onUnitCost={(v) => setUnitCost((x) => ({ ...x, [s.key]: v }))} />
        ))}
      </div>
    </>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return <div className="rounded-lg bg-hi/50 px-2.5 py-1.5"><div className="text-[10px] text-faint uppercase tracking-wider">{k}</div><div className="num font-semibold">{v}</div></div>;
}

function SliderRow({ label, value, min, max, step, fmt, onChange }:
  { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between text-xs mb-1.5"><span className="text-muted">{label}</span><span className="num font-semibold text-fg">{fmt(value)}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
    </label>
  );
}

type R = ReturnType<typeof estimate>;

function ImpactBars({ results }: { results: { s: Scenario; r: R }[] }) {
  const max = Math.max(1, ...results.map(({ r }) => r.crises + r.adm));
  return (
    <div className="col-span-2 md:col-span-4 glass rounded-2xl p-4">
      <div className="text-[10.5px] uppercase tracking-[0.18em] text-faint mb-3">Crises and admissions avoided per year</div>
      <div className="space-y-2">
        {results.map(({ s, r }) => (
          <div key={s.key} className="grid grid-cols-[minmax(0,12rem)_1fr_5rem] items-center gap-3 text-xs">
            <span className="truncate text-muted">{s.label}</span>
            <div className="flex h-2.5 gap-[2px]">
              <div className="h-full rounded-l-full bar-grow" style={{ width: `${(r.crises / max) * 100}%`, background: "var(--teal)" }} title={`${r.crises.toFixed(1)} crises`} />
              <div className="h-full rounded-r-full bar-grow" style={{ width: `${(r.adm / max) * 100}%`, background: "color-mix(in oklab, var(--teal) 45%, var(--panel-solid))" }} title={`${r.adm.toFixed(1)} admissions`} />
            </div>
            <span className="num text-right">{r.crises.toFixed(1)} · {r.adm.toFixed(1)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--teal)" }} />Crises</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "color-mix(in oklab, var(--teal) 45%, var(--panel-solid))" }} />Admissions</span>
      </div>
    </div>
  );
}

const EVIDENCE_TONE = { high: "teal", moderate: "warn", low: "muted" } as const;

function ScenarioCard({ s, r, b, value, onValue, unitCost, onUnitCost }:
  { s: Scenario; r: R; b: Base; value: number; onValue: (v: number) => void; unitCost: number; onUnitCost: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const isCov = s.slider.param === "coverage";
  const label = isCov ? `Raise hydroxyurea coverage to ${Math.round(value * 100)} %` : s.label;
  return (
    <section className="glass rounded-2xl flex flex-col min-w-0 overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-line">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold text-[15px] leading-snug">{label}</h3>
          <Badge tone={EVIDENCE_TONE[s.evidence]} title="Strength of evidence for the effect size">{s.evidence} evidence</Badge>
        </div>
        <p className="text-xs text-muted mt-1">{s.description}</p>
      </div>
      <div className="px-5 py-4 space-y-4">
        <label className="block">
          <div className="flex items-baseline justify-between text-xs mb-1.5">
            <span className="text-muted">{s.slider.label}</span>
            <span className="num font-semibold">{Math.round(value * 100)} %{isCov && <span className="text-faint font-normal"> (now {pct(b.hu_coverage)})</span>}</span>
          </div>
          <input type="range" min={s.slider.min} max={s.slider.max} step={0.01} value={value} onChange={(e) => onValue(Number(e.target.value))} aria-label={s.slider.label} />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <Stat k="Crises avoided" v={r.crises.toFixed(1)} />
          <Stat k="Admissions avoided" v={r.adm.toFixed(1)} />
          <Stat k="Bed-days saved" v={r.bed.toFixed(1)} />
        </div>
        <div className="rounded-xl border border-line divide-y divide-line text-xs">
          <Row k="Hospital cost saved" v={ghs(r.saved, false)} />
          <Row k={<span className="flex items-center gap-2">Programme cost
            <span className="inline-flex items-center gap-1 text-faint">(<input value={unitCost} inputMode="numeric" aria-label="Programme cost per person"
              onChange={(e) => onUnitCost(Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
              className="num w-14 rounded bg-hi/70 px-1 text-fg outline-none focus:ring-1 focus:ring-teal/40" /> / person · {n0(r.reached)} people)</span></span>}
            v={`− ${ghs(r.prog, false)}`} />
          <Row k={<span className="font-semibold text-fg">Net saving</span>} v={<span className={cx("font-semibold", r.net >= 0 ? "text-teal" : "text-acc")}>{ghs(r.net, false)}</span>} />
        </div>
      </div>
      <div className="mt-auto px-5 pb-4">
        <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 text-xs text-teal cursor-pointer">
          <BookOpen className="size-3.5" />{open ? "Hide" : "Show"} assumptions & sources
        </button>
        {open && (
          <ul className="mt-3 space-y-2 text-[11.5px] fade-in">
            {s.assumptions.map((a, i) => (
              <li key={i} className="rounded-lg bg-hi/40 px-3 py-2">
                <div className="flex justify-between gap-3"><span className="text-muted">{a.label}</span><span className="num font-medium text-right">{a.value}</span></div>
                {a.source && <div className="text-faint mt-0.5 leading-relaxed">{a.source}</div>}
              </li>
            ))}
            <li className="flex items-start gap-1.5 text-faint"><Info className="size-3.5 mt-0.5 shrink-0" />
              Targets {n0(s.model.target_crises, 1)} crises/yr{s.model.target_admissions ? ` and ${n0(s.model.target_admissions, 1)} admissions/yr` : ""} in {n0(s.model.target_patients)} patients.</li>
          </ul>
        )}
      </div>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl bg-teal/[0.07] border border-teal/20 px-3 py-2">
      <div className="num text-lg font-semibold text-teal leading-none">{v}</div>
      <div className="text-[10px] text-muted mt-1 leading-tight">{k}</div>
    </div>
  );
}
function Row({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 px-3 py-2"><span className="text-muted min-w-0">{k}</span><span className="num whitespace-nowrap">{v}</span></div>;
}
