// More: the screens that don't fit in the tab bar, profile, theme and sign out.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronRight, FileText, LogOut, Moon, Sun, Watch } from "lucide-react";
import { useSession } from "../lib/session";
import { Card, Disclaimer, H1, usePortal } from "./kit";

export default function More({ theme, toggleTheme }: { theme: "light" | "dark"; toggleTheme: () => void }) {
  const { me } = usePortal();
  const { signOut } = useSession();
  const p = me?.patient;
  return (
    <div className="fade-in">
      <H1>More</H1>
      {p && (
        <Card className="p-4 flex items-center gap-4">
          <span className="size-14 rounded-full grad-bg text-white grid place-items-center text-xl font-semibold shrink-0">{p.name.charAt(0)}</span>
          <div className="min-w-0">
            <p className="font-semibold text-[17px] truncate">{p.name}</p>
            <p className="text-[13.5px] text-muted">{p.genotype} · {p.on_hydroxyurea ? "on hydroxyurea" : "not on hydroxyurea"}</p>
            {me?.care_team && <p className="text-[13.5px] text-muted truncate">Care team: {me.care_team}</p>}
          </div>
        </Card>
      )}
      <Card className="mt-4 divide-y divide-[var(--border)]">
        <Row to="/portal/devices" icon={<Watch className="size-5" />} title="My devices" />
        <Row to="/portal/records" icon={<FileText className="size-5" />} title="My records" />
        <Row to="/portal/learn" icon={<BookOpen className="size-5" />} title="Learn" />
      </Card>
      <Card className="mt-4 divide-y divide-[var(--border)]">
        <button onClick={toggleTheme} className="pt-tap w-full flex items-center gap-3.5 p-4 text-left">
          <span className="size-10 rounded-xl bg-hi grid place-items-center text-muted">{theme === "light" ? <Moon className="size-5" /> : <Sun className="size-5" />}</span>
          <span className="flex-1 font-medium text-[15.5px]">{theme === "light" ? "Dark theme" : "Light theme"}</span>
        </button>
        <button onClick={signOut} className="pt-tap w-full flex items-center gap-3.5 p-4 text-left">
          <span className="size-10 rounded-xl bg-hi grid place-items-center text-muted"><LogOut className="size-5" /></span>
          <span className="flex-1 font-medium text-[15.5px]">Sign out</span>
        </button>
      </Card>
      <Disclaimer className="mt-8 px-2" />
      <p className="text-[12px] text-faint text-center mt-2">Risk scores come from a model trained on example (synthetic) data and are still being tested.</p>
    </div>
  );
}

function Row({ to, icon, title }: { to: string; icon: ReactNode; title: string }) {
  return (
    <Link to={to} className="pt-tap flex items-center gap-3.5 p-4">
      <span className="size-10 rounded-xl bg-hi grid place-items-center text-acc">{icon}</span>
      <span className="flex-1 font-medium text-[15.5px]">{title}</span>
      <ChevronRight className="size-5 text-faint" />
    </Link>
  );
}
