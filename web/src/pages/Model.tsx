import { AlertTriangle, Cpu, Database, FlaskConical, Gauge, ListChecks, Scale } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { LEVEL_COLOR, fullDate, useAsync } from "../lib/util";
import { ErrorNote, Page, PageHeader, Panel, Skeleton } from "../components/ui";
import { WeightBars, toPoints } from "../components/charts";

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint"><span className="text-teal">{icon}</span>{label}</div>
      <div className="num text-2xl font-semibold mt-2 tracking-tight">{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

export default function Model() {
  const { data: m, error, loading } = useAsync(() => api.model(), []);
  const th = toPoints(m?.thresholds);
  return (
    <Page>
      <PageHeader title="Model card" sub="How the 7-day VOC risk score is produced, how well it performs, and where it falls short." />
      <div role="note" className="flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/[0.08] px-4 py-3.5 mb-5">
        <AlertTriangle className="size-5 text-warn shrink-0 mt-0.5" />
        <div className="text-sm">
          <div className="font-semibold text-warn">Trained on synthetic data</div>
          <div className="text-muted mt-0.5">This model has not been trained or validated on real patients. It must be prospectively validated before any clinical use. Scores support, and never replace, clinical judgement.</div>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {loading || !m ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <Stat icon={<Cpu className="size-4" />} label="Algorithm"
              value={<span className="text-base leading-snug block" title={m.algorithm}>{m.algorithm.split(/[;(]/)[0].trim()}</span>}
              sub={<span className="font-mono">{m.version}</span>} />
            <Stat icon={<Gauge className="size-4" />} label="AUC" value={m.auc.toFixed(3)} sub="discrimination (0.5 = chance)" />
            <Stat icon={<Scale className="size-4" />} label="Brier score" value={m.brier.toFixed(3)} sub="calibration error (lower is better)" />
            <Stat icon={<Database className="size-4" />} label="Training rows" value={m.training_rows.toLocaleString()}
              sub={`${(m.positive_rate * (m.positive_rate <= 1 ? 100 : 1)).toFixed(1)}% had a VOC · trained ${fullDate(m.trained_at)}`} />
          </div>

          <p className="text-xs text-faint mt-3 px-1">{m.algorithm}</p>
          <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr] mt-4">
            <Panel title="Feature weights" icon={<FlaskConical className="size-4 text-acc" />} sub="Red raises risk, teal lowers it. Hover for details.">
              <div className="p-5"><WeightBars items={m.features} /></div>
            </Panel>
            <div className="space-y-4">
              <Panel title="Risk thresholds" icon={<Gauge className="size-4 text-teal" />} sub="Score points (0–100)">
                <div className="p-5">
                  <div className="flex h-3 rounded-full overflow-hidden">
                    <div style={{ width: `${th.moderate}%`, background: LEVEL_COLOR.low }} />
                    <div style={{ width: `${th.high - th.moderate}%`, background: LEVEL_COLOR.moderate }} />
                    <div style={{ width: `${th.critical - th.high}%`, background: LEVEL_COLOR.high }} />
                    <div style={{ width: `${100 - th.critical}%`, background: LEVEL_COLOR.critical }} />
                  </div>
                  <div className="grid grid-cols-4 text-xs mt-3 num">
                    {([["low", 0], ["moderate", th.moderate], ["high", th.high], ["critical", th.critical]] as const).map(([l, v]) => (
                      <div key={l}><div className="font-semibold capitalize" style={{ color: LEVEL_COLOR[l] }}>{l}</div><div className="text-faint">≥ {Math.round(v)}</div></div>
                    ))}
                  </div>
                  <p className="text-[11px] text-faint mt-3">Any red flag forces the level to critical regardless of score.</p>
                </div>
              </Panel>
              <Panel title="Data" icon={<Database className="size-4 text-teal" />}>
                <p className="p-5 text-sm text-muted leading-relaxed whitespace-pre-wrap">{m.data_note}</p>
              </Panel>
              <Panel title="Limitations" icon={<ListChecks className="size-4 text-warn" />}>
                <ul className="p-5 space-y-2 text-sm text-muted">
                  {m.limitations.map((l, i) => (
                    <li key={i} className="flex gap-2"><span className="mt-2 size-1.5 rounded-full bg-warn shrink-0" />{l}</li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
