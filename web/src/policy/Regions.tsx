// Regions: sortable regional table (per 100k with 2021 census populations), tile map and facilities.
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useAsync } from "../lib/util";
import { cx, ErrorNote, Seg, SkeletonRows } from "../components/ui";
import { policy, type FacilityRow, type RegionRow } from "./api";
import { GhanaTileMap, MAP_METRICS, type MapMetric } from "./charts";
import { Card, HATCH_CSS, PageTitle, SuppressedNote, ghs, n0, pct, useDebounced, useSettings } from "./shared";

type Key = keyof RegionRow;
const COLS: { key: Key; label: string; fmt: (r: RegionRow) => string; num?: boolean; title?: string }[] = [
  { key: "region", label: "Region", fmt: (r) => r.region },
  { key: "population", label: "Population", fmt: (r) => n0(r.population), num: true, title: "2021 census" },
  { key: "patients", label: "Patients", fmt: (r) => n0(r.patients), num: true },
  { key: "per_100k", label: "Pts / 100k", fmt: (r) => n0(r.per_100k, 1), num: true, title: "Registered patients per 100,000 population" },
  { key: "crises_12m", label: "Crises", fmt: (r) => n0(r.crises_12m), num: true, title: "Last 12 months" },
  { key: "crises_per_100k", label: "Crises / 100k", fmt: (r) => n0(r.crises_per_100k, 1), num: true },
  { key: "admissions_12m", label: "Admissions", fmt: (r) => n0(r.admissions_12m), num: true },
  { key: "avg_los", label: "Avg LOS", fmt: (r) => n0(r.avg_los, 1), num: true, title: "Average length of stay, days" },
  { key: "hu_coverage", label: "Hydroxyurea", fmt: (r) => pct(r.hu_coverage), num: true },
  { key: "avg_risk", label: "Avg risk", fmt: (r) => n0(r.avg_risk), num: true },
  { key: "high_risk_now", label: "High risk", fmt: (r) => n0(r.high_risk_now), num: true },
  { key: "est_cost_ghs_12m", label: "Est. cost", fmt: (r) => ghs(r.est_cost_ghs_12m), num: true },
];

function sortVal(r: RegionRow, k: Key): number | string {
  const v = r[k];
  if (typeof v === "number") return v;
  if (typeof v === "string" && k === "region") return v;
  return -Infinity;    // suppressed / empty last when sorting descending
}

export default function Regions() {
  const { costBedDay } = useSettings();
  const cost = useDebounced(costBedDay);
  const regs = useAsync(() => policy.regions(cost), [cost]);
  const facs = useAsync(() => policy.facilities(cost), [cost]);
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: "crises_per_100k", desc: true });
  const [metric, setMetric] = useState<MapMetric>("crises_per_100k");
  const [sel, setSel] = useState<string | null>(null);
  const rows = useMemo(() => {
    const xs = [...(regs.data ?? [])];
    xs.sort((a, b) => {
      const va = sortVal(a, sort.k), vb = sortVal(b, sort.k);
      const c = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) : (va as number) - (vb as number);
      return sort.desc ? -c : c;
    });
    return xs;
  }, [regs.data, sort]);

  return (
    <>
      <PageTitle eyebrow="Geography" title="Regions"
        sub="Burden, hospital use and coverage by region. Rates use the 2021 census population; the registry covers only patients known to SickleGuard facilities, so per-100k figures understate true prevalence." />
      <ErrorNote>{regs.error}</ErrorNote>
      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
        <Card title="Regional table" sub="Click a column to sort. Click a row to highlight it on the map." actions={<SuppressedNote />}>
          {!regs.data ? <SkeletonRows rows={10} /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-y border-line text-[10.5px] uppercase tracking-wider text-faint">
                    {COLS.map((c) => (
                      <th key={String(c.key)} title={c.title} className={cx("px-3 py-2.5 font-medium whitespace-nowrap select-none", c.num ? "text-right" : "text-left")}>
                        <button className={cx("inline-flex items-center gap-1 cursor-pointer hover:text-fg", sort.k === c.key && "text-fg")}
                          onClick={() => setSort((s) => ({ k: c.key, desc: s.k === c.key ? !s.desc : c.key !== "region" }))}>
                          {c.label}
                          {sort.k === c.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.region} onClick={() => setSel(sel === r.region ? null : r.region)}
                      className={cx("border-b border-line/60 cursor-pointer transition-colors", sel === r.region ? "bg-hi" : "hover:bg-hi/50",
                        (r.suppressed || r.patients === 0) && "text-faint")}>
                      {COLS.map((c) => (
                        <td key={String(c.key)} className={cx("px-3 py-2 whitespace-nowrap", c.num && "num text-right", c.key === "region" && "font-medium")}>
                          {c.key === "region" && r.suppressed
                            ? <span className="inline-flex items-center gap-2">{r.region}<span className="rounded-md px-1.5 text-[10px] border border-line" style={{ background: HATCH_CSS }}>&lt;5</span></span>
                            : c.fmt(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Map" sub={MAP_METRICS.find((m) => m.value === metric)?.long}
          actions={<Seg value={metric} onChange={setMetric} options={MAP_METRICS.map((m) => ({ value: m.value, label: m.label.split(" ")[0] }))} />}>
          <div className="px-5 pb-5">{regs.data && <GhanaTileMap rows={regs.data} metric={metric} selected={sel} onSelect={setSel} />}</div>
        </Card>
      </div>

      <Card className="mt-4" title="Facilities" sub="Facilities with at least 5 registered patients. Smaller facilities are pooled and not named.">
        {!facs.data ? <SkeletonRows rows={4} /> : <FacilityTable rows={facs.data} />}
      </Card>
    </>
  );
}

function FacilityTable({ rows }: { rows: FacilityRow[] }) {
  if (!rows.length) return <div className="px-5 pb-5 text-sm text-faint">No facilities recorded yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-y border-line text-[10.5px] uppercase tracking-wider text-faint">
            {["Facility", "Region", "Patients", "Crises", "Admissions", "Avg LOS", "Hydroxyurea", "Avg risk", "Est. cost"].map((h, i) => (
              <th key={h} className={cx("px-3 py-2.5 font-medium whitespace-nowrap", i > 1 ? "text-right" : "text-left")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.facility + (r.region ?? "")} className={cx("border-b border-line/60", r.pooled && "text-muted italic")}>
              <td className="px-3 py-2 font-medium">{r.facility}</td>
              <td className="px-3 py-2 text-muted">{r.region ?? "—"}</td>
              <td className="px-3 py-2 num text-right">{n0(r.patients)}</td>
              <td className="px-3 py-2 num text-right">{n0(r.crises_12m)}</td>
              <td className="px-3 py-2 num text-right">{n0(r.admissions_12m)}</td>
              <td className="px-3 py-2 num text-right">{n0(r.avg_los, 1)}</td>
              <td className="px-3 py-2 num text-right">{pct(r.hu_coverage)}</td>
              <td className="px-3 py-2 num text-right">{n0(r.avg_risk)}</td>
              <td className="px-3 py-2 num text-right">{ghs(r.est_cost_ghs_12m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
