// Body temperature is stored in °C; show it in both units everywhere.
export const cToF = (c: number) => (c * 9) / 5 + 32;
export const fToC = (f: number) => ((f - 32) * 5) / 9;

/** 38.5 → "38.5 °C (101.3 °F)" */
export function fmtTemp(c: number | null | undefined, digits = 1): string {
  if (c == null || Number.isNaN(c)) return "—";
  return `${c.toFixed(digits)} °C (${cToF(c).toFixed(digits)} °F)`;
}

/** Short form for tight spots (tables, chart labels): "38.5°C / 101.3°F" */
export function fmtTempShort(c: number | null | undefined, digits = 1): string {
  if (c == null || Number.isNaN(c)) return "—";
  return `${c.toFixed(digits)}°C / ${cToF(c).toFixed(digits)}°F`;
}
