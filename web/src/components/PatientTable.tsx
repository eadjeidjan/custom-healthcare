// Patient rows table used by the dashboard watchlist and the patients page.
import { useNavigate } from "react-router-dom";
import { AlertOctagon, ChevronRight, Pill } from "lucide-react";
import type { PatientRow } from "../types";
import { when } from "../lib/util";
import { Badge, LevelPill, ScoreBar, cx } from "./ui";

export default function PatientTable({ rows, compact }: { rows: PatientRow[]; compact?: boolean }) {
  const nav = useNavigate();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-faint border-b border-line">
            <th className="font-medium px-5 py-2.5">Patient</th>
            <th className="font-medium px-3 py-2.5">Genotype</th>
            <th className="font-medium px-3 py-2.5">7-day risk</th>
            <th className="font-medium px-3 py-2.5">Level</th>
            <th className="font-medium px-3 py-2.5">Red flags</th>
            {!compact && <th className="font-medium px-3 py-2.5 hidden md:table-cell">Crises 12m</th>}
            <th className="font-medium px-3 py-2.5 whitespace-nowrap">Last check-in</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} onClick={() => nav(`/patients/${p.id}`)}
              className={cx("group border-b border-line/70 last:border-0 cursor-pointer transition-colors hover:bg-hi/60",
                p.red_flags.length > 0 && "bg-bad/[0.04]")}>
              <td className="px-5 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="grid place-items-center size-8 rounded-full bg-hi border border-line text-xs font-semibold shrink-0">
                    {p.name.split(" ").map((s) => s[0]).slice(0, 2).join("")}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate group-hover:text-fg">{p.name}</div>
                    <div className="text-[11px] text-faint num whitespace-nowrap">{p.mrn} · {p.age}{p.sex}</div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-3">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs">{p.genotype}</span>
                  {p.on_hydroxyurea && <span title="On hydroxyurea"><Pill className="size-3.5 text-teal" /></span>}
                </div>
              </td>
              <td className="px-3 py-3">{p.risk ? <ScoreBar score={p.risk.score} level={p.risk.level} /> : <span className="text-faint text-xs">—</span>}</td>
              <td className="px-3 py-3">{p.risk ? <LevelPill level={p.risk.level} /> : <Badge>Not assessed</Badge>}</td>
              <td className="px-3 py-3">
                {p.red_flags.length ? (
                  <div className="flex flex-wrap gap-1 max-w-56">
                    {p.red_flags.slice(0, 2).map((f) => <span key={f} title={f} className="max-w-56 min-w-0"><Badge tone="bad"><AlertOctagon className="size-3 shrink-0" /><span className="truncate max-w-48">{f.split(" (")[0]}</span></Badge></span>)}
                    {p.red_flags.length > 2 && <Badge tone="bad">+{p.red_flags.length - 2}</Badge>}
                  </div>
                ) : <span className="text-faint text-xs">None</span>}
              </td>
              {!compact && <td className="px-3 py-3 num hidden md:table-cell">{p.crises_12m}</td>}
              <td className="px-3 py-3 text-xs text-muted whitespace-nowrap">{when(p.last_checkin)}</td>
              <td className="pr-4"><ChevronRight className="size-4 text-faint group-hover:text-fg group-hover:translate-x-0.5 transition" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
