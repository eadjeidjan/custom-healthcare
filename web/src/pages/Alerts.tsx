import { useState } from "react";
import { Link } from "react-router-dom";
import { BellOff, Check, CheckCircle2 } from "lucide-react";
import type { Alert, AlertFilter } from "../types";
import { api } from "../lib/api";
import { LEVEL_COLOR, fullDate, useAsync, when } from "../lib/util";
import { useToast } from "../lib/toast";
import { Button, Empty, ErrorNote, LevelPill, Page, PageHeader, Panel, Seg, SkeletonRows } from "../components/ui";

export default function Alerts() {
  const [filter, setFilter] = useState<AlertFilter>("open");
  const { data, setData, error, loading } = useAsync(() => api.alerts(filter), [filter]);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  async function ack(a: Alert) {
    setBusy(a.id);
    try {
      const r = await api.ackAlert(a.id);
      setData((xs) => (xs ?? []).flatMap((x) => (x.id === a.id ? (filter === "open" ? [] : [r]) : [x])));
      toast.ok(`Alert for ${a.patient_name} acknowledged`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <Page>
      <PageHeader title="Alerts" sub="Raised when a patient's risk crosses into high or critical, or a red flag appears."
        actions={<Seg<AlertFilter> value={filter} onChange={setFilter}
          options={[{ value: "open", label: "Open" }, { value: "acknowledged", label: "Acknowledged" }, { value: "all", label: "All" }]} />} />
      <ErrorNote>{error}</ErrorNote>
      <Panel>
        {loading && !data ? <SkeletonRows rows={6} /> : data && data.length ? (
          <ul className="divide-y divide-line">
            {data.map((a) => (
              <li key={a.id} className="relative flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4 hover:bg-hi/40 transition fade-in">
                <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full" style={{ background: LEVEL_COLOR[a.level], opacity: a.status === "open" ? 1 : 0.3 }} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <LevelPill level={a.level} score={a.score} />
                    <Link to={`/patients/${a.patient_id}`} className="font-medium hover:text-teal">{a.patient_name}</Link>
                    <span className="text-xs text-faint" title={fullDate(a.created_at)}>{when(a.created_at)}</span>
                  </div>
                  <div className="text-sm text-muted mt-1">{a.reason}</div>
                  {a.status === "acknowledged" && (
                    <div className="text-[11px] text-faint mt-1 flex items-center gap-1">
                      <CheckCircle2 className="size-3 text-ok" />Acknowledged by {a.acknowledged_by ?? "—"} · {when(a.acknowledged_at)}
                    </div>
                  )}
                </div>
                {a.status === "open" ? (
                  <Button size="sm" variant="teal" loading={busy === a.id} onClick={() => ack(a)}><Check className="size-3.5" />Acknowledge</Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={<BellOff className="size-5" />} title={filter === "open" ? "No open alerts" : "No alerts"}>
            {filter === "open" ? "All clear. New alerts appear here when risk rises." : undefined}
          </Empty>
        )}
      </Panel>
    </Page>
  );
}
