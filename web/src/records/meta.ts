// Display metadata for metrics, devices, labs and imaging (labels, units, colours, icons).
import {
  Activity, Bone, Brain, Droplets, FileText, Footprints, GlassWater, HeartPulse, Moon, Radar, ScanLine, Thermometer, Waves, Watch, Wind,
} from "lucide-react";
import type { DeviceKind, Metric, Modality, Severity } from "./types";
import { cToF, fmtTemp, fmtTempShort } from "../lib/temp";

type Icon = typeof Activity;

export interface MetricMeta {
  label: string; short: string; unit: string; color: string; icon: Icon; digits: number; daily: "mean" | "sum";
  /** value at or beyond which the latest reading is shown as a concern */
  warn?: { below?: number; above?: number };
  /** fixed y-axis floor/ceiling so small changes don't look dramatic */
  floor?: number; ceil?: number;
}

export const METRICS: Record<Metric, MetricMeta> = {
  spo2: { label: "Oxygen saturation", short: "SpO₂", unit: "%", color: "#60a5fa", icon: Wind, digits: 0, daily: "mean", warn: { below: 92 }, floor: 85, ceil: 100 },
  heart_rate: { label: "Resting heart rate", short: "Heart rate", unit: "bpm", color: "#f43f5e", icon: HeartPulse, digits: 0, daily: "mean", warn: { above: 110 } },
  body_temp_c: { label: "Body temperature", short: "Temp", unit: "°C", color: "#fb923c", icon: Thermometer, digits: 1, daily: "mean", warn: { above: 38.4 }, floor: 35.5, ceil: 39.5 },
  fluid_ml: { label: "Fluid intake", short: "Fluids", unit: "mL", color: "#2dd4bf", icon: GlassWater, digits: 0, daily: "sum", warn: { below: 1500 }, floor: 0 },
  hrv_rmssd: { label: "Heart rate variability", short: "HRV", unit: "ms", color: "#a78bfa", icon: Activity, digits: 0, daily: "mean" },
  resp_rate: { label: "Respiratory rate", short: "Resp.", unit: "/min", color: "#38bdf8", icon: Waves, digits: 0, daily: "mean", warn: { above: 24 } },
  skin_temp_c: { label: "Skin temperature", short: "Skin temp", unit: "°C", color: "#fbbf24", icon: Thermometer, digits: 1, daily: "mean" },
  steps: { label: "Steps", short: "Steps", unit: "steps", color: "#34d399", icon: Footprints, digits: 0, daily: "sum", floor: 0 },
  sleep_minutes: { label: "Sleep", short: "Sleep", unit: "h", color: "#818cf8", icon: Moon, digits: 1, daily: "sum", floor: 0 },
};
export const METRIC_ORDER: Metric[] = ["spo2", "heart_rate", "body_temp_c", "fluid_ml", "hrv_rmssd", "resp_rate", "skin_temp_c", "steps", "sleep_minutes"];

/** Sleep is stored in minutes but read in hours. */
export function display(metric: Metric, v: number | null | undefined): number | null {
  if (v == null || isNaN(v)) return null;
  return metric === "sleep_minutes" ? v / 60 : v;
}
export const isTemp = (m: Metric) => m === "body_temp_c" || m === "skin_temp_c";
/** Unit label for headings: temperatures are stored in °C and shown in °C and °F. */
export const unitLabel = (m: Metric) => (isTemp(m) ? "°C / °F" : METRICS[m].unit);
/** Value with its unit; temperatures as "38.5 °C (101.3 °F)" (long) or "38.5°C / 101.3°F" (short). */
export function withUnit(metric: Metric, v: number | null | undefined, short = true): string {
  if (v == null || isNaN(v)) return "—";
  if (isTemp(metric)) return short ? fmtTempShort(v, METRICS[metric].digits) : fmtTemp(v, METRICS[metric].digits);
  return `${fmtMetric(metric, v)} ${METRICS[metric].unit}`;
}
/** A °C difference also in °F (differences scale by 1.8, no offset). */
export function deltaWithUnit(metric: Metric, d: number): string {
  if (isTemp(metric)) return `${Math.abs(d).toFixed(1)}°C / ${(Math.abs(d) * 1.8).toFixed(1)}°F`;
  return Math.abs(display(metric, d)!).toFixed(METRICS[metric].digits);
}
export { cToF };

export function fmtMetric(metric: Metric, v: number | null | undefined): string {
  const d = display(metric, v);
  if (d == null) return "—";
  return d.toLocaleString(undefined, { maximumFractionDigits: METRICS[metric].digits, minimumFractionDigits: METRICS[metric].digits });
}

export const KINDS: Record<DeviceKind, { label: string; icon: Icon; blurb: string; example: Metric }> = {
  wearable: { label: "Wearable", icon: Watch, blurb: "Heart rate, HRV, skin temperature, steps, sleep", example: "heart_rate" },
  pulse_oximeter: { label: "Pulse oximeter", icon: Activity, blurb: "SpO₂ and pulse", example: "spo2" },
  smart_bottle: { label: "Smart bottle", icon: GlassWater, blurb: "Fluid intake per drink", example: "fluid_ml" },
  thermometer: { label: "Thermometer", icon: Thermometer, blurb: "Body temperature", example: "body_temp_c" },
};
export const KIND_ORDER: DeviceKind[] = ["wearable", "pulse_oximeter", "smart_bottle", "thermometer"];

export const MODALITIES: Record<Modality, { label: string; icon: Icon }> = {
  xray: { label: "X-ray", icon: ScanLine },
  mri: { label: "MRI", icon: Brain },
  ct: { label: "CT", icon: Radar },
  ultrasound: { label: "Ultrasound", icon: Droplets },
  tcd: { label: "Transcranial Doppler", icon: Waves },
};
export const MODALITY_ORDER: Modality[] = ["xray", "mri", "ct", "ultrasound", "tcd"];
export const OtherStudyIcon = FileText;
export const BoneIcon = Bone;

export const SEVERITY: Record<Severity, { label: string; tone: "bad" | "warn" | "info"; color: string; rank: number }> = {
  severe: { label: "Severe", tone: "bad", color: "var(--bad)", rank: 0 },
  moderate: { label: "Moderate", tone: "warn", color: "var(--warn)", rank: 1 },
  info: { label: "Info", tone: "info", color: "var(--info)", rank: 2 },
};

export const LAB_ORDER = ["hb", "retic", "ldh", "bili", "wbc", "anc", "plt", "hbf", "crp", "creat", "ferritin"];
