// Learn: short plain-language self-care cards drawn from SickleGuard's guidance.
import { Activity, AlertTriangle, Ban, Brain, ClipboardList, Droplet, Info, Moon, Pill, Plane, Shield, Sun, Thermometer, Wind, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { useAsync } from "../lib/util";
import { portal, type LearnCard } from "./api";
import { Card, H1, Loading, Oops, SectionTitle } from "./kit";

const ICONS: Record<string, typeof Info> = {
  thermometer: Thermometer, lungs: Wind, brain: Brain, alert: AlertTriangle, droplet: Droplet, sun: Sun, activity: Activity,
  moon: Moon, ban: Ban, shield: Shield, plane: Plane, pill: Pill, clipboard: ClipboardList, zap: Zap, info: Info,
};

export default function Learn() {
  const { data, error, reload } = useAsync(() => portal.learn(), []);
  const urgent = (c: LearnCard) => c.doc_title.toLowerCase().includes("red flag");
  return (
    <div className="fade-in">
      <H1 sub="Simple tips to help you stay well, from the guidance your care team uses.">Learn</H1>
      {error ? <Oops message={error} retry={() => reload()} /> : !data ? <Loading /> : (
        <>
          <SectionTitle>Warning signs: get help fast</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">{data.filter(urgent).map((c) => <LearnTile key={c.title} c={c} urgent />)}</div>
          <SectionTitle>Everyday care</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">{data.filter((c) => !urgent(c)).map((c) => <LearnTile key={c.title} c={c} />)}</div>
          <Card className="mt-6 p-4 text-[14.5px]">
            Have a question about any of this? <Link to="/portal/ask" className="text-acc font-medium">Ask SickleGuard</Link> or talk to your care team.
          </Card>
        </>
      )}
    </div>
  );
}

function LearnTile({ c, urgent }: { c: LearnCard; urgent?: boolean }) {
  const Icon = ICONS[c.icon || "info"] ?? Info;
  return (
    <Card as="article" className={urgent ? "p-4 border-acc/30" : "p-4"}>
      <div className="flex items-center gap-3">
        <span className={urgent ? "size-10 rounded-xl bg-acc/10 text-acc grid place-items-center shrink-0" : "size-10 rounded-xl bg-teal/10 text-teal grid place-items-center shrink-0"}>
          <Icon className="size-5" />
        </span>
        <h3 className="font-semibold text-[16px] leading-snug">{c.title}</h3>
      </div>
      <p className="text-[14.5px] leading-relaxed mt-2.5">{c.summary}</p>
      <p className="text-[12px] text-faint mt-2.5">From: {c.doc_title}</p>
    </Card>
  );
}
