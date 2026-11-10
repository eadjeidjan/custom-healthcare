// Theme, async loading and formatting helpers.
import { useCallback, useEffect, useState } from "react";
import type { RiskLevel } from "../types";

export type Theme = "dark" | "light";
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    (document.documentElement.dataset.theme as Theme) === "light" ? "light" : "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("sg_theme", theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

// Loads data once (and on reload()); keeps the error as a plain message.
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try { setData(await fn()); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void load(); }, [load]);
  return { data, setData, error, loading, reload: load };
}

// ---------- risk levels ----------
export const LEVEL_COLOR: Record<RiskLevel, string> = {
  low: "var(--lv-low)", moderate: "var(--lv-mod)", high: "var(--lv-high)", critical: "var(--lv-crit)",
};
export const LEVEL_LABEL: Record<RiskLevel, string> = { low: "Low", moderate: "Moderate", high: "High", critical: "Critical" };

// ---------- dates ----------
// Day strings ("2026-11-10") are parsed as local dates, times as instants.
export function parseDate(s: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
}
function dayDiff(d: Date): number {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(d); b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}
const hm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** "Today 08:15", "Yesterday 17:02", "3 days ago", "12 Oct" */
export function when(s?: string | null): string {
  if (!s) return "—";
  const d = parseDate(s);
  if (isNaN(d.getTime())) return s;
  const n = dayDiff(d);
  if (n === 0) return isDay(s) ? "Today" : `Today ${hm(d)}`;
  if (n === 1) return isDay(s) ? "Yesterday" : `Yesterday ${hm(d)}`;
  if (n > 1 && n < 7) return `${n} days ago`;
  if (n < 0 && n > -7) return `in ${-n} days`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
export function shortDate(s: string): string {
  const d = parseDate(s);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export function fullDate(s?: string | null): string {
  if (!s) return "—";
  const d = parseDate(s);
  return isDay(s)
    ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
