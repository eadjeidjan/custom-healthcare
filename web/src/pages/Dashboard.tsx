import { Link } from "react-router-dom";
import { Activity, AlertTriangle, Bell, ClipboardCheck, Flame, TrendingUp, Users } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/util";
import { useSession } from "../lib/session";
import { Empty, ErrorNote, Page, PageHeader, Panel, Skeleton, SkeletonRows, cx } from "../components/ui";
import { CohortTrend, LevelDistribution } from "../components/charts";
import PatientTable from "../components/PatientTable";

function Tile({ icon, label, value, sub, tone, to }:
  { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; tone?: string; to?: string }) {
  const body = (
    <div className={cx("glass rounded-2xl p-4 h-full transition-all relative overflow-hidden", to && "hover:border-linehi hover:-translate-y-0.5")}>
      <div className="absolute -right-6 -top-6 size-24 rounded-full blur-2xl opacity-25" style={{ background: tone || "var(--teal)" }} />
      <div className="relative flex items-center gap-2 text-[11px] uppercase tracking-wider text-faint">
        <span style={{ color: tone || "var(--teal)" }}>{icon}</span>{label}
      </div>
      <div className="relative num text-3xl font-semibold tracking-tight mt-2" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="relative text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}

export default function Dashboard() {
  const { user } = useSession();
  const { data, error, loading } = useAsync(() => api.dashboard(), []);
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const hiCrit = data ? (data.levels.high || 0) + (data.levels.critical || 0) : 0;

  return (
    <Page>
      <PageHeader
        eyebrow={new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
        title={<>{greet}{user?.name ? `, ${user.name.split(" ")[0]}` : ""}</>}
        sub="Cohort overview: who is most likely to have a vaso-occlusive crisis in the next 7 days."
      />
      <ErrorNote>{error}</ErrorNote>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
        {loading || !data ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[112px] rounded-2xl" />) : (
          <>
            <Tile icon={<Users className="size-4" />} label="Patients" value={data.patients} sub="under monitoring" to="/patients" />
            <Tile icon={<Flame className="size-4" />} label="High / critical" value={hiCrit}
              tone={hiCrit ? "var(--lv-high)" : undefined}
              sub={<>{data.levels.critical || 0} critical · {data.levels.high || 0} high</>} to="/patients" />
            <Tile icon={<Bell className="size-4" />} label="Open alerts" value={data.open_alerts}
              tone={data.open_alerts ? "var(--lv-crit)" : undefined} sub="awaiting acknowledgement" to="/alerts" />
            <Tile icon={<ClipboardCheck className="size-4" />} label="Check-ins today" value={data.checkins_today}
              sub={data.patients ? `${Math.round((data.checkins_today / data.patients) * 100)}% of patients` : undefined} />
            <Tile icon={<Activity className="size-4" />} label="Crises · 30 days" value={data.crises_30d} sub="recorded events" />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.6fr] mt-4">
        <Panel title="Risk distribution" icon={<AlertTriangle className="size-4 text-warn" />} sub="Latest assessment per patient">
          <div className="p-5">
            {data ? <LevelDistribution levels={data.levels} /> : <Skeleton className="h-24" />}
          </div>
        </Panel>
        <Panel title="Cohort trend · 30 days" icon={<TrendingUp className="size-4 text-teal" />}>
          <div className="p-4">
            {data ? (data.trend.length ? <CohortTrend data={data.trend} /> : <div className="text-sm text-muted py-10 text-center">No trend data yet.</div>)
              : <Skeleton className="h-56" />}
          </div>
        </Panel>
      </div>

      <Panel className="mt-4" title="Watchlist" icon={<Flame className="size-4 text-acc" />} sub="Highest 7-day risk first"
        actions={<Link to="/patients" className="text-xs text-teal hover:underline">All patients →</Link>}>
        {loading ? <SkeletonRows rows={5} /> : data && data.watchlist.length ? <PatientTable rows={data.watchlist} compact />
          : <Empty icon={<Users className="size-5" />} title="No patients yet">Add a patient to start monitoring.</Empty>}
      </Panel>
    </Page>
  );
}
