// Drivers: which factors make up the modelled risk across the population, and which a programme can act on.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useAsync } from "../lib/util";
import { ErrorNote, Skeleton } from "../components/ui";
import { policy } from "./api";
import { DriverBars, Legend } from "./charts";
import { Card, HATCH_CSS, Kpi, PageTitle, n0, pct } from "./shared";

export default function Drivers() {
  const dr = useAsync(() => policy.drivers(), []);
  const d = dr.data;
  const mod = d?.drivers.filter((r) => r.modifiable) ?? [];
  const levers = Object.entries(mod.reduce<Record<string, number>>((a, r) => {
    if (r.lever) a[r.lever] = (a[r.lever] ?? 0) + r.share_of_risk;
    return a;
  }, {})).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageTitle eyebrow="Causes" title="Risk drivers"
        sub="Every current assessment explains its score in points per factor. Adding those points across all patients shows what drives crisis risk in the population and which share programmes could act on." />
      <ErrorNote>{dr.error}</ErrorNote>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        <Kpi label="Patients with a current assessment" value={d ? n0(d.assessed) : "…"} accent="info" sub="last 30 days" />
        <Kpi label="Risk from modifiable factors" value={d ? pct(d.modifiable_share) : "…"} accent="teal" sub="share of all modelled risk points" />
        <Kpi label="Largest lever" value={levers[0]?.[0] ?? "—"} accent="acc" sub={levers[0] ? `${pct(levers[0][1])} of risk` : undefined} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4">
        <Card title="Share of modelled risk by factor"
          actions={<Legend items={[{ color: "var(--acc)", label: "Modifiable" },
            { color: "color-mix(in oklab, var(--muted) 55%, var(--panel-solid))", label: "Not modifiable (pain, genotype, history)" },
            { color: HATCH_CSS, label: "Pooled (<5 patients each)" }]} />}>
          <div className="px-5 pb-5">{d ? (d.drivers.length ? <DriverBars rows={d.drivers} /> : <div className="text-sm text-faint py-8 text-center">No current assessments to summarise.</div>) : <Skeleton className="h-80" />}</div>
        </Card>
        <Card title="Programme levers" sub="Modifiable risk grouped by the programme that addresses it.">
          <div className="px-5 pb-5 space-y-3">
            {levers.map(([k, v]) => (
              <div key={k} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between text-sm"><span className="truncate">{k}</span><span className="num font-semibold">{pct(v, 1)}</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-hi overflow-hidden"><div className="h-full rounded-full bar-grow" style={{ width: `${(v / (levers[0][1] || 1)) * 100}%`, background: "var(--teal)" }} /></div>
                </div>
              </div>
            ))}
            {!levers.length && d && <div className="text-sm text-faint">No modifiable factors in current assessments.</div>}
            <Link to="/policy/interventions" className="inline-flex items-center gap-1 text-xs text-teal pt-2">Model interventions<ArrowRight className="size-3.5" /></Link>
            <p className="text-[11px] text-faint leading-relaxed pt-1">
              Shares come from the risk model's explanations (logistic regression, points relative to a normal value). They describe the model, not proven
              causation; the model is trained on synthetic data.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
