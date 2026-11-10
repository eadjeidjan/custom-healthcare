// "From the record": what labs, imaging, devices and check-ins add to the prediction (GET /record-summary).
import { Activity, ClipboardList, Cpu, FlaskConical, ScanEye } from "lucide-react";
import type { ReactNode } from "react";
import { Panel, Skeleton, cx } from "../components/ui";
import { when } from "../lib/util";
import type { RecordSummary, RiskInput } from "./types";

const SOURCE: Record<RiskInput["source"], { label: string; icon: ReactNode }> = {
  device: { label: "Devices", icon: <Cpu className="size-3.5" /> },
  lab: { label: "Labs", icon: <FlaskConical className="size-3.5" /> },
  imaging: { label: "Imaging", icon: <ScanEye className="size-3.5" /> },
  checkin: { label: "Check-in", icon: <ClipboardList className="size-3.5" /> },
};

function tone(flag?: string | null) {
  if (flag === "severe") return "text-bad";
  if (flag === "high" || flag === "moderate") return "text-warn";
  if (flag === "low") return "text-info";
  return "";
}

export function RecordSnapshot({ data, loading, onOpen }: { data: RecordSummary | null; loading: boolean; onOpen: (tab: "vitals" | "labs" | "imaging" | "checkins") => void }) {
  const groups = (["device", "lab", "imaging", "checkin"] as const).map((s) => ({ s, items: (data?.risk_inputs ?? []).filter((i) => i.source === s) }));
  const tabOf = { device: "vitals", lab: "labs", imaging: "imaging", checkin: "checkins" } as const;
  return (
    <Panel className="mt-4" title="From the record" icon={<Activity className="size-4 text-teal" />}
      sub="Device signals, labs, imaging and check-ins that inform the prediction · flagged values first">
      {loading && !data ? <div className="p-5 grid gap-3 md:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div> : (
        <div className="grid md:grid-cols-2 xl:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-line">
          {groups.map(({ s, items }) => {
            const sorted = [...items].sort((a, b) => +!!b.flag - +!!a.flag);
            return (
              <div key={s} className="p-4 min-w-0">
                <button type="button" onClick={() => onOpen(tabOf[s])}
                  className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-faint hover:text-teal mb-2 cursor-pointer">
                  {SOURCE[s].icon}{SOURCE[s].label}<span className="normal-case tracking-normal">→</span>
                </button>
                {sorted.length ? (
                  <ul className="space-y-1.5">
                    {sorted.slice(0, 6).map((i, k) => (
                      <li key={k} className="flex items-baseline justify-between gap-2 text-sm" title={i.at ? `as of ${when(i.at)}` : undefined}>
                        <span className="text-muted truncate">{i.label}</span>
                        <span className={cx("num text-right shrink-0 max-w-[60%] truncate font-medium", tone(i.flag))}>{i.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-faint">Nothing recorded.</p>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
