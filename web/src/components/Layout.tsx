// App frame: left navigation, top bar with user + sign out, page outlet.
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Bell, BookOpen, Bot, Cpu, LayoutDashboard, LogOut, Menu, Moon, ShieldAlert, Sun, Users, X } from "lucide-react";
import { useSession } from "../lib/session";
import { useTheme } from "../lib/util";
import { api } from "../lib/api";
import { Wordmark } from "./Logo";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/patients", label: "Patients", icon: Users },
  { to: "/assistant", label: "Assistant", icon: Bot },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/model", label: "Model", icon: Cpu },
];

export const DISCLAIMER = "Decision support only — not a diagnosis. Model trained on synthetic data.";

export default function Layout() {
  const { user, signOut } = useSession();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const [openAlerts, setOpenAlerts] = useState<number | null>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    let alive = true;
    const load = () => api.alerts("open").then((a) => alive && setOpenAlerts(a.length)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [loc.pathname]);

  const nav = (
    <nav className="flex flex-col h-full">
      <div className="flex items-center px-4 h-16"><Wordmark /></div>
      <div className="flex-1 px-2.5 py-3 space-y-0.5">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to} to={to} end={end}
            className={({ isActive }) => cx(
              "group relative flex items-center gap-3 rounded-xl px-3 h-10 text-sm transition-all",
              isActive ? "bg-hi text-fg" : "text-muted hover:text-fg hover:bg-hi/60",
            )}
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full grad-bg" />}
                <Icon className={cx("size-[18px] transition-colors", isActive ? "text-acc" : "group-hover:text-acc")} />
                <span className="flex-1">{label}</span>
                {to === "/alerts" && !!openAlerts && (
                  <span className="num min-w-5 h-5 px-1.5 grid place-items-center rounded-full bg-acc text-white text-[10px] font-bold">{openAlerts}</span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </div>
      <div className="m-3 rounded-xl border border-warn/25 bg-warn/[0.06] p-3 text-[11px] leading-relaxed text-muted">
        <div className="flex items-center gap-1.5 text-warn font-semibold mb-1"><ShieldAlert className="size-3.5" />Clinical safety</div>
        {DISCLAIMER} Red-flag symptoms always mean urgent care.
      </div>
    </nav>
  );

  return (
    <div className="relative h-full flex">
      <div className="backdrop" />
      <aside className="hidden lg:block relative z-10 w-60 shrink-0 glass border-y-0 border-l-0">{nav}</aside>
      {open && <div className="lg:hidden fixed inset-0 z-30 bg-black/50 fade-in" onClick={() => setOpen(false)} />}
      <aside className={cx("lg:hidden fixed z-40 inset-y-0 left-0 w-64 bg-solid border-r border-line transition-transform",
        open ? "translate-x-0" : "-translate-x-full")}>
        <button className="absolute right-3 top-5 text-muted cursor-pointer" onClick={() => setOpen(false)} aria-label="Close menu">
          <X className="size-5" />
        </button>
        {nav}
      </aside>

      <div className="relative z-10 flex-1 min-w-0 flex flex-col">
        <header className="flex items-center gap-3 h-14 px-4 lg:px-6 glass border-x-0 border-t-0 rounded-none">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="lg:hidden text-muted cursor-pointer"><Menu className="size-5" /></button>
          <div className="lg:hidden"><Wordmark size={24} /></div>
          <div className="hidden lg:flex items-center gap-2 text-xs text-faint">
            <span className="size-1.5 rounded-full bg-teal pulse-dot" /> 7-day vaso-occlusive crisis risk monitoring
          </div>
          <div className="flex-1" />
          <button onClick={toggleTheme} title={theme === "dark" ? "Light theme" : "Dark theme"}
            className="grid place-items-center size-9 rounded-xl text-muted hover:text-fg hover:bg-hi cursor-pointer">
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <div className="flex items-center gap-2.5 pl-2 border-l border-line">
            <div className="grid place-items-center size-8 rounded-full teal-bg text-white text-xs font-semibold shrink-0">
              {(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="hidden sm:block min-w-0 leading-tight">
              <div className="text-sm font-medium truncate max-w-40">{user?.name || user?.email}</div>
              <div className="text-[11px] text-faint capitalize">{user?.role}</div>
            </div>
            <button onClick={signOut} title="Sign out"
              className="ml-1 inline-flex items-center gap-1.5 h-9 px-2.5 rounded-xl text-sm text-muted hover:text-bad hover:bg-bad/10 cursor-pointer">
              <LogOut className="size-4" /><span className="hidden md:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
        </main>
        <footer className="lg:hidden px-4 py-1.5 text-[10.5px] text-faint text-center border-t border-line bg-solid/80">
          {DISCLAIMER}
        </footer>
      </div>
    </div>
  );
}
