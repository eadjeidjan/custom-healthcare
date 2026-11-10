// Overview: national KPIs with change vs the previous 12 months, the regional tile map, the next weeks and top drivers.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useAsync } from "../lib/util";
import { ErrorNote, Seg, Skeleton } from "../components/ui";
import { policy } from "./api";
import { DriverBars, ForecastChart, GhanaTileMap, MAP_METRICS, type MapMetric } from "./charts";
import { Card, Kpi, PageTitle, SuppressedNote, ghs, n0, pct, useDebounced, useSettings } from "./shared";

export default function Overview() {
  const { costBedDay } = useSettings();
  const cost = useDebounced(costBedDay);
  const ov = useAsync(() => policy.overview(cost), [cost]);
  const regs = useAsync(() => policy.regions(cost), [cost]);
  const fc = useAsync(() => policy.forecast(8), []);
  const dr = useAsync(() => policy.drivers(), []);
  const [metric, setMetric] = useState<MapMetric>("crises_per_100k");
  const [sel, setSel] = useState<string | null>(null);
  const o = ov.data;
  const d = o?.deltas ?? {};
  const selRow = regs.data?.find((r) => r.region === sel);
  const next4 = fc.data?.weeks.slice(0, 4).reduce((a, w) => a + (w.expected_crises ?? 0), 0);

  return (
    <>
      <PageTitle eyebrow={`Republic of Ghana · as of ${o?.as_of ?? "…"}`} title="Sickle cell disease: national picture"
        sub="Vaso-occlusive crises, hospital use and current risk across the registry. Changes compare the last 12 months with the 12 months before." />
      <ErrorNote>{ov.error}</ErrorNote>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {!o ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[112px] rounded-2xl" />) : (
          <>
            <Kpi label="Registered patients" value={n0(o.patients)} accent="info" sub={`${o.regions} region${o.regions === 1 ? "" : "s"} · ${o.facilities} facilit${o.facilities === 1 ? "y" : "ies"}`} />
            <Kpi label="Crises · 12 months" value={n0(o.crises_12m)} delta={d.crises_12m?.change_pct ?? null} accent="acc" sub="vs prior 12 m" />
            <Kpi label="Admissions · 12 months" value={n0(o.admissions_12m)} delta={d.admissions_12m?.change_pct ?? null} accent="acc"
              sub={o.admission_rate != null ? `${pct(o.admission_rate)} of crises` : undefined} />
            <Kpi label="Bed-days · 12 months" value={n0(o.bed_days_12m)} delta={d.bed_days_12m?.change_pct ?? null} accent="warn" />
            <Kpi label="Average length of stay" value={n0(o.avg_los, 1)} unit="days" delta={d.avg_los?.change_pct ?? null} accent="warn"
              sub={o.avg_los_imputed ? "imputed: national median" : undefined} />
            <Kpi label="Hydroxyurea coverage" value={pct(o.hu_coverage)} accent="teal" sub="of registered patients" />
            <Kpi label="High risk now" value={n0(o.high_risk_now)} accent="acc"
              sub={o.expected_crises_7d != null ? `≈ ${n0(o.expected_crises_7d, 0)} crises expected in 7 days` : undefined} />
            <Kpi label="Estimated cost · 12 months" value={ghs(o.est_cost_ghs_12m)} delta={d.est_cost_ghs_12m?.change_pct ?? null} accent="info"
              sub={`at GHS ${n0(o.cost_per_bed_day_ghs)}/bed-day`} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] gap-4">
        <Card eyebrow="Regional map" title="Ghana's 16 regions"
          sub={MAP_METRICS.find((m) => m.value === metric)?.long}
          actions={<Seg value={metric} onChange={setMetric} options={MAP_METRICS.map((m) => ({ value: m.value, label: m.label }))} />}>
          <div className="px-5 pb-5">
            {regs.data ? <GhanaTileMap rows={regs.data} metric={metric} selected={sel} onSelect={setSel} /> : <Skeleton className="h-[480px]" />}
            {selRow && (
              <div className="mt-4 rounded-xl border border-line bg-hi/40 px-4 py-3 text-sm fade-in">
                <div className="flex items-center justify-between"><span className="font-semibold">{selRow.region}</span>
                  <span className="text-[11px] text-faint">population {n0(selRow.population)}</span></div>
                {selRow.suppressed ? <SuppressedNote className="mt-2" /> : selRow.patients === 0 ? <div className="text-faint text-xs mt-1">No registered patients.</div> : (
                  <div className="mt-2 grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs">
                    {[["Patients", n0(selRow.patients)], ["Crises", n0(selRow.crises_12m)], ["Admissions", n0(selRow.admissions_12m)],
                      ["Hydroxyurea", pct(selRow.hu_coverage)], ["Avg risk", n0(selRow.avg_risk)]].map(([k, v]) => (
                      <div key={k}><div className="text-faint text-[10px] uppercase tracking-wider">{k}</div><div className="num font-semibold">{v}</div></div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        <div className="grid gap-4 content-start">
          <Card eyebrow="Next 8 weeks" title="Expected crises"
            sub={next4 != null ? `About ${n0(next4)} crises expected in the next 4 weeks across the registry.` : undefined}
            actions={<Link to="/policy/trends" className="text-xs text-teal inline-flex items-center gap-1">Trends & forecast<ArrowRight className="size-3.5" /></Link>}>
            <div className="px-3 pb-4">{fc.data ? <ForecastChart weeks={fc.data.weeks} height={220} /> : <Skeleton className="h-[220px] mx-2" />}</div>
          </Card>
          <Card eyebrow="What drives risk now" title="Top factors in current assessments"
            sub={dr.data ? `Modifiable factors account for ${pct(dr.data.modifiable_share)} of modelled risk.` : undefined}
            actions={<Link to="/policy/drivers" className="text-xs text-teal inline-flex items-center gap-1">All drivers<ArrowRight className="size-3.5" /></Link>}>
            <div className="px-5 pb-5">{dr.data ? <DriverBars rows={dr.data.drivers.filter((r) => r.modifiable && !r.suppressed).slice(0, 5)} /> : <Skeleton className="h-40" />}</div>
          </Card>
        </div>
      </div>
    </>
  );
}
