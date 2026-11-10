// Patient portal (role "patient"): its own mobile-first layout with a bottom tab bar, no staff sidebar.
import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BookOpen, ClipboardCheck, FileText, Home as HomeIcon, LineChart, Menu, MessageCircleHeart, Moon, Siren, Sun, Watch } from "lucide-react";
import Logo from "../components/Logo";
import { cx } from "../components/ui";
import { portal, type PortalMe } from "./api";
import { Ctx, EmergencySheet } from "./kit";
import Home from "./Home";
import CheckIn from "./CheckIn";
import Trends from "./Trends";
import Devices from "./Devices";
import Records from "./Records";
import Learn from "./Learn";
import Ask from "./Ask";
import More from "./More";
import "./portal.css";

type PT = "light" | "dark";
const THEME_KEY = "sg_portal_theme";

export function usePortalTheme(): [PT, () => void] {
  const [t, setT] = useState<PT>(() => {
    try { return (localStorage.getItem(THEME_KEY) as PT) || "light"; } catch { return "light"; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = t;      // keeps body/scrollbars in step
    try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  }, [t]);
  return [t, () => setT((x) => (x === "light" ? "dark" : "light"))];
}

const TABS = [
  { to: "/portal", label: "Home", icon: HomeIcon, end: true },
  { to: "/portal/check-in", label: "Check in", icon: ClipboardCheck },
  { to: "/portal/trends", label: "Trends", icon: LineChart },
  { to: "/portal/ask", label: "Ask", icon: MessageCircleHeart },
  { to: "/portal/more", label: "More", icon: Menu },
];
const SIDE = [
  ...TABS.slice(0, 4),
  { to: "/portal/devices", label: "My devices", icon: Watch },
  { to: "/portal/records", label: "My records", icon: FileText },
  { to: "/portal/learn", label: "Learn", icon: BookOpen },
];

export default function PortalApp() {
  const [theme, toggleTheme] = usePortalTheme();
  const [me, setMe] = useState<PortalMe | null>(null);
  const [sos, setSos] = useState(false);
  const loc = useLocation();
  const reload = useCallback(async () => { try { setMe(await portal.me()); } catch { /* pages show their own errors */ } }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  const moreActive = ["/portal/more", "/portal/devices", "/portal/records", "/portal/learn"].some((p) => loc.pathname.startsWith(p));

  return (
    <Ctx.Provider value={{ me, reload, openEmergency: () => setSos(true) }}>
      <div className="portal" data-pt={theme}>
        {/* top bar */}
        <header className="sticky top-0 z-30 bg-bg/85 backdrop-blur-md border-b border-line">
          <div className="mx-auto max-w-5xl h-16 px-4 flex items-center gap-3">
            <NavLink to="/portal" className="flex items-center gap-2 min-w-0 pt-tap" aria-label="SickleGuard home">
              <Logo size={30} />
              <span className="font-semibold tracking-tight">Sickle<span className="grad-text">Guard</span></span>
            </NavLink>
            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={toggleTheme} aria-label={theme === "light" ? "Use dark theme" : "Use light theme"}
                className="hidden md:grid size-11 place-items-center rounded-full text-muted hover:bg-hi pt-tap">
                {theme === "light" ? <Moon className="size-5" /> : <Sun className="size-5" />}
              </button>
              <button onClick={() => setSos(true)}
                className="pt-tap h-11 pl-3.5 pr-4 rounded-full grad-bg text-white font-semibold text-[15px] flex items-center gap-2 shadow-[0_8px_22px_-8px_var(--glow)] active:scale-[0.97] transition">
                <Siren className="size-[18px]" />Emergency
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-5xl md:flex md:gap-8 md:px-6">
          {/* desktop side nav */}
          <nav className="hidden md:block w-52 shrink-0 pt-7" aria-label="Portal">
            <ul className="sticky top-24 space-y-1">
              {SIDE.map((t) => (
                <li key={t.to}>
                  <NavLink to={t.to} end={"end" in t ? t.end : false}
                    className={({ isActive }) => cx("flex items-center gap-3 h-11 px-3.5 rounded-xl text-[15px] transition",
                      isActive ? "bg-solid font-semibold shadow-[var(--pt-shadow)] text-fg" : "text-muted hover:text-fg hover:bg-hi")}>
                    <t.icon className="size-5" />{t.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <main className="flex-1 min-w-0 max-w-2xl px-4 md:px-0 pt-5 md:pt-7 pt-safe-bottom">
            <Routes>
              <Route index element={<Home />} />
              <Route path="check-in" element={<CheckIn />} />
              <Route path="trends" element={<Trends />} />
              <Route path="devices" element={<Devices />} />
              <Route path="records" element={<Records />} />
              <Route path="learn" element={<Learn />} />
              <Route path="ask" element={<Ask />} />
              <Route path="more" element={<More theme={theme} toggleTheme={toggleTheme} />} />
              <Route path="*" element={<Navigate to="/portal" replace />} />
            </Routes>
          </main>
        </div>

        {/* mobile bottom tab bar */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-solid/95 backdrop-blur-md border-t border-line pt-tabbar" aria-label="Portal">
          <ul className="grid grid-cols-5">
            {TABS.map((t) => (
              <li key={t.to}>
                <NavLink to={t.to} end={t.end}
                  className={({ isActive }) => {
                    const on = t.to === "/portal/more" ? moreActive : isActive;
                    return cx("pt-tap flex flex-col items-center justify-center gap-1 h-16 text-[11.5px] font-medium transition",
                      on ? "text-acc" : "text-faint");
                  }}>
                  {({ isActive }) => {
                    const on = t.to === "/portal/more" ? moreActive : isActive;
                    return (<>
                      <span className={cx("grid place-items-center h-7 w-12 rounded-full transition", on && "bg-acc/10")}><t.icon className="size-[22px]" strokeWidth={on ? 2.3 : 1.9} /></span>
                      {t.label}
                    </>);
                  }}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <EmergencySheet open={sos} onClose={() => setSos(false)} me={me} />
      </div>
    </Ctx.Provider>
  );
}
