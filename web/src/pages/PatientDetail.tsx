import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Activity, ArrowLeft, Bot, BrainCircuit, CalendarPlus, CheckCircle2, ClipboardList, Cpu, Database, Droplet, HeartPulse,
  FlaskConical, Info, LayoutDashboard, Loader2, MessageSquare, Pill, ScanEye, ShieldCheck, Sparkles, Stethoscope, Thermometer,
  TrendingUp, Zap,
} from "lucide-react";
import type { Assessment, CheckIn, Crisis } from "../types";
import { api } from "../lib/api";
import { LEVEL_COLOR, fullDate, useAsync, when } from "../lib/util";
import { useToast } from "../lib/toast";
import { Badge, Button, Empty, ErrorNote, LevelPill, Modal, Page, Panel, Skeleton, SkeletonRows, cx } from "../components/ui";
import { FactorBars, PatientTrend, RiskGauge, toPoints } from "../components/charts";
import { Markdown, PlanView, RedFlagBanner, SourcesList } from "../components/clinical";
import { CheckInForm, CrisisForm } from "../components/PatientForms";
import { fmtTempShort } from "../lib/temp";
import { records } from "../records/api";
import { Tabs, type TabDef } from "../records/ui";
import { VitalsTab } from "../records/VitalsTab";
import { LabsTab } from "../records/LabsTab";
import { ImagingTab } from "../records/ImagingTab";
import { CheckinTrends } from "../records/CheckinsTab";
import { RecordSnapshot } from "../records/RecordSnapshot";

type TabId = "overview" | "vitals" | "labs" | "imaging" | "checkins";
const TAB_IDS: TabId[] = ["overview", "vitals", "labs", "imaging", "checkins"];

const STEPS = [
  { label: "Gathering patient data", icon: Database },
  { label: "Scoring 7-day VOC risk", icon: Cpu },
  { label: "Retrieving guidelines", icon: BookIcon },
  { label: "Drafting prevention plan", icon: BrainCircuit },
  { label: "Safety check", icon: ShieldCheck },
];
function BookIcon(p: { className?: string }) { return <ClipboardList {...p} />; }

export default function PatientDetail() {
  const { id = "" } = useParams();
  const toast = useToast();
  const patient = useAsync(() => api.patient(id), [id]);
  const assessments = useAsync(() => api.assessments(id, 60), [id]);
  const checkins = useAsync(() => api.checkins(id, 30), [id]);
  const crises = useAsync(() => api.crises(id), [id]);
  const model = useAsync(() => api.model().catch(() => null), []);
  const summary = useAsync(() => records.summary(id).catch(() => null), [id]);
  const [params, setParams] = useSearchParams();
  const tab: TabId = TAB_IDS.includes(params.get("tab") as TabId) ? (params.get("tab") as TabId) : "overview";
  const setTab = (t: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (t === "overview") n.delete("tab"); else n.set("tab", t); return n; }, { replace: true });
  const thresholds = toPoints(model.data?.thresholds);

  const [latest, setLatest] = useState<Assessment | null>(null);
  const [ai, setAi] = useState<Assessment | null>(null);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(0);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [modal, setModal] = useState<"checkin" | "crisis" | null>(null);

  useEffect(() => { setLatest(null); setAi(null); setAiErr(null); }, [id]);
  useEffect(() => {
    if (!assessments.data) return;
    const first = assessments.data[0] ?? null;
    setLatest((cur) => cur ?? first);
    setAi((cur) => cur ?? assessments.data!.find((a) => a.kind === "ai") ?? null);
  }, [assessments.data]);

  useEffect(() => {
    if (!running) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 3200);
    return () => clearInterval(t);
  }, [running]);

  async function runAi() {
    setRunning(true); setAiErr(null);
    try {
      const a = await api.assess(id);
      setAi(a); setLatest(a);
      assessments.reload(true);
      patient.reload(true);
      toast.ok("AI assessment complete");
      setTimeout(() => document.getElementById("ai-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) {
      setAiErr((e as Error).message);
      toast.error((e as Error).message);
    } finally { setRunning(false); }
  }

  const p = patient.data;
  const a = latest;
  const flags = a?.red_flags ?? [];
  const fallbackFlags = !a && p?.red_flags.length ? p.red_flags.map((l) => ({ key: l, label: l, action: "Review now and follow your red-flag protocol." })) : [];
  const trendPts = useMemo(() => (assessments.data ?? []).map((x) => ({ at: x.created_at, score: x.score, level: x.level, kind: x.kind })), [assessments.data]);

  if (patient.error) return <Page><ErrorNote>{patient.error}</ErrorNote></Page>;

  return (
    <Page>
      <Link to="/patients" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg mb-4"><ArrowLeft className="size-3.5" />Patients</Link>

      {/* Header */}
      <div className="glass rounded-2xl p-5 mb-4 relative overflow-hidden">
        <div className="absolute -right-20 -top-20 size-64 rounded-full blur-3xl opacity-20" style={{ background: a ? LEVEL_COLOR[a.level] : "var(--teal)" }} />
        {!p ? <div className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-5 w-96 max-w-full" /></div> : (
          <div className="relative flex flex-col lg:flex-row lg:items-center gap-4">
            <div className="flex items-center gap-4 min-w-0 flex-1">
              <div className="grid place-items-center size-14 rounded-2xl bg-hi border border-line text-lg font-semibold shrink-0">
                {p.name.split(" ").map((s) => s[0]).slice(0, 2).join("")}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
                  {a && <LevelPill level={a.level} score={a.score} />}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted mt-1">
                  <span className="font-mono text-xs">MRN {p.mrn}</span>
                  <span>{p.age} y · {p.sex === "F" ? "Female" : "Male"}</span>
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded-md bg-acc/10 text-acc border border-acc/25">{p.genotype}</span>
                  <span className="inline-flex items-center gap-1"><Pill className={cx("size-3.5", p.on_hydroxyurea ? "text-teal" : "text-faint")} />
                    Hydroxyurea {p.on_hydroxyurea ? "yes" : "no"}</span>
                  <span className="num">{p.crises_12m} crises / 12 mo</span>
                  {p.care_team && <span className="inline-flex items-center gap-1"><Stethoscope className="size-3.5 text-faint" />{p.care_team}</span>}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="teal" onClick={() => setModal("checkin")}><HeartPulse className="size-4" />New check-in</Button>
              <Button variant="outline" onClick={() => setModal("crisis")}><CalendarPlus className="size-4" />Record crisis</Button>
              <Link to={`/assistant?patient=${p.id}`}>
                <Button variant="ghost"><MessageSquare className="size-4" />Ask the assistant</Button>
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Red flags: never hidden */}
      {(flags.length > 0 || fallbackFlags.length > 0) && <div className="mb-4"><RedFlagBanner flags={flags.length ? flags : fallbackFlags} /></div>}

      <Tabs<TabId> value={tab} onChange={setTab} tabs={tabDefs(summary.data)} />

      {tab === "vitals" && <VitalsTab patientId={id} onChanged={() => summary.reload(true)} />}
      {tab === "labs" && <LabsTab patientId={id} hbBaseline={p?.hb_baseline} onChanged={() => summary.reload(true)} />}
      {tab === "imaging" && <ImagingTab patientId={id} onChanged={() => summary.reload(true)} />}
      {tab === "checkins" && (
        <div className="space-y-4 fade-in">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted">{checkins.data ? `${checkins.data.length} check-ins in the last 30 days` : "Loading…"}</div>
            <Button size="sm" variant="teal" onClick={() => setModal("checkin")}><HeartPulse className="size-3.5" />New check-in</Button>
          </div>
          {checkins.loading && !checkins.data ? <Skeleton className="h-40 rounded-2xl" /> : <CheckinTrends rows={checkins.data ?? []} />}
          <Panel title="Check-in history · 30 days" icon={<HeartPulse className="size-4 text-acc" />}>
            {checkins.loading && !checkins.data ? <SkeletonRows /> : checkins.data?.length ? <CheckinTable rows={checkins.data} limit={31} /> :
              <Empty icon={<HeartPulse className="size-5" />} title="No check-ins yet">Daily check-ins drive the risk score.</Empty>}
          </Panel>
        </div>
      )}

      {tab === "overview" && (<>
      {/* Gauge + why */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <Panel className="flex flex-col">
          <div className="flex flex-col items-center px-5 pt-6 pb-5 flex-1">
            <div className="text-[11px] uppercase tracking-[0.2em] text-faint mb-2">7-day VOC risk</div>
            {assessments.loading && !a ? <Skeleton className="size-56 rounded-full" /> : (
              <RiskGauge score={a?.score ?? null} level={a?.level ?? null} thresholds={thresholds}
                label={a ? `${a.kind === "ai" ? "AI assessment" : "Check-in"} · ${when(a.created_at)}` : "Submit a check-in to score"} />
            )}
            {a && (
              <div className="grid grid-cols-2 gap-2 w-full mt-3 text-center">
                <div className="rounded-xl bg-hi/60 border border-line py-2">
                  <div className="num text-lg font-semibold">{(a.probability * 100).toFixed(1)}%</div>
                  <div className="text-[10.5px] text-faint">probability of VOC in 7 days</div>
                </div>
                <div className="rounded-xl bg-hi/60 border border-line py-2">
                  <div className="font-mono text-sm font-semibold pt-1">{a.model_version}</div>
                  <div className="text-[10.5px] text-faint mt-0.5">model version</div>
                </div>
              </div>
            )}
            <Button variant="primary" size="lg" className="w-full mt-4" onClick={runAi} loading={running} disabled={!p}>
              {!running && <Sparkles className="size-4" />}{running ? "Assessing…" : "Run AI assessment"}
            </Button>
            <p className="text-[10.5px] text-faint text-center mt-2 leading-relaxed">{a?.disclaimer || "Decision support only — not a diagnosis."}</p>
          </div>
        </Panel>

        <Panel title="Why this score" icon={<Zap className="size-4 text-warn" />} sub="Each factor's contribution in score points, biggest first">
          <div className="p-5">
            {assessments.loading && !a ? <SkeletonRows rows={5} /> :
              a && a.factors.length ? <FactorBars factors={a.factors} /> :
              <Empty icon={<Activity className="size-5" />} title="No factors yet">Save a check-in to see what is driving this patient's risk.</Empty>}
          </div>
        </Panel>
      </div>

      {/* AI assessment */}
      <div id="ai-panel" className="scroll-mt-4">
        {(running || ai || aiErr) && (
          <Panel className="mt-4 overflow-hidden" title="AI assessment & prevention plan" icon={<Bot className="size-4 text-acc" />}
            sub={ai && !running ? `${fullDate(ai.created_at)} · data → model → guidelines → AI plan → safety check` : undefined}
            actions={ai && !running ? <LevelPill level={ai.level} score={ai.score} /> : undefined}>
            <div className="p-5 space-y-5">
              {running && (
                <div className="grid sm:grid-cols-5 gap-2">
                  {STEPS.map((s, i) => {
                    const I = s.icon;
                    const state = i < step ? "done" : i === step ? "now" : "todo";
                    return (
                      <div key={s.label} className={cx("rounded-xl border px-3 py-3 transition-all",
                        state === "now" ? "border-acc/50 bg-acc/[0.07] glow" : state === "done" ? "border-teal/30 bg-teal/[0.05]" : "border-line opacity-50")}>
                        <div className="flex items-center gap-2">
                          {state === "done" ? <CheckCircle2 className="size-4 text-teal" /> : state === "now" ? <Loader2 className="size-4 text-acc animate-spin" /> : <I className="size-4 text-faint" />}
                          <span className="text-[10px] text-faint num">{i + 1}/5</span>
                        </div>
                        <div className={cx("text-xs mt-1.5 font-medium", state === "now" && "shimmer")}>{s.label}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              {aiErr && !running && <ErrorNote>{aiErr}</ErrorNote>}
              {ai && !running && (
                <div className="space-y-5 fade-in">
                  {ai.summary ? (
                    <div className="rounded-xl border border-line bg-gradient-to-br from-acc/[0.05] to-teal/[0.05] p-4">
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint mb-2"><Sparkles className="size-3.5 text-acc" />Summary</div>
                      <Markdown text={ai.summary} />
                    </div>
                  ) : (
                    <div className="flex items-start gap-2 rounded-xl border border-info/25 bg-info/[0.07] px-3 py-2 text-xs text-muted">
                      <Info className="size-4 text-info shrink-0" />AI explanation needs an OpenAI key; rule-based plan shown.
                    </div>
                  )}
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-faint mb-2">Prevention plan</div>
                    <PlanView plan={ai.plan} />
                  </div>
                  <SourcesList sources={ai.sources} />
                </div>
              )}
            </div>
          </Panel>
        )}
      </div>

      {/* Trend */}
      <Panel className="mt-4" title="Risk trend · 60 days" icon={<TrendingUp className="size-4 text-teal" />} sub="Shaded bands are risk levels; red markers are recorded crises">
        <div className="p-4">
          {assessments.loading && !assessments.data ? <Skeleton className="h-60" /> :
            trendPts.length || (crises.data?.length ?? 0) ? <PatientTrend points={trendPts} crises={crises.data ?? []} thresholds={thresholds} /> :
            <div className="text-sm text-muted py-12 text-center">No assessments in the last 60 days.</div>}
        </div>
      </Panel>

      {/* Check-ins + crises */}
      <div className="grid gap-4 xl:grid-cols-[1fr_340px] mt-4">
        <Panel title="Recent check-ins" icon={<HeartPulse className="size-4 text-acc" />}
          actions={<Button size="sm" variant="teal" onClick={() => setModal("checkin")}>New check-in</Button>}>
          {checkins.loading && !checkins.data ? <SkeletonRows /> : checkins.data?.length ? <CheckinTable rows={checkins.data} /> :
            <Empty icon={<HeartPulse className="size-5" />} title="No check-ins yet">Daily check-ins drive the risk score.</Empty>}
        </Panel>
        <Panel title="Crisis events" icon={<Droplet className="size-4 text-acc" />}
          actions={<Button size="sm" onClick={() => setModal("crisis")}>Record</Button>}>
          {crises.loading && !crises.data ? <SkeletonRows rows={3} /> : crises.data?.length ? (
            <ul className="divide-y divide-line">
              {[...crises.data].sort((x, y) => y.date.localeCompare(x.date)).map((c) => (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{fullDate(c.date)}</span>
                    <Badge tone={c.severity === "severe" ? "bad" : c.severity === "moderate" ? "warn" : "muted"}>{c.severity}</Badge>
                  </div>
                  <div className="text-xs text-muted mt-0.5">{c.hospitalised ? "Hospitalised" : "Managed at home"}{c.notes ? ` · ${c.notes}` : ""}</div>
                </li>
              ))}
            </ul>
          ) : <Empty icon={<Droplet className="size-5" />} title="No crises recorded" />}
        </Panel>
      </div>

      <RecordSnapshot data={summary.data} loading={summary.loading} onOpen={setTab} />

      {p?.notes && (
        <Panel className="mt-4" title="Clinical notes"><p className="p-5 text-sm text-muted whitespace-pre-wrap">{p.notes}</p></Panel>
      )}
      </>)}

      <Modal open={modal === "checkin"} onClose={() => setModal(null)} title={`New check-in · ${p?.name ?? ""}`} wide>
        {p && <CheckInForm patientId={p.id} sex={p.sex} onHydroxyurea={p.on_hydroxyurea} onCancel={() => setModal(null)}
          onSaved={(r) => {
            setModal(null);
            setLatest(r.assessment);
            checkins.setData((xs) => [r.checkin, ...(xs ?? []).filter((c: CheckIn) => c.date !== r.checkin.date)]);
            assessments.setData((xs) => [r.assessment, ...(xs ?? [])]);
            patient.reload(true);
            summary.reload(true);
            window.scrollTo({ top: 0, behavior: "smooth" });
            document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
          }} />}
      </Modal>
      <Modal open={modal === "crisis"} onClose={() => setModal(null)} title="Record crisis">
        {p && <CrisisForm patientId={p.id} onCancel={() => setModal(null)}
          onSaved={(c: Crisis) => { setModal(null); crises.setData((xs) => [c, ...(xs ?? [])]); patient.reload(true); }} />}
      </Modal>
    </Page>
  );
}

function tabDefs(s: { vitals_alerts?: { severity?: string }[]; imaging_flags: { severity: string }[] } | null): TabDef<TabId>[] {
  const alerts = s?.vitals_alerts ?? [];
  const severeImg = (s?.imaging_flags ?? []).filter((f) => f.severity === "severe").length;
  return [
    { id: "overview", label: "Overview", icon: <LayoutDashboard className="size-4" /> },
    { id: "vitals", label: "Vitals & devices", icon: <Activity className="size-4" />, badge: alerts.length || null,
      badgeTone: alerts.some((a) => a.severity !== "moderate") ? "bad" : "warn" },
    { id: "labs", label: "Labs", icon: <FlaskConical className="size-4" /> },
    { id: "imaging", label: "Imaging", icon: <ScanEye className="size-4" />, badge: severeImg || null, badgeTone: "bad" },
    { id: "checkins", label: "Check-ins", icon: <HeartPulse className="size-4" /> },
  ];
}

function CheckinTable({ rows, limit = 14 }: { rows: CheckIn[]; limit?: number }) {
  const flagsOf = (c: CheckIn) => [
    c.chest_symptoms && "chest", c.neuro_symptoms && "neuro", c.infection_symptoms && "infection", c.cold_exposure && "cold",
    c.strenuous_activity && "exertion", c.alcohol && "alcohol", c.menstruating && "menses", c.hydroxyurea_taken === false && "missed HU",
  ].filter(Boolean) as string[];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm num">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-faint border-b border-line">
            <th className="font-medium px-5 py-2.5">Date</th>
            <th className="font-medium px-2 py-2.5">Pain</th>
            <th className="font-medium px-2 py-2.5">Fluids</th>
            <th className="font-medium px-2 py-2.5">Sleep</th>
            <th className="font-medium px-2 py-2.5">Stress</th>
            <th className="font-medium px-2 py-2.5 whitespace-nowrap"><Thermometer className="size-3.5 inline" /> °C / °F</th>
            <th className="font-medium px-2 py-2.5">SpO₂</th>
            <th className="font-medium px-2 py-2.5">Factors</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((c) => {
            const fl = flagsOf(c);
            return (
              <tr key={c.id} className="border-b border-line/70 last:border-0 hover:bg-hi/40" title={c.notes || undefined}>
                <td className="px-5 py-2.5 whitespace-nowrap">{when(c.date)}</td>
                <td className="px-2 py-2.5 font-semibold" style={{ color: c.pain >= 7 ? "var(--lv-crit)" : c.pain >= 4 ? "var(--lv-mod)" : undefined }}>{c.pain}</td>
                <td className={cx("px-2 py-2.5", c.hydration_litres < 1.5 && "text-warn")}>{c.hydration_litres.toFixed(1)} L</td>
                <td className={cx("px-2 py-2.5", c.sleep_hours < 6 && "text-warn")}>{c.sleep_hours} h</td>
                <td className="px-2 py-2.5">{c.stress}</td>
                <td className={cx("px-2 py-2.5 whitespace-nowrap", c.temperature_c >= 38.5 ? "text-bad font-semibold" : c.temperature_c >= 37.8 && "text-warn")}>{fmtTempShort(c.temperature_c)}</td>
                <td className={cx("px-2 py-2.5", c.spo2 != null && c.spo2 < 94 && "text-bad font-semibold")}>{c.spo2 ?? "—"}</td>
                <td className="px-2 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {fl.length ? fl.map((f) => <Badge key={f} tone={f === "chest" || f === "neuro" ? "bad" : "muted"}>{f}</Badge>) : <span className="text-faint text-xs">—</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
