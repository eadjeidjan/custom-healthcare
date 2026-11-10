// My devices: what's connected, battery, last sync; sample (simulated) devices are clearly badged.
import { Battery, BatteryLow, BatteryMedium, Droplets, Thermometer, Watch, Wind } from "lucide-react";
import { cx } from "../components/ui";
import { useAsync } from "../lib/util";
import { portal, type Device } from "./api";
import { Card, H1, Loading, Oops, ago } from "./kit";

const KIND: Record<Device["kind"], { name: string; icon: typeof Watch; what: string }> = {
  wearable: { name: "Wearable", icon: Watch, what: "Heart rate, sleep, steps and skin temperature" },
  pulse_oximeter: { name: "Pulse oximeter", icon: Wind, what: "Oxygen level (SpO2) and pulse" },
  smart_bottle: { name: "Smart bottle", icon: Droplets, what: "How much you drink" },
  thermometer: { name: "Thermometer", icon: Thermometer, what: "Body temperature" },
};

export default function Devices() {
  const { data, error, reload } = useAsync(() => portal.devices(), []);
  return (
    <div className="fade-in">
      <H1 sub="Devices send readings to SickleGuard so you and your care team can spot changes early.">My devices</H1>
      {error ? <Oops message={error} retry={() => reload()} /> : !data ? <Loading rows={2} /> : data.length === 0 ? (
        <Card className="p-6 text-center">
          <Watch className="size-9 mx-auto text-faint" />
          <p className="font-semibold mt-3">No devices yet</p>
          <p className="text-[14.5px] text-muted mt-1">Your care team can link a wearable, pulse oximeter, smart bottle or thermometer for you.</p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {data.map((d) => <DeviceCard key={d.id} d={d} />)}
        </div>
      )}
      <p className="text-[13px] text-faint mt-6">Devices can be wrong. If a reading worries you, or you feel unwell, contact your care team — don't wait for a device.</p>
    </div>
  );
}

function DeviceCard({ d }: { d: Device }) {
  const k = KIND[d.kind] ?? KIND.wearable;
  const stale = !d.last_seen || Date.now() - new Date(d.last_seen).getTime() > 24 * 3600e3;
  const status = d.status === "retired" ? { t: "Not in use", c: "text-faint bg-hi" }
    : d.status === "offline" || stale ? { t: "Not syncing", c: "text-warn bg-warn/10" } : { t: "Connected", c: "text-ok bg-ok/10" };
  const b = d.battery;
  const BIcon = b === null ? Battery : b < 20 ? BatteryLow : b < 60 ? BatteryMedium : Battery;
  return (
    <Card className={cx("p-4", d.status === "retired" && "opacity-60")}>
      <div className="flex items-start gap-3.5">
        <span className="size-12 rounded-2xl bg-hi text-acc grid place-items-center shrink-0"><k.icon className="size-6" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-[16px] truncate">{d.label || k.name}</p>
            {d.simulated && <span className="rounded-full border border-info/30 bg-info/10 text-info text-[11.5px] font-medium px-2 py-0.5">Sample device</span>}
          </div>
          <p className="text-[13px] text-muted">{k.name}{d.vendor && !d.simulated ? ` · ${d.vendor}` : ""}</p>
          <p className="text-[13px] text-muted mt-1">{k.what}</p>
        </div>
        <span className={cx("shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium", status.c)}>{status.t}</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-[13.5px]">
        <div className="rounded-xl bg-hi px-3 py-2.5">
          <p className="text-faint text-[12px]">Battery</p>
          {b === null ? <p className="font-medium">—</p> : (
            <div className="flex items-center gap-2">
              <BIcon className={cx("size-5", b < 20 ? "text-bad" : "text-ok")} />
              <span className="font-semibold num">{b}%</span>
            </div>
          )}
          {b !== null && b < 20 && <p className="text-[12px] text-bad mt-0.5">Please charge soon</p>}
        </div>
        <div className="rounded-xl bg-hi px-3 py-2.5">
          <p className="text-faint text-[12px]">Last sync</p>
          <p className="font-semibold">{ago(d.last_seen)}</p>
          {stale && d.status !== "retired" && <p className="text-[12px] text-warn mt-0.5">Open its app to sync</p>}
        </div>
      </div>
      {d.simulated && <p className="text-[12px] text-faint mt-3">This is a sample device for the demo: its readings are made up.</p>}
    </Card>
  );
}
