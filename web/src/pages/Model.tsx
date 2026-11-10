import { Activity, AlertTriangle, BarChart3, Cpu, Database, FlaskConical, Gauge, Layers, ListChecks, Scale, Target, Timer } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { LEVEL_COLOR, fullDate, useAsync } from "../lib/util";
import { Badge, ErrorNote, Page, PageHeader, Panel, Skeleton } from "../components/ui";
import { WeightBars, toPoints } from "../components/charts";
import type { FeatureGroup, ModelCard } from "../types";

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint"><span className="text-teal">{icon}</span>{label}</div>
      <div className="num text-2xl font-semibold mt-2 tracking-tight">{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

const GROUP_LABEL: Record<FeatureGroup, string> = {
  device: "IoT devices", lab: "Labs (EMR)", imaging: "Imaging", "check-in": "Daily check-ins", history: "History & profile",
};
const GROUP_ORDER: FeatureGroup[] = ["device", "lab", "imaging", "check-in", "history"];

/** Reliability diagram: mean predicted vs observed 7-day VOC rate per risk bin; dot area ~ patient-days. */
function CalibrationChart({ bins }: { bins: NonNullable<ModelCard["calibration"]> }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320, H = 260, pl = 40, pr = 12, pt = 12, pb = 34;
  const iw = W - pl - pr, ih = H - pt - pb;
  const max = Math.min(1, Math.max(0.05, ...bins.flatMap((b) => [b.predicted, b.observed])) * 1.1);
  const x = (v: number) => pl + (iw * v) / max;
  const y = (v: number) => pt + ih - (ih * v) / max;
  const nMax = Math.max(1, ...bins.map((b) => b.n));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const hb = hover != null ? bins[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px] h-auto block mx-auto" role="img"
        aria-label="Calibration: predicted versus observed crisis rate" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={pl - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--faint)" className="num">{pct(t, 0)}</text>
            <text x={x(t)} y={H - pb + 14} textAnchor="middle" fontSize="10" fill="var(--faint)" className="num">{pct(t, 0)}</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)} stroke="var(--faint)" strokeDasharray="4 4" strokeWidth="1" />
        <text x={x(max) - 4} y={y(max) + 14} textAnchor="end" fontSize="10" fill="var(--faint)">perfect</text>
        <polyline fill="none" stroke="var(--teal)" strokeWidth="2" points={bins.map((b) => `${x(b.predicted)},${y(b.observed)}`).join(" ")} />
        {bins.map((b, i) => (
          <g key={b.bin} onMouseEnter={() => setHover(i)}>
            <circle cx={x(b.predicted)} cy={y(b.observed)} r={14} fill="transparent" />
            <circle cx={x(b.predicted)} cy={y(b.observed)} r={4 + 6 * Math.sqrt(b.n / nMax)} fill="var(--teal)"
              fillOpacity={hover === i ? 0.95 : 0.7} stroke="var(--surface, var(--bg))" strokeWidth="2" />
          </g>
        ))}
        <text x={pl + iw / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--muted)">Predicted 7-day risk</text>
        <text x={10} y={pt + ih / 2} textAnchor="middle" fontSize="10" fill="var(--muted)" transform={`rotate(-90 10 ${pt + ih / 2})`}>Observed</text>
      </svg>
      {hb && (
        <div className="absolute top-2 right-2 glass rounded-xl px-3 py-2 text-xs pointer-events-none">
          <div className="font-semibold">Risk bin {hb.bin}</div>
          <div className="text-muted num">predicted {pct(hb.predicted, 2)} · observed {pct(hb.observed, 2)}</div>
          <div className="text-faint num">{hb.n.toLocaleString()} patient-days</div>
        </div>
      )}
    </div>
  );
}

function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-faint text-left">
            {head.map((h, i) => <th key={i} className={`px-4 py-2 font-medium ${i ? "text-right" : ""}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) => <td key={j} className={`px-4 py-2 ${j ? "text-right num" : ""}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Model() {
  const { data: m, error, loading } = useAsync(() => api.model(), []);
  const th = toPoints(m?.thresholds);
  const groups = m?.feature_groups ?? [];
  const sortedGroups = [...groups].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return (
    <Page>
      <PageHeader title="Model card" sub="How the 7-day VOC risk score is produced, how well it performs on simulated patients, and where it falls short." />
      <div role="note" className="flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn/[0.08] px-4 py-3.5 mb-5">
        <AlertTriangle className="size-5 text-warn shrink-0 mt-0.5" />
        <div className="text-sm">
          <div className="font-semibold text-warn">Trained and tested on synthetic data</div>
          <div className="text-muted mt-0.5">Every number on this page comes from a literature-calibrated simulator, not from real patients. It shows how the system behaves, not real-world accuracy. The model must be retrained and prospectively validated on real outcomes before any clinical use. Scores support, and never replace, clinical judgement.</div>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {loading || !m ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <Stat icon={<Cpu className="size-4" />} label="Algorithm"
              value={<span className="text-base leading-snug block" title={m.algorithm}>{m.algorithm.split(/[;(]/)[0].replace(/ with .*/, "").trim()}</span>}
              sub={<span className="font-mono">{m.version}</span>} />
            <Stat icon={<Gauge className="size-4" />} label="AUROC" value={m.auc.toFixed(3)} sub="discrimination (0.5 = chance)" />
            <Stat icon={<Target className="size-4" />} label="AUPRC" value={m.auprc != null ? m.auprc.toFixed(3) : "–"}
              sub={`precision–recall; chance ≈ ${pct(m.positive_rate <= 1 ? m.positive_rate : m.positive_rate / 100)}`} />
            <Stat icon={<Scale className="size-4" />} label="Brier score" value={m.brier.toFixed(4)} sub="probability error (lower is better)" />
            <Stat icon={<Database className="size-4" />} label="Simulated cohort"
              value={m.cohort ? m.cohort.patients.toLocaleString() : m.training_rows.toLocaleString()}
              sub={m.cohort ? `patients · ${m.cohort.patient_days.toLocaleString()} patient-days · ${m.cohort.events.toLocaleString()} crises` : "training rows"} />
            <Stat icon={<Activity className="size-4" />} label="Outcome rate" value={pct(m.positive_rate <= 1 ? m.positive_rate : m.positive_rate / 100, 2)}
              sub="patient-days with a crisis in the next 7 days" />
            <Stat icon={<Timer className="size-4" />} label="Median warning" value={m.lead_time_days != null ? `${m.lead_time_days} d` : "–"}
              sub="before crises flagged at the high level" />
            <Stat icon={<BarChart3 className="size-4" />} label="Temporal hold-out" value={m.temporal ? m.temporal.auroc.toFixed(3) : "–"}
              sub={m.temporal ? `AUROC, ${m.temporal.period}` : `trained ${fullDate(m.trained_at)}`} />
          </div>

          <p className="text-xs text-faint mt-3 px-1">{m.algorithm} · trained {fullDate(m.trained_at)}{m.cohort?.source === "synthetic" && <> · <Badge tone="warn">synthetic data</Badge></>}</p>

          <div className="grid gap-4 lg:grid-cols-2 mt-4">
            {m.calibration && m.calibration.length > 0 && (
              <Panel title="Calibration" icon={<Scale className="size-4 text-teal" />} sub="Predicted vs observed 7-day crisis rate on held-out simulated patients. Dots on the dashed line = well calibrated; dot size = patient-days.">
                <div className="p-5"><CalibrationChart bins={m.calibration} /></div>
                <details className="px-5 pb-4 text-xs text-muted">
                  <summary className="cursor-pointer text-faint">Table view</summary>
                  <Table head={["Risk bin", "Predicted", "Observed", "Patient-days"]}
                    rows={m.calibration.map((b) => [b.bin, pct(b.predicted, 2), pct(b.observed, 2), b.n.toLocaleString()])} />
                </details>
              </Panel>
            )}
            <div className="space-y-4">
              {m.operating_points && m.operating_points.length > 0 && (
                <Panel title="Operating points" icon={<Target className="size-4 text-acc" />} sub="What each risk level means on held-out simulated patients. Alerts = new alerts per 100 patient-weeks (one open alert per patient).">
                  <Table head={["Level", "Threshold", "Sensitivity", "Specificity", "PPV", "Alerts"]}
                    rows={m.operating_points.map((o) => [
                      <span className="font-semibold capitalize" style={{ color: LEVEL_COLOR[o.level] }}>{o.level}</span>,
                      `≥ ${Math.round(o.threshold * (o.threshold <= 1 ? 100 : 1))}`, pct(o.sensitivity, 0), pct(o.specificity, 0), pct(o.ppv, 1),
                      o.alerts_per_100_weeks.toFixed(1)])} />
                </Panel>
              )}
              {m.comparison && m.comparison.length > 0 && (
                <Panel title="Model comparison" icon={<FlaskConical className="size-4 text-teal" />} sub="Same held-out simulated patients. The check-ins-only row shows what devices, labs and imaging add.">
                  <Table head={["Model", "AUROC", "AUPRC", "Brier"]}
                    rows={m.comparison.map((c) => [<span className="text-sm">{c.algorithm}</span>, c.auroc.toFixed(3), c.auprc.toFixed(3), c.brier.toFixed(4)])} />
                </Panel>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr] mt-4">
            <Panel title="Feature importance" icon={<FlaskConical className="size-4 text-acc" />} sub="Drop in AUPRC (×100) when a feature is shuffled. Red raises risk, teal lowers it. Hover for details.">
              <div className="p-5"><WeightBars items={m.features.filter((f) => f.weight !== 0).slice().sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 18)} /></div>
            </Panel>
            <div className="space-y-4">
              <Panel title="Risk thresholds" icon={<Gauge className="size-4 text-teal" />} sub="Score points (0–100) = 7-day crisis probability">
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
              {sortedGroups.length > 0 && (
                <Panel title="Inputs by source" icon={<Layers className="size-4 text-teal" />} sub="What feeds the prediction. Missing data count as normal, with a missing flag.">
                  <div className="p-5 space-y-3">
                    {sortedGroups.map((g) => (
                      <div key={g.group}>
                        <div className="text-[11px] uppercase tracking-wider text-faint mb-1.5">{GROUP_LABEL[g.group] ?? g.group}</div>
                        <div className="flex flex-wrap gap-1.5">{g.features.map((f) => <Badge key={f} tone="muted">{f}</Badge>)}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
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
