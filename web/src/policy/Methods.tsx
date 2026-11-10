// Data & methods: sources, the synthetic-data caveat, the privacy floor, model version and how each figure is made.
import type { ReactNode } from "react";
import { AlertTriangle, Database, Lock, Sigma } from "lucide-react";
import { useAsync } from "../lib/util";
import { Badge, ErrorNote, Skeleton } from "../components/ui";
import { policy } from "./api";
import { Card, PageTitle, n0 } from "./shared";

const LABEL: Record<string, string> = {
  hydroxyurea: "Hydroxyurea coverage", hydration: "Hydration programme", cold_season: "Cold-season outreach",
  adherence: "Adherence support", ed_analgesia: "Faster ED analgesia",
};

export default function Methods() {
  const m = useAsync(() => policy.meta(), []);
  const d = m.data;
  return (
    <>
      <PageTitle eyebrow="Transparency" title="Data & methods" sub="Where the numbers come from, what protects privacy, and what they cannot tell you." />
      <ErrorNote>{m.error}</ErrorNote>

      <div className="rounded-2xl border border-warn/30 bg-warn/[0.06] px-5 py-4 mb-4 flex gap-3">
        <AlertTriangle className="size-5 text-warn shrink-0 mt-0.5" />
        <div className="text-sm leading-relaxed">
          <div className="font-semibold text-warn mb-0.5">Synthetic data</div>
          The registry behind this dashboard is <b>simulated</b> for demonstration. Patient counts, crises, admissions and costs are not real Ghana
          statistics and must not be quoted as such. The risk model is also trained on synthetic data and must be validated on real outcomes before use.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title={<Ico icon={<Lock className="size-4 text-teal" />}>Privacy floor</Ico>}>
          <Prose>
            <p>Only aggregates leave the server. No names, record numbers, internal ids, dates of birth, phone numbers or free-text notes are ever returned
              to this dashboard or its CSV export.</p>
            <p>Any group built from fewer than <b>{d?.min_group ?? 5} patients</b> is suppressed: counts show as “&lt;5”, rates are blank and the cell is hatched.
              This applies to regions, facilities (small facilities are pooled and not named), months (crises from fewer than 5 patients), and risk factors
              (factors seen in fewer than 5 patients are pooled). If the whole registry has fewer than 5 patients, nothing is shown.</p>
          </Prose>
        </Card>
        <Card title={<Ico icon={<Database className="size-4 text-info" />}>Sources</Ico>}>
          <Prose>
            <p><b>Registry</b>: all SickleGuard patients, their recorded crises (date, admitted or not, length of stay, facility), hydroxyurea status and their
              latest risk assessment (counted as current if within {d?.current_window_days ?? 30} days).</p>
            <p><b>Population</b>: {d ? d.population_source : "…"} — total {d ? n0(d.population_total) : "…"}.</p>
            <p><b>Length of stay</b> when not recorded: {d?.default_los ?? 3} days, the national median for SCD admissions (Narh et al., BMJ Open 2021, DHIMS-II 2012–2017).</p>
            <p><b>Risk model</b>: {d ? <>version <code>{d.model_version}</code>{d.model_auc != null && <> · AUC {d.model_auc} on synthetic hold-out data</>}</> : "…"}.</p>
          </Prose>
        </Card>

        <Card className="lg:col-span-2" title={<Ico icon={<Sigma className="size-4 text-acc" />}>How each figure is made</Ico>}>
          <div className="grid md:grid-cols-2 gap-x-2">
            <Prose>
              <p><b>Changes (Δ)</b> compare the last 12 months with the 12 months before. Hydroxyurea coverage and current risk have no history yet.</p>
              <p><b>Per 100k</b> = count ÷ 2021 census population × 100,000. The registry includes only patients known to participating facilities.</p>
              <p><b>Estimated cost</b> = bed-days × cost per bed-day + crises not admitted × cost per emergency visit
                (defaults GHS {d ? n0(d.default_cost_per_bed_day_ghs) : "…"} and GHS {d ? n0(d.default_ed_visit_cost_ghs) : "…"}; illustrative,
                no published Ghana cost per VOC bed-day was found; change it in the header).</p>
              <p><b>Risk drivers</b>: each assessment explains its score in points per factor; points that raise risk are summed over current assessments and
                shown as shares. These describe the model, not proven causes.</p>
            </Prose>
            <Prose>
              <p><b>Forecast</b>: for each patient, the current 7-day probability fades back to their own usual rate (crises in the last 12 months) with a
                one-week half-life, then is scaled by the season index of that week relative to now. Summed over patients. The 90 % band combines
                event chance (Poisson-binomial) with 10 % model uncertainty growing 2.5 points per week. Admissions = crises × the registry admission rate.</p>
              <p><b>Seasonality</b>: monthly crisis counts over up to 24 months, shrunk towards a Harmattan prior (Dec–Feb high:
                {d ? ` Dec ${d.season_prior["12"]}, Jan ${d.season_prior["1"]}, Feb ${d.season_prior["2"]}` : ""}) with 50 pseudo-crises per month, so
                months with little data stay close to the prior.</p>
              <p><b>Scenarios</b>: crises avoided = crises the lever can reach × share reached × effect size; admissions follow the admission rate;
                savings use the unit costs above. Scenarios overlap and are not additive.</p>
            </Prose>
          </div>
        </Card>

        <Card className="lg:col-span-2" title="Intervention effect sizes">
          {!d ? <Skeleton className="h-40 mx-5 mb-5" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className="border-y border-line text-[10.5px] uppercase tracking-wider text-faint">
                  <th className="px-5 py-2.5 text-left font-medium">Scenario</th><th className="px-3 py-2.5 text-right font-medium">Effect</th>
                  <th className="px-3 py-2.5 text-left font-medium">Evidence</th><th className="px-3 py-2.5 text-right font-medium">Cost / person</th>
                  <th className="px-5 py-2.5 text-left font-medium">Source</th></tr></thead>
                <tbody>
                  {Object.entries(d.effects).map(([k, e]) => (
                    <tr key={k} className="border-b border-line/60 align-top">
                      <td className="px-5 py-2.5 font-medium whitespace-nowrap">{LABEL[k] ?? k}</td>
                      <td className="px-3 py-2.5 num text-right whitespace-nowrap">
                        {[e.crises ? `−${Math.round(e.crises * 100)} % crises` : "", e.admissions ? `−${Math.round(e.admissions * 100)} % admissions` : "",
                          e.los_days ? `−${e.los_days} d stay` : ""].filter(Boolean).join(", ")}
                      </td>
                      <td className="px-3 py-2.5"><Badge tone={e.evidence === "high" ? "teal" : e.evidence === "moderate" ? "warn" : "muted"}>{e.evidence}</Badge></td>
                      <td className="px-3 py-2.5 num text-right">GHS {n0(d.programme_cost_ghs[k])}</td>
                      <td className="px-5 py-2.5 text-xs text-muted leading-relaxed">{e.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-5 py-3 text-[11px] text-faint">Programme costs per person are illustrative placeholders; edit them on each scenario card.</p>
            </div>
          )}
        </Card>

        {d && d.research.length > 0 && (
          <Card className="lg:col-span-2" title="Context from the research review" sub="National figures compiled in docs/research (sources conflict; ranges shown).">
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 px-5 pb-5">
              {d.research.map((r) => (
                <div key={r.label} className="rounded-xl border border-line bg-hi/30 px-4 py-3">
                  <div className="text-[11px] text-faint">{r.label}</div>
                  <div className="num text-lg font-semibold mt-0.5">{r.value}</div>
                  <div className="text-[10.5px] text-faint mt-1 break-words line-clamp-3" title={r.source}>{r.source}</div>
                  {r.confidence && <Badge className="mt-2" tone={r.confidence === "high" ? "teal" : r.confidence === "medium" ? "warn" : "muted"}>{r.confidence} confidence</Badge>}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function Ico({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="flex items-center gap-2">{icon}{children}</span>;
}
function Prose({ children }: { children: ReactNode }) {
  return <div className="px-5 pb-5 space-y-2.5 text-sm text-muted leading-relaxed [&_b]:text-fg [&_b]:font-semibold [&_code]:font-mono [&_code]:text-xs">{children}</div>;
}
