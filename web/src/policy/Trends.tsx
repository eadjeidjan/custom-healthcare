// Trends & forecast: monthly crises/admissions, average risk, seasonality and the 8-week forecast with its band.
import { useState } from "react";
import { useAsync } from "../lib/util";
import { ErrorNote, Select, Seg, Skeleton } from "../components/ui";
import { policy } from "./api";
import { ForecastChart, MonthlyChart, RiskLine, SeasonStrip, TILES } from "./charts";
import { Card, Kpi, PageTitle, SuppressedNote, n0, pct, weekLabel } from "./shared";

export default function Trends() {
  const [months, setMonths] = useState<"12" | "24">("24");
  const [region, setRegion] = useState("");
  const tr = useAsync(() => policy.trends(Number(months), region || undefined), [months, region]);
  const fc = useAsync(() => policy.forecast(8, region || undefined), [region]);
  const w = fc.data?.weeks ?? [];
  const tot = (k: "expected_crises" | "expected_admissions" | "expected_bed_days") => w.reduce((a, x) => a + (x[k] ?? 0), 0);
  const peak = w.reduce<typeof w[number] | null>((a, x) => (!a || (x.expected_crises ?? 0) > (a.expected_crises ?? 0) ? x : a), null);

  return (
    <>
      <PageTitle eyebrow="Time" title="Trends & forecast"
        sub="What happened month by month, and what the current risk scores and the season suggest for the next 8 weeks."
        actions={
          <>
            <Select value={region} onChange={(e) => setRegion(e.target.value)} className="h-9 w-48 text-xs" aria-label="Region">
              <option value="">All of Ghana</option>
              {Object.keys(TILES).sort().map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
            <Seg value={months} onChange={setMonths} options={[{ value: "12", label: "12 months" }, { value: "24", label: "24 months" }]} />
          </>
        } />
      <ErrorNote>{tr.error || fc.error}</ErrorNote>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Kpi label="Expected crises · 8 weeks" value={fc.data ? n0(tot("expected_crises")) : "…"} accent="acc" sub="sum of weekly forecasts" />
        <Kpi label="Expected admissions · 8 weeks" value={fc.data ? n0(tot("expected_admissions")) : "…"} accent="acc"
          sub={fc.data ? `at ${pct(fc.data.admission_rate)} admitted` : undefined} />
        <Kpi label="Expected bed-days · 8 weeks" value={fc.data ? n0(tot("expected_bed_days")) : "…"} accent="warn"
          sub={fc.data ? `avg stay ${fc.data.avg_los} days` : undefined} />
        <Kpi label="Busiest week" value={peak ? weekLabel(peak.week_start) : "—"} accent="info"
          sub={peak ? `${n0(peak.expected_crises, 1)} crises${peak.harmattan ? " · Harmattan" : ""}` : undefined} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
        <Card eyebrow="History" title="Crises and admissions per month" actions={<SuppressedNote />}
          sub="Hatched months had crises in fewer than 5 patients and are hidden.">
          <div className="px-3 pb-4">{tr.data ? <MonthlyChart rows={tr.data} /> : <Skeleton className="h-[260px] mx-2" />}</div>
        </Card>
        <Card eyebrow="Next 8 weeks" title="Forecast of weekly crises"
          sub="Each patient's current 7-day probability, fading back to their usual rate, adjusted for the season. Band: 90 % range.">
          <div className="px-3 pb-4">{fc.data ? <ForecastChart weeks={fc.data.weeks} /> : <Skeleton className="h-[280px] mx-2" />}</div>
        </Card>
        <Card eyebrow="History" title="Average 7-day risk score per month" sub="Mean per patient, then across patients (so daily check-ins don't dominate).">
          <div className="px-3 pb-4">{tr.data ? <RiskLine rows={tr.data} /> : <Skeleton className="h-[140px] mx-2" />}</div>
        </Card>
        <Card eyebrow="Seasonality" title="Monthly crisis index (1 = an average month)"
          sub="Estimated from up to 24 months of registry crises, shrunk towards a Harmattan prior (Dec–Feb high) while data are thin.">
          <div className="px-5 pb-5">{fc.data ? <SeasonStrip index={fc.data.seasonality} /> : <Skeleton className="h-20" />}</div>
        </Card>
      </div>
    </>
  );
}
