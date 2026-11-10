// My records: latest blood tests with plain-language explanations, and imaging reports (report + impression only).
import { useState } from "react";
import { ChevronDown, FileText, FlaskConical, ScanLine } from "lucide-react";
import { cx } from "../components/ui";
import { useAsync } from "../lib/util";
import { portal, type Lab, type ImagingReport } from "./api";
import { Card, H1, Loading, Oops, SectionTitle, dayLabel } from "./kit";

export default function Records() {
  const { data, error, reload } = useAsync(() => portal.records(), []);
  return (
    <div className="fade-in">
      <H1 sub="Your latest results from the clinic. Your care team will explain what they mean for you.">My records</H1>
      {error ? <Oops message={error} retry={() => reload()} /> : !data ? <Loading /> : (
        <>
          <SectionTitle>Blood tests</SectionTitle>
          {data.labs.length === 0 ? <Card className="p-5 text-muted text-[15px]">No blood test results yet.</Card> : (
            <>
              <div className="grid gap-3">{data.labs.map((l) => <LabCard key={l.id} l={l} />)}</div>
              <p className="text-[13px] text-faint mt-3">People with sickle cell often have some results outside the usual range — that can be normal for you. Ask your care team what your own usual numbers are.</p>
            </>
          )}
          <SectionTitle>Scans and X-rays</SectionTitle>
          {data.imaging.length === 0 ? <Card className="p-5 text-muted text-[15px]">No scan reports yet.</Card> : (
            <div className="grid gap-3">{data.imaging.map((i) => <ImagingCard key={i.id} i={i} />)}</div>
          )}
        </>
      )}
    </div>
  );
}

function RangeBar({ l }: { l: Lab }) {
  if (l.ref_low === null || l.ref_high === null) return null;
  const span = l.ref_high - l.ref_low || 1;
  const lo = l.ref_low - span * 0.6, hi = l.ref_high + span * 0.6;
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return (
    <div className="mt-3" aria-hidden>
      <div className="relative h-2 rounded-full bg-hi">
        <div className="absolute inset-y-0 rounded-full bg-ok/35" style={{ left: `${pos(l.ref_low)}%`, right: `${100 - pos(l.ref_high)}%` }} />
        <div className={cx("absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full border-2 border-[var(--panel-solid)]", l.flag ? "bg-warn" : "bg-ok")} style={{ left: `${pos(l.value)}%` }} />
      </div>
      <div className="flex justify-between text-[11.5px] text-faint mt-1 num" style={{ paddingLeft: `${pos(l.ref_low) - 4}%`, paddingRight: `${100 - pos(l.ref_high) - 4}%` }}>
        <span>{l.ref_low}</span><span>{l.ref_high}</span>
      </div>
    </div>
  );
}

function LabCard({ l }: { l: Lab }) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="size-10 rounded-xl bg-hi text-acc grid place-items-center shrink-0"><FlaskConical className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold text-[15.5px]">{l.name}</p>
            <p className="text-[12px] text-faint shrink-0">{dayLabel(l.taken_at, { day: "numeric", month: "short", year: "numeric" })}</p>
          </div>
          <p className="mt-0.5"><span className="text-[22px] font-semibold num">{l.value}</span> <span className="text-muted text-[13.5px]">{l.unit}</span>
            {l.flag && <span className="ml-2 rounded-full bg-warn/12 text-warn text-[12px] font-medium px-2 py-0.5">{l.flag === "low" ? "Lower than usual range" : "Higher than usual range"}</span>}
          </p>
        </div>
      </div>
      <RangeBar l={l} />
      {l.about && <p className="text-[14px] text-muted mt-3 leading-relaxed">{l.about}</p>}
    </Card>
  );
}

function ImagingCard({ i }: { i: ImagingReport }) {
  const [open, setOpen] = useState(false);
  const Icon = i.modality === "xray" ? ScanLine : FileText;
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="size-10 rounded-xl bg-hi text-acc grid place-items-center shrink-0"><Icon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[15.5px]">{i.modality_label || i.modality}{i.body_part ? ` · ${i.body_part}` : ""}</p>
          <p className="text-[12.5px] text-faint">{dayLabel(i.study_date, { day: "numeric", month: "long", year: "numeric" })}</p>
        </div>
      </div>
      {i.impression && (
        <div className="mt-3 rounded-xl bg-hi p-3">
          <p className="text-[12px] font-medium text-faint uppercase tracking-wide">Summary from the doctor who read it</p>
          <p className="text-[14.5px] mt-1 leading-relaxed">{i.impression}</p>
        </div>
      )}
      {i.report && (
        <>
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="pt-tap mt-2 h-11 flex items-center gap-1.5 text-[14px] font-medium text-acc">
            {open ? "Hide full report" : "Read full report"}<ChevronDown className={cx("size-4 transition", open && "rotate-180")} />
          </button>
          {open && <p className="text-[14px] text-muted whitespace-pre-line leading-relaxed">{i.report}</p>}
        </>
      )}
      <p className="text-[12.5px] text-faint mt-2">Reports use medical words. Ask your care team to go through it with you.</p>
    </Card>
  );
}
