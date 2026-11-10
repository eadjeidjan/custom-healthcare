// Policy-maker dashboard (role "policy"; admins can open it too): a national observatory of anonymised aggregates.
// Own layout (top navigation, no clinical sidebar). Owned by the policy work stream.
import { useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ArrowLeft, Download, LogOut, Menu, Moon, ShieldCheck, Sun, X } from "lucide-react";
import { useSession } from "../lib/session";
import { useTheme } from "../lib/util";
import { Wordmark } from "../components/Logo";
import { cx } from "../components/ui";
import { useToast } from "../lib/toast";
import { downloadCsv } from "./api";
import { HatchDefs, SettingsProvider, useSettings } from "./shared";
import Overview from "./Overview";
import Regions from "./Regions";
import Trends from "./Trends";
import Drivers from "./Drivers";
import Interventions from "./Interventions";
import Methods from "./Methods";

const NAV = [
  { to: "/policy", label: "Overview", end: true },
  { to: "/policy/regions", label: "Regions" },
  { to: "/policy/trends", label: "Trends & forecast" },
  { to: "/policy/drivers", label: "Drivers" },
  { to: "/policy/interventions", label: "Interventions" },
  { to: "/policy/methods", label: "Data & methods" },
];

export default function PolicyApp() {
  return (
    <SettingsProvider>
      <Frame />
    </SettingsProvider>
  );
}

function Frame() {
  const { user, signOut } = useSession();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!user) return <Navigate to="/login" replace />;

  const links = (mobile: boolean) => NAV.map(({ to, label, end }) => (
    <NavLink key={to} to={to} end={end}
      className={({ isActive }) => cx(
        "relative whitespace-nowrap text-[13px] transition-colors",
        mobile ? "block px-4 py-3 rounded-xl" : "px-3 h-14 inline-flex items-center",
        isActive ? "text-fg" : "text-muted hover:text-fg",
        mobile && isActive && "bg-hi",
      )}>
      {({ isActive }) => (
        <>
          {label}
          {!mobile && isActive && <span className="absolute left-3 right-3 bottom-0 h-[2px] rounded-full grad-bg shadow-[0_0_12px_var(--glow)]" />}
        </>
      )}
    </NavLink>
  ));

  return (
    <div className="relative h-full flex flex-col obs">
      <HatchDefs />
      <div className="backdrop" />
      <header className="relative z-20 glass border-x-0 border-t-0 rounded-none">
        <div className="mx-auto max-w-[1400px] flex items-center gap-3 px-4 lg:px-8 h-14">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="xl:hidden text-muted cursor-pointer"><Menu className="size-5" /></button>
          <Link to="/policy" className="flex items-center gap-3 shrink-0">
            <Wordmark size={26} />
            <span className="hidden md:block h-6 w-px bg-line" />
            <span className="hidden md:block text-[10px] uppercase tracking-[0.24em] text-faint leading-tight">National SCD<br />observatory</span>
          </Link>
          <nav className="hidden xl:flex items-center ml-4">{links(false)}</nav>
          <div className="flex-1" />
          <CostControl />
          <CsvButton />
          {user.role === "admin" && (
            <Link to="/" title="Back to the clinical app" className="hidden sm:inline-flex items-center gap-1.5 h-9 px-2.5 rounded-xl text-xs text-muted hover:text-fg hover:bg-hi">
              <ArrowLeft className="size-3.5" />Clinical
            </Link>
          )}
          <button onClick={toggleTheme} title={theme === "dark" ? "Light theme" : "Dark theme"}
            className="grid place-items-center size-9 rounded-xl text-muted hover:text-fg hover:bg-hi cursor-pointer">
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-line">
            <div className="min-w-0 leading-tight text-right">
              <div className="text-xs font-medium truncate max-w-36">{user.name || user.email}</div>
              <div className="text-[10px] text-faint capitalize">{user.role === "policy" ? "Policy maker" : user.role}</div>
            </div>
          </div>
          <button onClick={signOut} title="Sign out" className="grid place-items-center size-9 rounded-xl text-muted hover:text-bad hover:bg-bad/10 cursor-pointer">
            <LogOut className="size-4" />
          </button>
        </div>
      </header>

      {open && <div className="xl:hidden fixed inset-0 z-30 bg-black/50 fade-in" onClick={() => setOpen(false)} />}
      <aside className={cx("xl:hidden fixed z-40 inset-y-0 left-0 w-72 bg-solid border-r border-line p-3 transition-transform",
        open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex items-center justify-between px-2 h-12 mb-2">
          <Wordmark size={24} />
          <button className="text-muted cursor-pointer" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
        </div>
        {links(true)}
        {user.role === "admin" && <Link to="/" className="block px-4 py-3 text-[13px] text-muted">← Clinical app</Link>}
      </aside>

      <main className="relative z-10 flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1400px] px-4 lg:px-8 py-6 lg:py-8 fade-in" key={loc.pathname}>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="regions" element={<Regions />} />
            <Route path="trends" element={<Trends />} />
            <Route path="drivers" element={<Drivers />} />
            <Route path="interventions" element={<Interventions />} />
            <Route path="methods" element={<Methods />} />
            <Route path="*" element={<Navigate to="/policy" replace />} />
          </Routes>
        </div>
        <footer className="mx-auto max-w-[1400px] px-4 lg:px-8 pb-6 text-[11px] text-faint flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-teal" />Anonymised aggregates only · groups under 5 patients hidden</span>
          <span>Synthetic registry for demonstration: figures are not real Ghana statistics.</span>
          <Link to="/policy/methods" className="underline underline-offset-2 hover:text-muted">Data & methods</Link>
        </footer>
      </main>
    </div>
  );
}

function CostControl() {
  const { costBedDay, setCostBedDay } = useSettings();
  const [v, setV] = useState(String(costBedDay));
  useEffect(() => setV(String(costBedDay)), [costBedDay]);
  const commit = () => {
    const n = Math.round(Number(v));
    if (n > 0 && n <= 100000) setCostBedDay(n); else setV(String(costBedDay));
  };
  return (
    <label className="hidden lg:flex items-center gap-2 h-9 pl-3 pr-1 rounded-xl border border-line bg-solid/50 text-[11px] text-faint"
      title="Cost of one hospital bed-day in Ghana cedis; used for every cost estimate">
      <span className="whitespace-nowrap">Bed-day GHS</span>
      <input value={v} onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))} onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()} inputMode="numeric" aria-label="Cost per bed-day in GHS"
        className="num w-16 h-7 rounded-lg bg-hi/70 px-2 text-xs text-fg outline-none focus:ring-2 focus:ring-teal/30" />
    </label>
  );
}

function CsvButton() {
  const { costBedDay } = useSettings();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy} title="Download the regional table as CSV"
      onClick={async () => {
        setBusy(true);
        try { await downloadCsv(costBedDay); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
      }}
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border border-line text-xs text-fg hover:border-linehi hover:bg-hi cursor-pointer disabled:opacity-50">
      <Download className="size-3.5" /><span className="hidden sm:inline">CSV</span>
    </button>
  );
}
